import { assertTransition, guardTerminal, IllegalTransitionError, } from "../core/task-state-machine.js";
let seqCounter = 0;
function genId(prefix) {
    const t = Date.now().toString(36);
    const n = (seqCounter = (seqCounter + 1) % 0xffff).toString(36).padStart(3, "0");
    const r = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${t}${n}${r}`;
}
export class TaskStore {
    db;
    hooks;
    constructor(db, hooks = {}) {
        this.db = db;
        this.hooks = hooks;
    }
    /** 创建任务记录（queued）; 幂等键防重复创建。 */
    create(req, idempotencyKey) {
        const now = Date.now();
        const key = idempotencyKey ?? `create:${req.ownerSessionId}:${req.title}:${req.objective.slice(0, 64)}`;
        if (!this.db.claimIdempotency("create", key, now)) {
            // 找回已存在的任务
            const existing = this.db.listTasks({ ownerSessionId: req.ownerSessionId, limit: 200 })
                .find((t) => t.title === req.title && t.objective === req.objective);
            if (existing)
                return { task: existing, duplicate: true };
            // 键占用但找不到记录（异常清理后）: 继续创建
        }
        const task = {
            id: genId("task"),
            conversationId: req.conversationId,
            ownerSessionId: req.ownerSessionId,
            type: req.type,
            title: req.title,
            objective: req.objective,
            status: "queued",
            priority: req.priority ?? 5,
            createdAt: now,
            updatedAt: now,
            children: req.children?.map(() => ""), // 占位, 由 coordinator 填充
            labels: req.labels,
        };
        // children 先不落（复合任务由 coordinator 二次创建后填）。
        delete task.children;
        this.db.insertTask(task);
        this.emit(task.id, "task-created", {
            title: task.title,
            type: task.type,
            conversationId: task.conversationId,
        });
        return { task, duplicate: false };
    }
    get(id) {
        return this.db.getTask(id);
    }
    list(q = {}) {
        const statuses = q.activeOnly
            ? ["queued", "starting", "running", "waiting_input", "cancel_requested"]
            : q.status
                ? (Array.isArray(q.status) ? q.status : [q.status])
                : undefined;
        return this.db.listTasks({
            conversationId: q.conversationId,
            ownerSessionId: q.ownerSessionId,
            statuses,
            type: q.type,
            limit: q.limit,
        });
    }
    /**
     * 状态变更（唯一入口）: 状态机校验 -> 落库 -> 事件。
     * 终态保护: 终态 -> 非同状态 一律拒绝。
     */
    transition(id, to, opts = {}) {
        const task = this.db.getTask(id);
        if (!task)
            throw new Error(`task not found: ${id}`);
        guardTerminal(task.status, to);
        assertTransition(task.status, to);
        const now = Date.now();
        const patch = {
            status: to,
            updatedAt: now,
        };
        if (opts.resultSummary !== undefined)
            patch.resultSummary = opts.resultSummary;
        if (opts.errorSummary !== undefined)
            patch.errorSummary = opts.errorSummary;
        if (opts.progressSummary !== undefined)
            patch.progressSummary = opts.progressSummary;
        if (opts.currentStage !== undefined)
            patch.currentStage = opts.currentStage;
        if (to === "succeeded" || to === "failed" || to === "cancelled" || to === "lost") {
            patch.completedAt = now;
        }
        this.db.updateTaskFields(id, patch);
        const eventType = opts.eventType ??
            {
                queued: "task-created",
                starting: "task-started",
                running: "task-started",
                waiting_input: "task-waiting",
                cancel_requested: "task-cancel-requested",
                succeeded: "task-completed",
                failed: "task-failed",
                cancelled: "task-cancelled",
                lost: "task-lost",
            }[to];
        this.emit(id, eventType, { from: task.status, to, ...opts.payload });
        return { ...task, ...patch };
    }
    /** 非状态字段的更新（进度摘要、阶段、nativeId 绑定等）。 */
    patch(id, fields, event) {
        const now = Date.now();
        this.db.updateTaskFields(id, { ...fields, updatedAt: now });
        if (event)
            this.emit(id, event.eventType, event.payload);
    }
    /** 绑定原生执行单元。 */
    bindNative(id, nativeId, nativeSessionId) {
        this.patch(id, { nativeId, nativeSessionId }, { eventType: "task-claimed", payload: { nativeId, nativeSessionId } });
    }
    events(id, limit) {
        return this.db.listEvents(id, limit);
    }
    emit(taskId, eventType, payload) {
        const e = {
            eventId: genId("evt"),
            taskId,
            eventType,
            payload,
            createdAt: Date.now(),
        };
        this.db.insertEvent(e);
        this.hooks.onEvent?.(e);
    }
}
export { IllegalTransitionError };
//# sourceMappingURL=task-store.js.map