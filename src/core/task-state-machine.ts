/**
 * 统一任务状态机（V1.1 任务书表 3 对齐）。
 *
 * 合法跳转表:
 *   queued          -> starting | failed | cancelled        （创建执行器前/失败）
 *   starting        -> running | failed | cancel_requested  （执行器创建中）
 *   running         -> waiting_input | cancel_requested | succeeded | failed | lost
 *   waiting_input   -> running | failed | cancelled | lost
 *   cancel_requested-> cancelled | succeeded | failed | lost （等执行器确认; 也可能任务自己跑完了）
 *   succeeded       (终态)
 *   failed          (终态; 重试须创建新尝试并用 retryOf 链接)
 *   cancelled       (终态)
 *   lost            (终态; 重启对账后如原生仍在可重新登记新任务, 不直接复活本条)
 *
 * 设计依据: DSH 原生状态是真源; lost 只在重启对账、
 * 原生执行单元丢失(gone)或无法查询时出现, 避免误报。
 * cancel_requested 与 cancelled 分离（A07）: 请求取消 ≠ 取消已确认。
 */
import { TaskStatus, isTerminal } from "../types.js";

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["starting", "failed", "cancelled"],
  starting: ["running", "failed", "cancel_requested"],
  running: [
    "waiting_input",
    "cancel_requested",
    "succeeded",
    "failed",
    "lost",
  ],
  waiting_input: ["running", "failed", "cancelled", "lost"],
  cancel_requested: ["cancelled", "succeeded", "failed", "lost"],
  succeeded: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`illegal task status transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** 是否允许从 from 跳到 to。同状态为幂等 noop, 允许。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** 断言跳转合法, 非法即抛 IllegalTransitionError。 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** 原生执行单元状态 -> 统一状态的映射。 */
export type NativeExecutorState =
  | "running"
  | "idle"
  | "waiting"
  | "gone"
  | "settled-success"
  | "settled-failure"
  | "settled-cancelled";

export function mapNativeToStatus(native: NativeExecutorState): TaskStatus | null {
  switch (native) {
    case "running":
      return "running";
    case "waiting":
      return "waiting_input";
    case "idle":
      // idle 的 subagent 不代表任务结束——它可能在等下一条指令;
      // 调用方应结合自身语义决定（通常保持现状, 不改写）。
      return null;
    case "gone":
      // 原生执行单元不存在: 只能由重启对账路径调用, 标记 lost。
      return "lost";
    case "settled-success":
      return "succeeded";
    case "settled-failure":
      return "failed";
    case "settled-cancelled":
      return "cancelled";
    default:
      return "lost";
  }
}

/** 原生结算事件是否携带终态。 */
export function isSettled(native: NativeExecutorState): boolean {
  return (
    native === "settled-success" ||
    native === "settled-failure" ||
    native === "settled-cancelled"
  );
}

/** 校验一组事件序列是否全程合法（测试与重启回放用）。 */
export function validateSequence(seq: readonly TaskStatus[]): TaskStatus | null {
  let cur: TaskStatus = "queued";
  for (const next of seq) {
    if (!canTransition(cur, next)) return next;
    cur = next;
  }
  return null;
}

/** 终态保护: 任何向终态之外的状态更新都拒绝。 */
export function guardTerminal(from: TaskStatus, to: TaskStatus): void {
  if (isTerminal(from) && from !== to) {
    throw new IllegalTransitionError(from, to);
  }
}
