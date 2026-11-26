/**
 * TaskCoordinator — 装配根：把存储、分派、通知、上下文、资源五块拼成整体，
 * 并持有与 DSH 原生事件面的全部订阅。
 *
 * 生命周期：
 *  start()   打开 DB、重建句柄表（重启对账）、挂结算订阅、启动维护定时器
 *  stop()    摘订阅、停定时器、关 DB（不杀运行中的原生执行单元——
 *            它们由 DSH 原生机制管理，重启后经 reconcile 对账）
 */
import {
  CoordinatorConfig,
  CreateTaskRequest,
  TaskId,
  DeliveryStatus,
  ManagedTask,
  DeliverRequest,
} from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { CoordinatorDatabase } from "../storage/database.js";
import { TaskStore } from "../storage/task-store.js";
import { EventStore } from "../storage/event-store.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { TaskManager } from "./task-manager.js";
import { TaskNotifier } from "../communication/task-notifier.js";
import { TaskContextManager } from "../context/task-context-manager.js";
import { ResourceGuard } from "../resources/resource-guard.js";
import { DshRuntime, NativeAgentRef } from "../adapters/dsh-runtime.js";
import { resolve as resolvePath } from "node:path";

export interface CoordinatorDeps {
  runtime: DshRuntime;
  config?: Partial<CoordinatorConfig>;
  /** SQLite 路径; 缺省 ~/.dsh/background-task-coordinator/tasks.db。 */
  dbPath?: string;
  homeDir?: string;
}

export class TaskCoordinator {
  readonly db: CoordinatorDatabase;
  readonly store: TaskStore;
  readonly events: EventStore;
  readonly dispatcher: TaskDispatcher;
  readonly manager: TaskManager;
  readonly notifier: TaskNotifier;
  readonly guard: ResourceGuard;
  readonly context: TaskContextManager;
  readonly config: CoordinatorConfig;

  private readonly disposers: Array<() => void> = [];
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(deps: CoordinatorDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    const dbPath =
      deps.dbPath ??
      deps.config?.dbPath ??
      resolvePath(deps.homeDir ?? ".", "background-task-coordinator", "tasks.db");
    this.db = new CoordinatorDatabase(dbPath);
    this.store = new TaskStore(this.db);
    this.events = new EventStore(this.db);
    this.guard = new ResourceGuard(this.db);
    this.context = new TaskContextManager(this.db);
    this.notifier = new TaskNotifier(this.db, deps.runtime.sessions, this.config);
    this.dispatcher = new TaskDispatcher(
      this.store,
      this.db,
      deps.runtime,
      this.config,
    );
    this.manager = new TaskManager({
      store: this.store,
      events: this.events,
      db: this.db,
      dispatcher: this.dispatcher,
      notifier: this.notifier,
      guard: this.guard,
      context: this.context,
      config: this.config,
    });
    this.runtime = deps.runtime;
  }

  private readonly runtime: DshRuntime;

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 对账完成 promise: start() 同步部分立即返回, 异步对账经此等待（测试/宿主启动序列用）。 */
  private readyPromise: Promise<void> = Promise.resolve();

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // 1) 重启对账：清掉不活动任务的锁。
    this.guard.reconcile((taskId) => {
      const t = this.store.get(taskId);
      return t ? isActiveStatus(t.status) : false;
    });

    // 2) Job 结算订阅（dsh-tool-jobs {owners:'scope'} 机制的收口）。
    //    owner 相对订阅：为每个有活动 job 任务的 owner 挂一个，
    //    新 owner 首次启动 job 时再挂（见 create）。
    const owners = new Set(
      this.store.list({ activeOnly: true }).map((t) => t.ownerSessionId),
    );
    for (const owner of owners) this.subscribeOwner(owner);

    // 3) 异步对账（poll 原生执行单元）——经 ready 暴露。
    this.readyPromise = this.reconcileAfterRestart();
    // 4) 维护定时器：补跑队列 + 租约检查 + 历史清理（5 分钟一拍）。
    this.maintenanceTimer = setInterval(() => {
      try {
        void this.dispatcher.pump();
        this.purgeExpiredHistory();
      } catch {
        // 维护循环不允许抛——日志由宿主统一收集。
      }
    }, 5 * 60 * 1000);
    this.maintenanceTimer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    for (const d of this.disposers.splice(0)) d();
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // 对外操作（全部转 TaskManager）
  // -------------------------------------------------------------------------

  async create(req: CreateTaskRequest, idempotencyKey?: string) {
    const res = await this.manager.createTask(req, idempotencyKey);
    // 新 owner 的首个任务: 补挂结算订阅（start() 只覆盖库中已有 owner）。
    if (req.type === "job") this.subscribeOwner(req.ownerSessionId);
    return res;
  }

  /** 单任务投影。 */
  get(taskId: TaskId): ManagedTask | undefined {
    return this.manager.get(taskId);
  }

  /** 任务时间线。 */
  timeline(taskId: TaskId): string[] {
    return this.manager.timeline(taskId);
  }

  async createComposite(req: CreateTaskRequest, children: CreateTaskRequest[], key?: string) {
    return this.manager.createComposite(req, children, key);
  }

  /** 前台回报：subagent 已由模型用原生工具创建（Mode B 登记）。 */
  registerDelegation(taskId: TaskId, ref: NativeAgentRef): void {
    this.manager.registerDelegation(taskId, ref.agentId, ref.sessionId);
    this.subscribeOwner(this.store.get(taskId)?.ownerSessionId ?? "");
    void this.manager.flushPendingMessages(taskId);
  }

  async appendMessage(
    taskId: TaskId,
    sender: string,
    content: string,
    mode: DeliverRequest["mode"] = "next-turn",
    key?: string,
  ): Promise<{ status: DeliveryStatus; reason?: string }> {
    return this.manager.appendMessage(taskId, sender, content, mode, key);
  }

  async cancel(taskId: TaskId, reason: string) {
    return this.manager.cancel(taskId, reason);
  }

  describe(taskId: TaskId) {
    return this.manager.describe(taskId);
  }

  list(filter: Parameters<TaskStore["list"]>[0]): ManagedTask[] {
    return this.manager.list(filter);
  }

  reportProgress(taskId: TaskId, stage: string, summary: string) {
    this.manager.reportProgress(taskId, stage, summary);
  }

  // -------------------------------------------------------------------------
  // 订阅与对账（与 DSH 原生事件面的全部接触点收在这里）
  // -------------------------------------------------------------------------

  private subscribedOwners = new Set<string>();

  private subscribeOwner(ownerSessionId: string): void {
    if (!ownerSessionId || this.subscribedOwners.has(ownerSessionId)) return;
    this.subscribedOwners.add(ownerSessionId);
    const off = this.runtime.jobs.onSettled(
      ownerSessionId,
      (jobId, state, detail) => {
        void this.onJobSettled(ownerSessionId, jobId, state, detail);
      },
    );
    this.disposers.push(off);
  }

  private async onJobSettled(
    ownerSessionId: string,
    jobId: string,
    state: string,
    detail: string,
  ): Promise<void> {
    // jobId -> 任务（native_id 索引）。
    const task = this.store
      .list({ ownerSessionId, activeOnly: true })
      .find((t) => t.nativeId === jobId);
    if (!task) return;
    if (state === "done") {
      await this.manager.settle(task.id, "succeeded", detail || "作业正常结束");
    } else if (state === "failed") {
      await this.manager.settle(task.id, "failed", detail || "作业失败");
    } else if (state === "cancelled") {
      await this.manager.settle(task.id, "cancelled", detail || "作业被取消");
    }
  }

  /** 重启后：把活动态任务里「原生已不存在」的标为 lost（不虚报 running）。 */
  private async reconcileAfterRestart(): Promise<void> {
    const actives = this.store.list({ activeOnly: true });
    for (const t of actives) {
      if (!t.nativeId) continue; // 未绑定的 queued：dispatch 流程会处理
      const h = this.dispatcher.handleOf(t.id);
      if (!h) {
        // 句柄表是进程内的——重启后必空；凭 nativeId 重建（job 直查 / subagent 登记）。
        this.rebuildHandle(t);
        const rebuilt = this.dispatcher.handleOf(t.id);
        if (rebuilt) {
          const native = await rebuilt.pollNativeStatus();
          if (native === "gone") {
            this.store.transition(t.id, "lost", {
              payload: { reason: "重启对账: 原生执行单元不存在" },
            });
          }
        }
        continue;
      }
      const native = await h.pollNativeStatus();
      if (native === "gone") {
        this.store.transition(t.id, "lost", {
          payload: { reason: "重启对账: 原生执行单元不存在" },
        });
      }
    }
  }

  private rebuildHandle(t: ManagedTask): void {
    if (t.type === "job" && t.nativeId) {
      const h = this.dispatcher.jobAdapter.handle(t.nativeId);
      // handles 是私有的——经 registerDelegation 之外的路需要 setter；
      // 简化：Dispatcher 暴露 reattach（见 task-dispatcher.ts）。
      this.dispatcher.reattach(t.id, h);
    } else if (t.type === "subagent" && t.nativeId && t.nativeSessionId) {
      const h = this.dispatcher.subagentAdapter.handleFor({
        agentId: t.nativeId,
        sessionId: t.nativeSessionId,
      });
      this.dispatcher.reattach(t.id, h);
    }
  }

  private purgeExpiredHistory(): void {
    const cutoff = Date.now() - this.config.historyRetentionDays * 24 * 3600 * 1000;
    this.db.purgeHistoryOlderThan(cutoff);
  }
}

function isActiveStatus(s: string): boolean {
  return (
    s === "queued" ||
    s === "starting" ||
    s === "running" ||
    s === "waiting_input" ||
    s === "cancel_requested"
  );
}
