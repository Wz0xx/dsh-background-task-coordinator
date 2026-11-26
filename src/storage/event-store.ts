/**
 * EventStore — task_events 的只读门面（写入由 TaskStore 内部完成）。
 * 提供按任务/按类型的查询与时间线投影。
 */
import { TaskId, TaskEvent, TaskEventType } from "../types.js";
import { CoordinatorDatabase } from "./database.js";

export class EventStore {
  constructor(private readonly db: CoordinatorDatabase) {}

  byTask(taskId: TaskId, limit?: number): TaskEvent[] {
    return this.db.listEvents(taskId, limit);
  }

  byType(taskId: TaskId, type: TaskEventType): TaskEvent[] {
    return this.db.listEvents(taskId, 1000).filter((e) => e.eventType === type);
  }

  /** 人可读时间线（前台查询用）: 仅取关键事件, 截断 payload。 */
  timeline(taskId: TaskId, limit = 20): string[] {
    return this.db
      .listEvents(taskId, 1000)
      .filter((e) =>
        [
          "task-created",
          "task-claimed",
          "task-started",
          "task-progress",
          "task-completed",
          "task-failed",
          "task-cancelled",
          "message-delivered",
          "message-undeliverable",
          "notice-sent",
        ].includes(e.eventType),
      )
      .slice(-limit)
      .map((e) => {
        const t = new Date(e.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
        const extra = e.payload
          ? " " + JSON.stringify(e.payload).slice(0, 120)
          : "";
        return `[${t}] ${e.eventType}${extra}`;
      });
  }
}
