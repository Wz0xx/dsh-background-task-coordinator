export class EventStore {
    db;
    constructor(db) {
        this.db = db;
    }
    byTask(taskId, limit) {
        return this.db.listEvents(taskId, limit);
    }
    byType(taskId, type) {
        return this.db.listEvents(taskId, 1000).filter((e) => e.eventType === type);
    }
    /** 人可读时间线（前台查询用）: 仅取关键事件, 截断 payload。 */
    timeline(taskId, limit = 20) {
        return this.db
            .listEvents(taskId, 1000)
            .filter((e) => [
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
        ].includes(e.eventType))
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
//# sourceMappingURL=event-store.js.map