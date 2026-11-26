/**
 * TaskManager — 任务生命周期门面（任务书 3.3 / 4.x）。
 *
 * 面向 core 的唯一操作入口: 创建、查询、进度、追加指令、取消。
 * 事件订阅（结算/通知）由 TaskCoordinator 装配, 本类只管任务本体。
 */
import {
  CreateTaskRequest,
  ManagedTask,
  TaskId,
  AppendedMessage,
  DeliveryStatus,
  CoordinatorConfig,
  isTerminal,
} from "../types.js";
import { TaskStore } from "../storage/task-store.js";
import { EventStore } from "../storage/event-store.js";
import { CoordinatorDatabase } from "../storage/database.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { TaskNotifier } from "../communication/task-notifier.js";
import { ResourceGuard } from "../resources/resource-guard.js";
import { TaskContextManager } from "../context/task-context-manager.js";

export class TaskManager {
  constructor(
    private readonly deps: {
      store: TaskStore;
      events: EventStore;
      db: CoordinatorDatabase;
      dispatcher: TaskDispatcher;
      notifier: TaskNotifier;
      guard: ResourceGuard;
      context: TaskContextManager;
      config: CoordinatorConfig;
    },
  ) {}

  private get store() { return this.deps.store; }
  private get events() { return this.deps.events; }
  private get db() { return this.deps.db; }
  private get dispatcher() { return this.deps.dispatcher; }
  get notifier() { return this.deps.notifier; }
  private get guard() { return this.deps.guard; }
  private get context() { return this.deps.context; }
  get config() { return this.deps.config; }
  get contextManager() { return this.deps.context; }

  // -------------------------------------------------------------------------
  // 创建
  // -------------------------------------------------------------------------

  /** 创建单任务。幂等; 需要锁的资源创建时即申请。 */
  async createTask(
    req: CreateTaskRequest,
    idempotencyKey?: string,
  ): Promise<{ task: ManagedTask; duplicate: boolean; queued: boolean }> {
    if (!req.runInBackground) {
      // 任务书 4.1: 前台直接执行不是协调器职责; 拒绝以防误用。
      throw new Error("runInBackground=false 的任务不走协调器");
    }
    const { task, duplicate } = this.store.create(req, idempotencyKey);
    if (duplicate) return { task, duplicate, queued: false };

    // 共享上下文初始化
    this.context.init(task.id, task.objective);

    // 资源锁预申请
    for (const key of req.resourceKeys ?? []) {
      const got = this.guard.acquire(key, task.id, task.ownerSessionId);
      if (!got) {
        this.store.transition(task.id, "failed", {
          errorSummary: `资源冲突: ${key} 被其他任务持有（等待租约过期或任务完成）`,
        });
        return { task: this.store.get(task.id)!, duplicate: false, queued: false };
      }
    }

    const queued = await this.dispatcher.dispatch(task);
    return { task: this.store.get(task.id)!, duplicate, queued };
  }

  /** 创建复合任务: 拆子任务, 各自分派, children 落库。 */
  async createComposite(
    req: CreateTaskRequest,
    childReqs: CreateTaskRequest[],
    idempotencyKey?: string,
  ): Promise<{ task: ManagedTask; childIds: TaskId[]; duplicate: boolean }> {
    const { task, duplicate } = this.store.create(
      { ...req, type: "composite" },
      idempotencyKey,
    );
    if (duplicate) {
      return { task, childIds: task.children ?? [], duplicate };
    }
    this.context.init(task.id, task.objective);
    const childIds: TaskId[] = [];
    for (const childReq of childReqs) {
      const r = await this.createTask({
        ...childReq,
        labels: { ...childReq.labels, parent: task.id },
      });
      childIds.push(r.task.id);
    }
    this.db.db
      .prepare("UPDATE tasks SET children = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(childIds), Date.now(), task.id);
    return { task: this.store.get(task.id)!, childIds, duplicate: false };
  }

  // -------------------------------------------------------------------------
  // 委派登记（Mode B: subagent 由前台模型创建）
  // -------------------------------------------------------------------------

  registerDelegation(taskId: TaskId, agentId: string, sessionId: string): void {
    this.dispatcher.registerDelegation(taskId, agentId, sessionId);
    this.store.patch(taskId, { currentStage: "delegated" });
  }

  // -------------------------------------------------------------------------
  // 查询（任务书 4.2: 状态以原生为事实源; 这里返回投影 + 最近进度）
  // -------------------------------------------------------------------------

  get(taskId: TaskId): ManagedTask | undefined {
    return this.store.get(taskId);
  }

  list(filter: Parameters<TaskStore["list"]>[0]): ManagedTask[] {
    return this.store.list(filter);
  }

  /** 自然语言查询的落点: 返回结构化摘要, 由前台模型转述。 */
  describe(taskId: TaskId): string | undefined {
    const t = this.store.get(taskId);
    if (!t) return undefined;
    const lines: string[] = [];
    lines.push(`任务 ${t.id} 「${t.title}」 [${t.status}]`);
    if (t.currentStage) lines.push(`阶段：${t.currentStage}`);
    if (t.progressSummary) lines.push(`进度：${t.progressSummary}`);
    if (t.errorSummary) lines.push(`错误：${t.errorSummary}`);
    if (t.resultSummary) lines.push(`结果：${t.resultSummary}`);
    const ctx = this.context.read(taskId);
    if (ctx) {
      if (ctx.done.length) lines.push(`已完成：${ctx.done.slice(-3).join("；")}`);
      if (ctx.pendingIssues.length) lines.push(`待处理：${ctx.pendingIssues.slice(-3).join("；")}`);
    }
    const timeline = this.events.timeline(taskId, 8);
    if (timeline.length) lines.push("最近动态：", ...timeline.map((l) => `  ${l}`));
    return lines.join("\n");
  }

  timeline(taskId: TaskId): string[] {
    return this.events.timeline(taskId);
  }

  // -------------------------------------------------------------------------
  // 追加指令（任务书 4.3）
  // -------------------------------------------------------------------------

  /**
   * 受理追加指令: 幂等登记 -> 句柄投递 -> 结果回填。
   * Job 无 stdin -> undeliverable, 由前台决定排队后续步骤或转派 subagent。
   */
  async appendMessage(
    taskId: TaskId,
    sender: string,
    content: string,
    mode: "next-turn" | "next-step" = "next-turn",
    idempotencyKey?: string,
  ): Promise<{ status: DeliveryStatus; reason?: string; channel?: AppendedMessage["channel"] }> {
    const task = this.store.get(taskId);
    if (!task) return { status: "undeliverable", reason: "任务不存在" };
    const handle = this.dispatcher.handleOf(taskId);
    const message: AppendedMessage = {
      messageId: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      sender,
      content,
      idempotencyKey:
        idempotencyKey ??
        `msg:${taskId}:${sender}:${hash(content)}`,
      status: "pending",
      createdAt: Date.now(),
    };
    if (!this.db.insertMessage(message)) {
      return { status: "delivered", reason: "幂等键重复: 该指令此前已受理" };
    }
    if (!handle) {
      this.db.updateMessage(message.messageId, {
        status: "undeliverable",
        channel: "none",
        reason: "执行单元未就绪（queued/awaiting-delegation）",
      });
      return { status: "undeliverable", reason: "执行单元未就绪" };
    }
    const outcome = await handle.deliver({ message, mode });
    this.db.updateMessage(message.messageId, {
      status: outcome.status,
      channel: outcome.channel,
      reason: outcome.status === "undeliverable" ? outcome.reason : undefined,
      deliveredAt: outcome.status === "delivered" ? Date.now() : undefined,
    });
    this.store.patch(taskId, {}, {
      eventType: outcome.status === "delivered" ? "message-delivered" : "message-undeliverable",
      payload: { messageId: message.messageId, sender, mode },
    });
    return {
      status: outcome.status,
      reason: outcome.status === "undeliverable" ? outcome.reason : undefined,
      channel: outcome.channel,
    };
  }

  /** 待投递指令随执行单元就绪补投（dispatch 后调用）。 */
  async flushPendingMessages(taskId: TaskId): Promise<void> {
    const handle = this.dispatcher.handleOf(taskId);
    if (!handle) return;
    for (const m of this.db.listMessages(taskId)) {
      if (m.status !== "pending") continue;
      const outcome = await handle.deliver({ message: m, mode: "next-turn" });
      this.db.updateMessage(m.messageId, {
        status: outcome.status,
        channel: outcome.channel,
        reason: outcome.status === "undeliverable" ? outcome.reason : undefined,
        deliveredAt: outcome.status === "delivered" ? Date.now() : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 取消（任务书 4.5: 真实原生取消 + 终态确认）
  // -------------------------------------------------------------------------

  async cancel(taskId: TaskId, reason: string): Promise<{ ok: boolean; detail: string }> {
    const task = this.store.get(taskId);
    if (!task) return { ok: false, detail: "任务不存在" };
    if (isTerminal(task.status)) {
      return { ok: false, detail: `任务已终态(${task.status}), 无需取消` };
    }
    if (task.status === "cancel_requested") {
      return { ok: true, detail: "取消已请求过, 等执行器确认, 勿重复请求" };
    }
    const handle = this.dispatcher.handleOf(taskId);
    if (handle) {
      try {
        await handle.cancel(reason);
      } catch (e) {
        this.store.patch(taskId, {}, {
          eventType: "task-progress",
          payload: { cancelError: String(e) },
        });
        return { ok: false, detail: `原生取消调用失败: ${String(e)}` };
      }
    }
    // 未绑定执行单元（queued）: kill 类调用即终局, 直接标记取消;
    // 绑定了 subagent 的: cancel 请求已发, 等原生确认 —— 两态分离（V1.1 A07）。
    if (!task.nativeId || task.type === "job") {
      this.dispatcher.release(taskId);
      // job 的 kill 调用即终局。注意 handle.cancel() 内部会同步触发原生结算事件，
      // settle 可能已经把状态推到 cancelled —— 先看现状再落，别对着终态硬迁移。
      const cur = this.store.get(taskId)!;
      if (!isTerminal(cur.status)) {
        this.store.transition(taskId, "cancelled", { payload: { reason } });
        await this.notifier.deliverSettlement(
          taskId,
          task.ownerSessionId,
          task.title,
          "cancelled",
          reason,
        );
      }
      return { ok: true, detail: "已取消并通知前台" };
    }
    this.store.transition(taskId, "cancel_requested", { payload: { reason } });
    return { ok: true, detail: "已请求取消（cancel_requested）, 等执行器确认后落终态" };
  }

  // -------------------------------------------------------------------------
  // 进度与结算
  // -------------------------------------------------------------------------

  reportProgress(taskId: TaskId, stage: string, summary: string): void {
    this.store.patch(
      taskId,
      { currentStage: stage, progressSummary: summary },
      { eventType: "task-progress", payload: { stage, summary } },
    );
    this.context.updateStage(taskId, stage);
  }

  /** 结算落账 + 通知（由 coordinator 的订阅触发; 幂等在 notifier 内）。 */
  async settle(
    taskId: TaskId,
    terminal: "succeeded" | "failed" | "cancelled",
    summary: string,
  ): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    this.dispatcher.release(taskId);
    // 结算携带终态事实（running/cancel_requested -> 终态都合法, V1.1 表 3）:
    // cancel_requested 收到确认走 cancelled; 其余经 cancel_requested 过渡, 保证迁移链合法。
    if (task.status !== "cancel_requested" && task.status !== "queued" && task.status !== "starting" && task.status !== "running") {
      return; // 已终态, 结算迟到: 幂等忽略
    }
    if (task.status !== "cancel_requested" && terminal === "cancelled") {
      this.store.transition(taskId, "cancel_requested", { payload: { summary } });
    }
    this.store.transition(taskId, terminal, {
      resultSummary: terminal === "succeeded" ? summary : undefined,
      errorSummary: terminal === "failed" ? summary : undefined,
      payload: { summary },
    });
    await this.notifier.deliverSettlement(
      taskId,
      task.ownerSessionId,
      task.title,
      terminal,
      summary,
    );
  }
}

function hash(s: string): string {
  // 稳定短哈希（FNV-1a 32）: 幂等键用, 非安全用途。
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
