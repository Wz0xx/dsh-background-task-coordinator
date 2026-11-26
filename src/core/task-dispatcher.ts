/**
 * TaskDispatcher — 执行单元选型与并发准入。
 *
 * 选型规则（任务书 4.1 / 表 2）:
 *   subagent  -> SubagentAdapter（复杂 AI 任务; MVP 由前台委派+登记）
 *   job       -> JobAdapter（耗时 shell; 协调器直创, VERIFIED）
 *   composite -> 先拆子任务, 逐个分派; children 关系落库
 *
 * 准入（任务书 6.1）:
 *   maxConcurrentTasks / maxConcurrentSubagents / maxConcurrentJobs
 *   + 宿主内存门控（hostMemoryCeilingMb > 0 时启用）。
 *   超限 -> queued 保留, 由 dispatcher 的 pump 在额度释放后补跑。
 */
import {
  CreateTaskRequest,
  ManagedTask,
  TaskType,
  ExecutorHandle,
  TaskId,
} from "../types.js";
import { CoordinatorConfig } from "../types.js";
import { TaskStore } from "../storage/task-store.js";
import { CoordinatorDatabase } from "../storage/database.js";
import { JobAdapter } from "../adapters/job-adapter.js";
import { SubagentAdapter } from "../adapters/subagent-adapter.js";
import { DshRuntime, NativeJobSpec } from "../adapters/dsh-runtime.js";

function isActiveStatusT(s: string): boolean {
  return (
    s === "queued" ||
    s === "starting" ||
    s === "running" ||
    s === "waiting_input" ||
    s === "cancel_requested"
  );
}

export interface DispatchPlan {
  kind: "launch-job" | "await-delegation" | "composite";
  jobSpec?: NativeJobSpec;
  reason: string;
}

export class TaskDispatcher {
  private readonly jobs: JobAdapter;
  private readonly subagents: SubagentAdapter;
  /** taskId -> 活动句柄。 */
  private readonly handles = new Map<TaskId, ExecutorHandle>();
  /** queued 待补跑队列（按 priority, created_at 排序）。 */
  private readonly pendingQueue: TaskId[] = [];

  constructor(
    private readonly store: TaskStore,
    private readonly db: CoordinatorDatabase,
    private readonly runtime: DshRuntime,
    private readonly config: CoordinatorConfig,
  ) {
    this.jobs = new JobAdapter(runtime.jobs);
    this.subagents = new SubagentAdapter(runtime.agents);
  }

  get jobAdapter(): JobAdapter {
    return this.jobs;
  }

  get subagentAdapter(): SubagentAdapter {
    return this.subagents;
  }

  handleOf(taskId: TaskId): ExecutorHandle | undefined {
    return this.handles.get(taskId);
  }

  /** 重启对账重建句柄（不重复绑定/不过状态机）。 */
  reattach(taskId: TaskId, handle: ExecutorHandle): void {
    this.handles.set(taskId, handle);
  }

  /** 制定分派计划（不执行）。 */
  plan(task: ManagedTask): DispatchPlan {
    switch (task.type) {
      case "job": {
        const spec = parseJobObjective(task.objective);
        if (!spec) {
          return {
            kind: "await-delegation",
            reason: "objective 未包含可执行命令; 等待前台澄清或改派 subagent",
          };
        }
        return { kind: "launch-job", jobSpec: spec, reason: "耗时命令走 Background Job" };
      }
      case "subagent":
        return {
          kind: "await-delegation",
          reason: "AI 长任务: MVP 委派登记模式——前台用 subagent 工具创建后回报 agentId",
        };
      case "composite":
        return { kind: "composite", reason: "复合任务: 先拆子任务" };
    }
  }

  /** 执行分派。返回 true=已启动; false=排队等候。 */
  async dispatch(task: ManagedTask): Promise<boolean> {
    if (!this.admit(task)) {
      this.enqueue(task.id);
      return false;
    }
    const plan = this.plan(task);
    switch (plan.kind) {
      case "launch-job": {
        try {
          const h = await this.jobs.launch(plan.jobSpec!, task.ownerSessionId);
          this.handles.set(task.id, h);
          this.store.bindNative(task.id, h.nativeId);
          // 先落 starting（执行器已创建但结算订阅未挂稳），紧接 running。
          // queued 直达 running 已不合法（V1.1 表 3）。
          this.store.transition(task.id, "starting", {
            payload: { plan: plan.reason },
          });
          this.store.transition(task.id, "running");
          return true;
        } catch (e) {
          // start() 超限等准入失败: 保留 queued, 进补跑队列。
          this.store.patch(task.id, {}, {
            eventType: "task-progress",
            payload: { dispatchError: String(e) },
          });
          this.enqueue(task.id);
          return false;
        }
      }
      case "await-delegation": {
        // subagent MVP: 前台模型负责创建, 协调器等 registerDelegation 回填。
        this.store.patch(task.id, { currentStage: "awaiting-delegation" }, {
          eventType: "task-progress",
          payload: { note: plan.reason },
        });
        return true;
      }
      case "composite": {
        // 复合任务由 coordinator 展开子任务（见 TaskCoordinator.createComposite）。
        return true;
      }
    }
  }

  /** 前台回报委派已创建（Mode B）。 */
  registerDelegation(taskId: TaskId, agentId: string, sessionId: string): ExecutorHandle {
    const ref = { agentId, sessionId };
    const h = this.subagents.registerDelegated(ref);
    this.handles.set(taskId, h);
    this.store.bindNative(taskId, agentId, sessionId);
    // queued 直达 running 已不合法（V1.1 表 3）：经 starting 过渡。
    this.store.transition(taskId, "starting");
    this.store.transition(taskId, "running", {
      payload: { mode: "delegated", agentId },
    });
    return h;
  }

  /** 补跑队列: 额度释放后按优先级出队。 */
  async pump(): Promise<void> {
    while (this.pendingQueue.length) {
      const id = this.pendingQueue[0]!;
      const task = this.store.get(id);
      if (!task || task.status !== "queued") {
        this.pendingQueue.shift();
        continue;
      }
      if (!this.admit(task)) break;
      this.pendingQueue.shift();
      await this.dispatch(task);
    }
  }

  /** 任务终态: 释放句柄与锁, 触发补跑。 */
  release(taskId: TaskId): void {
    const h = this.handles.get(taskId);
    if (h) {
      h.dispose();
      this.handles.delete(taskId);
    }
    this.db.releaseLocksForTask(taskId);
  }

  // -------------------------------------------------------------------------

  private admit(task: ManagedTask): boolean {
    const cfg = this.config;
    if (cfg.hostMemoryCeilingMb > 0) {
      const rss = this.runtime.sessions.hostMemoryMb();
      if (rss > cfg.hostMemoryCeilingMb) return false;
    }
    // 全局任务上限只数「已占用执行单元」的（queued 等待不算占用）。
    const occupied = this.countOccupied();
    if (occupied >= cfg.maxConcurrentTasks) return false;
    if (task.type === "job") {
      const jobs = this.countOccupied("job");
      if (jobs >= cfg.maxConcurrentJobs) return false;
    }
    if (task.type === "subagent") {
      const subs = this.countOccupied("subagent");
      if (subs >= cfg.maxConcurrentSubagents) return false;
    }
    return true;
  }

  /** 占用执行单元的任务数（handles 表即占用事实）。 */
  private countOccupied(type?: TaskType): number {
    let n = 0;
    for (const [taskId, h] of this.handles) {
      if (type && h.kind !== type) continue;
      const t = this.store.get(taskId);
      if (t && isActiveStatusT(t.status)) n++;
    }
    return n;
  }

  private enqueue(taskId: TaskId): void {
    if (!this.pendingQueue.includes(taskId)) this.pendingQueue.push(taskId);
    // 按优先级稳定排序（priority 小者先）。
    this.pendingQueue.sort((a, b) => {
      const ta = this.store.get(a);
      const tb = this.store.get(b);
      const pa = ta?.priority ?? 5;
      const pb = tb?.priority ?? 5;
      if (pa !== pb) return pa - pb;
      return (ta?.createdAt ?? 0) - (tb?.createdAt ?? 0);
    });
  }
}

/**
 * 从 objective 解析 job 命令。
 * 约定格式（前台模型生成 objective 时遵守）:
 *   命令行以第一行给出; 其余行作为描述。
 *   例: "npm run build\n构建 lib 目录"
 */
export function parseJobObjective(objective: string): NativeJobSpec | undefined {
  const first = objective.split("\n", 1)[0]?.trim();
  if (!first || !/^[\w./@~-]+(\s+[\w./@~"'=-]+)*$/.test(first)) return undefined;
  const parts = first.split(/\s+/);
  return {
    name: parts[0]!,
    command: parts[0]!,
    args: parts.slice(1),
  };
}
