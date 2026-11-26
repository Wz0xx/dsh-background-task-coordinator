/**
 * DSH 后台任务协调器 — 核心类型定义。
 *
 * 依据 DSH 0.2.1-rc.4 源码逆向核验：
 *  - ReactLoopAgent: followup/steer/inject/cancel({kind},{keepInbox})/status
 *  - Inbox: next-turn / next-step 双队列, agent/inbox/spliced 持久化
 *  - dsh-jobs-local: ctx.jobs.start()/kill()/list()/readAt(), maxConcurrentJobsPerOwner=10
 *  - 结算通知: {owners:'scope'} 订阅, wakeup/quiet 通道, maxConsecutiveWakes 预算
 *  - 会话投影: running / inbox / todos / title
 *  - jobs-local 记录为进程内存, 随宿主终止
 *
 * 状态真源原则: 统一状态是 DSH 原生 Agent/Job 状态的投影;
 * 数据库 running 永不等于事实, 重启后必须重新核对。
 */

// ---------------------------------------------------------------------------
// 任务身份与类型
// ---------------------------------------------------------------------------

/** 协调器生成的稳定任务 ID（taskId），与 DSH 原生 ID 无关、重启后仍可对账。 */
export type TaskId = string;

/** DSH 原生执行单元 ID: Agent ID 或 Job ID。 */
export type NativeId = string;

export type TaskType = "subagent" | "job" | "composite";

/**
 * 统一任务状态（V1.1 任务书表 3 对齐）。
 * queued/starting/running/waiting_input/cancel_requested 为活动态;
 * succeeded/failed/cancelled/lost 为终态;
 * lost 在重启对账、原生执行单元丢失或无法查询时出现, 不得虚报 running。
 * （V1.0 的 completed→succeeded、interrupted/unknown→lost、waiting→waiting_input）
 */
export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: TaskStatus): boolean {
  return (
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting_input" ||
    status === "cancel_requested"
  );
}

// ---------------------------------------------------------------------------
// 任务记录
// ---------------------------------------------------------------------------

export interface ManagedTask {
  id: TaskId;
  /** 创建任务的会话（QQ 群 / 私聊 / Web 会话的协调层 ID）。 */
  conversationId: string;
  /** 拥有该任务的前台 DSH Session ID。 */
  ownerSessionId: string;
  type: TaskType;
  /** DSH 原生 Agent ID / Job ID; 创建成功前为空。 */
  nativeId?: NativeId;
  /** nativeId 所属的执行会话 ID（subagent 情形可能不同于 ownerSessionId）。 */
  nativeSessionId?: string;
  title: string;
  objective: string;
  status: TaskStatus;
  /** 当前阶段（如 "分析依赖" / "跑构建"），由后台执行单元或协调器更新。 */
  currentStage?: string;
  /** 最近一次有效进度摘要; 无可靠数据时缺省, 不得伪造。 */
  progressSummary?: string;
  resultSummary?: string;
  errorSummary?: string;
  /** 调度优先级: 数字越小越优先, 默认 5。 */
  priority: number;
  /** 失败重试链: 若本任务是重试, 指向上一次尝试的 taskId。 */
  retryOf?: TaskId;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** 复合任务的子任务 ID 列表。 */
  children?: TaskId[];
  /** 创建时的标签（来源入口、发起人等, 用于访问控制与列表过滤）。 */
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export type TaskEventType =
  | "task-created"
  | "task-claimed" // 分配到原生执行单元
  | "task-started"
  | "task-progress" // 阶段/摘要更新
  | "task-waiting"
  | "task-resumed"
  | "task-completed"
  | "task-failed"
  | "task-cancelled"
  | "task-cancel-requested" // 取消已请求（V1.1 A07 两态分离）
  | "task-lost" // 重启对账/原生执行单元丢失（V1.1：原 task-interrupted/task-unknown）
  | "task-notified" // 终态通知已投递（V1.1 6.4）
  | "message-appended" // 追加指令受理
  | "message-delivered" // 指令已投递到执行单元
  | "message-undeliverable" // 指令无法投递（执行单元缺失/已终态/Job 无 stdin）
  | "notice-sent" // 完成通知已投递前台
  | "notice-suppressed" // 通知被去重/预算抑制（幂等与预算的审计痕迹）
  | "lock-acquired"
  | "lock-denied"
  | "lock-released"
  | "native-mismatch"; // 内部投影与原生状态对账发现不一致

export interface TaskEvent {
  eventId: string;
  taskId: TaskId;
  eventType: TaskEventType;
  payload?: Record<string, unknown>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 追加指令
// ---------------------------------------------------------------------------

export type DeliveryStatus =
  | "pending" // 已受理, 待下一可接收时机
  | "delivered" // 已投递到执行单元收件箱/队列
  | "undeliverable" // 无法投递（原因见 reason）
  | "cancelled"; // 任务终态时随任务取消

export interface AppendedMessage {
  messageId: string;
  taskId: TaskId;
  /** 发送者标识（QQ 号 / 会话 ID / "system"）。 */
  sender: string;
  /** 指令文本或其摘要（长文截断存储, 原文可选外置）。 */
  content: string;
  /** 幂等键: 同键重复投递直接短路, 跨重启防重发。 */
  idempotencyKey: string;
  status: DeliveryStatus;
  /** 投递通道: agent-inbox(followup/steer) / job-queue / deferred-to-subagent / none。 */
  channel?: "agent-inbox-next-turn" | "agent-inbox-next-step" | "job-queue" | "none";
  reason?: string;
  createdAt: number;
  deliveredAt?: number;
}

// ---------------------------------------------------------------------------
// 共享任务上下文（摘要, 版本化）
// ---------------------------------------------------------------------------

export interface TaskContext {
  taskId: TaskId;
  /** 乐观并发控制: 每次整体更新 +1, 更新必须携带读到的版本, 冲突即拒绝。 */
  version: number;
  objective: string;
  currentStage?: string;
  done: string[];
  decisions: string[];
  changedFiles: string[];
  pendingIssues: string[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 资源锁
// ---------------------------------------------------------------------------

export interface ResourceLock {
  resourceKey: string;
  taskId: TaskId;
  ownerSessionId: string;
  acquiredAt: number;
  /** 租约期限; 到期未续视为异常退出, 可被接管。 */
  leaseUntil: number;
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

export interface TaskNotice {
  taskId: TaskId;
  ownerSessionId: string;
  /** 通知文本: 标题 + 终态 + 结果/错误摘要。 */
  text: string;
  /** 通知是否要求唤醒前台（结算通知为 true; 普通进度推送为 false）。 */
  wake: boolean;
  /** 幂等键: taskId+终态, 保证同一终态只投一次。 */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// 创建请求与查询
// ---------------------------------------------------------------------------

export interface CreateTaskRequest {
  conversationId: string;
  ownerSessionId: string;
  type: TaskType;
  title: string;
  objective: string;
  priority?: number;
  /** 显式指定后台执行; MVP 阶段一律要求 true 或协调器默认后台。 */
  runInBackground: boolean;
  /** composite 任务的子任务请求。 */
  children?: Omit<CreateTaskRequest, "children">[];
  /** 资源预声明: 创建时即申请写入锁, 避免运行中冲突。 */
  resourceKeys?: string[];
  labels?: Record<string, string>;
}

export interface TaskQuery {
  conversationId?: string;
  ownerSessionId?: string;
  status?: TaskStatus | TaskStatus[];
  type?: TaskType;
  activeOnly?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// 执行单元句柄（Adapter 层面向 core 的统一抽象）
// ---------------------------------------------------------------------------

/** 一次投递请求的完整语义。 */
export interface DeliverRequest {
  message: AppendedMessage;
  /** next-turn: 空闲即开新轮（常规追加）; next-step: 忙时转向（紧急修正）。 */
  mode: "next-turn" | "next-step";
}

export interface ExecutorHandle {
  kind: "subagent" | "job";
  nativeId: NativeId;
  nativeSessionId?: string;
  /** 投递追加指令。返回投递结果; 不支持时返回 undeliverable + 原因。 */
  deliver(req: DeliverRequest): Promise<DeliveryOutcome>;
  /** 查询原生运行状态。 */
  pollNativeStatus(): Promise<"running" | "idle" | "waiting" | "gone">;
  /** 取消执行单元（原生 cancel/kill）。 */
  cancel(reason: string): Promise<void>;
  /** 释放订阅与资源; 任务终态后调用。 */
  dispose(): void;
}

export type DeliveryOutcome =
  | { status: "delivered"; channel: NonNullable<AppendedMessage["channel"]> }
  | { status: "undeliverable"; channel: "none"; reason: string };

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface CoordinatorConfig {
  maxConcurrentTasks: number;
  maxConcurrentSubagents: number;
  maxConcurrentJobs: number;
  /** 通知连续唤醒预算（对齐 DSH maxConsecutiveWakes 语义）。 */
  maxConsecutiveWakes: number;
  /** 资源锁默认租约毫秒数。 */
  lockLeaseMs: number;
  /** 任务历史保留天数; 终态任务过期清理。 */
  historyRetentionDays: number;
  /** SQLite 文件路径; 缺省放在插件数据目录。 */
  dbPath?: string;
  /** 宿主内存监控阈值（宿主进程 RSS MB）; 超过则拒绝新低优先级任务。 */
  hostMemoryCeilingMb: number;
}

export const DEFAULT_CONFIG: CoordinatorConfig = {
  maxConcurrentTasks: 2,
  maxConcurrentSubagents: 2,
  maxConcurrentJobs: 4,
  maxConsecutiveWakes: 3,
  lockLeaseMs: 30 * 60 * 1000,
  historyRetentionDays: 30,
  dbPath: undefined,
  hostMemoryCeilingMb: 0, // 0 = 不启用内存门控
};

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
