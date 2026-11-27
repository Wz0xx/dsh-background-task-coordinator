/**
 * SQLite 存储层 — 基于 Node 24 内置 node:sqlite（DatabaseSync）。
 *
 * 选型依据: DSH 0.2.1-rc.4 宿主 Node v24.21.0, node:sqlite 已稳定;
 * 零原生依赖、零编译, 优于 better-sqlite3。
 *
 * 设计:
 *  - 同步 API（DatabaseSync）, 协调器在单进程内使用, 无高并发竞争;
 *    批量写入用事务包裹。
 *  - 表: tasks / task_events / task_messages / task_context / resource_locks / idempotency
 *  - WAL 模式, 断电安全。
 *  - 幂等键表独立于业务表: insert or ignore, 冲突即说明已处理过。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ManagedTask,
  TaskEvent,
  TaskEventType,
  AppendedMessage,
  TaskContext,
  ResourceLock,
  TaskId,
  TaskStatus,
} from "../types.js";

export class CoordinatorDatabase {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  static inMemory(): CoordinatorDatabase {
    return new CoordinatorDatabase(":memory:");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('subagent','job','composite')),
        native_id TEXT,
        native_session_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'queued','starting','running','waiting_input','cancel_requested',
          'succeeded','failed','cancelled','lost')),
        current_stage TEXT,
        progress_summary TEXT,
        result_summary TEXT,
        error_summary TEXT,
        priority INTEGER NOT NULL DEFAULT 5,
        retry_of TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        children TEXT,          -- JSON TaskId[]
        labels TEXT             -- JSON Record<string,string>
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_native ON tasks(native_id);

      CREATE TABLE IF NOT EXISTS task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL,
        payload TEXT,           -- JSON
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);

      CREATE TABLE IF NOT EXISTS task_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (
          'pending','delivered','undeliverable','cancelled')),
        channel TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_task ON task_messages(task_id, created_at);

      CREATE TABLE IF NOT EXISTS task_context (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        version INTEGER NOT NULL DEFAULT 1,
        objective TEXT NOT NULL,
        current_stage TEXT,
        done TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
        decisions TEXT NOT NULL DEFAULT '[]',
        changed_files TEXT NOT NULL DEFAULT '[]',
        pending_issues TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resource_locks (
        resource_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        owner_session_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_locks_task ON resource_locks(task_id);

      CREATE TABLE IF NOT EXISTS idempotency (
        scope TEXT NOT NULL,    -- 'notice' | 'message' | 'create'
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `);
  }

  // -------------------------------------------------------------------------
  // tasks
  // -------------------------------------------------------------------------

  insertTask(t: ManagedTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, conversation_id, owner_session_id, type, native_id, native_session_id,
           title, objective, status, current_stage, progress_summary,
           result_summary, error_summary, priority, retry_of,
           created_at, updated_at, completed_at, children, labels
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id,
        t.conversationId,
        t.ownerSessionId,
        t.type,
        t.nativeId ?? null,
        t.nativeSessionId ?? null,
        t.title,
        t.objective,
        t.status,
        t.currentStage ?? null,
        t.progressSummary ?? null,
        t.resultSummary ?? null,
        t.errorSummary ?? null,
        t.priority,
        t.retryOf ?? null,
        t.createdAt,
        t.updatedAt,
        t.completedAt ?? null,
        t.children ? JSON.stringify(t.children) : null,
        t.labels ? JSON.stringify(t.labels) : null,
      );
  }

  updateTaskFields(
    id: TaskId,
    fields: Partial<
      Pick<
        ManagedTask,
        | "status"
        | "nativeId"
        | "nativeSessionId"
        | "currentStage"
        | "progressSummary"
        | "resultSummary"
        | "errorSummary"
        | "completedAt"
        | "updatedAt"
      >
    >,
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const map: Record<string, [string, unknown]> = {
      status: ["status", fields.status],
      nativeId: ["native_id", fields.nativeId],
      nativeSessionId: ["native_session_id", fields.nativeSessionId],
      currentStage: ["current_stage", fields.currentStage],
      progressSummary: ["progress_summary", fields.progressSummary],
      resultSummary: ["result_summary", fields.resultSummary],
      errorSummary: ["error_summary", fields.errorSummary],
      completedAt: ["completed_at", fields.completedAt],
      updatedAt: ["updated_at", fields.updatedAt],
    };
    for (const [k, v] of Object.entries(map)) {
      if (v[1] !== undefined) {
        sets.push(`${v[0]} = ?`);
        vals.push(v[1] === null ? null : (v[1] as string | number));
      }
    }
    if (!sets.length) return;
    vals.push(id);
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  getTask(id: TaskId): ManagedTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(filter: {
    conversationId?: string;
    ownerSessionId?: string;
    statuses?: TaskStatus[];
    type?: string;
    limit?: number;
  }): ManagedTask[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.conversationId) {
      where.push("conversation_id = ?");
      vals.push(filter.conversationId);
    }
    if (filter.ownerSessionId) {
      where.push("owner_session_id = ?");
      vals.push(filter.ownerSessionId);
    }
    if (filter.statuses?.length) {
      where.push(
        `status IN (${filter.statuses.map(() => "?").join(",")})`,
      );
      vals.push(...filter.statuses);
    }
    if (filter.type) {
      where.push("type = ?");
      vals.push(filter.type);
    }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY priority ASC, created_at DESC LIMIT ?`;
    vals.push(filter.limit ?? 100);
    const rows = this.db.prepare(sql).all(...vals) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  activeTaskCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','starting','running','waiting_input','cancel_requested')",
      )
      .get() as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // task_events
  // -------------------------------------------------------------------------

  insertEvent(e: TaskEvent): void {
    this.db
      .prepare(
        "INSERT INTO task_events (event_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)",
      )
      .run(e.eventId, e.taskId, e.eventType, e.payload ? JSON.stringify(e.payload) : null, e.createdAt);
  }

  listEvents(taskId: TaskId, limit = 200): TaskEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
      )
      .all(taskId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      eventId: r.event_id as string,
      taskId: r.task_id as string,
      eventType: r.event_type as TaskEventType,
      payload: r.payload ? (JSON.parse(r.payload as string) as Record<string, unknown>) : undefined,
      createdAt: r.created_at as number,
    }));
  }

  // -------------------------------------------------------------------------
  // task_messages
  // -------------------------------------------------------------------------

  insertMessage(m: AppendedMessage): boolean {
    // 幂等键 UNIQUE 冲突 => 已受理过, 返回 false。
    try {
      this.db
        .prepare(
          "INSERT INTO task_messages (message_id, task_id, sender, content, idempotency_key, status, channel, reason, created_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          m.messageId,
          m.taskId,
          m.sender,
          m.content,
          m.idempotencyKey,
          m.status,
          m.channel ?? null,
          m.reason ?? null,
          m.createdAt,
          m.deliveredAt ?? null,
        );
      return true;
    } catch {
      return false;
    }
  }

  updateMessage(
    messageId: string,
    fields: Partial<Pick<AppendedMessage, "status" | "channel" | "reason" | "deliveredAt">>,
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
    if (fields.channel !== undefined) { sets.push("channel = ?"); vals.push(fields.channel); }
    if (fields.reason !== undefined) { sets.push("reason = ?"); vals.push(fields.reason); }
    if (fields.deliveredAt !== undefined) { sets.push("delivered_at = ?"); vals.push(fields.deliveredAt); }
    if (!sets.length) return;
    vals.push(messageId);
    this.db.prepare(`UPDATE task_messages SET ${sets.join(", ")} WHERE message_id = ?`).run(...vals);
  }

  listMessages(taskId: TaskId): AppendedMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      messageId: r.message_id as string,
      taskId: r.task_id as string,
      sender: r.sender as string,
      content: r.content as string,
      idempotencyKey: r.idempotency_key as string,
      status: r.status as AppendedMessage["status"],
      channel: (r.channel as AppendedMessage["channel"]) ?? undefined,
      reason: (r.reason as string) ?? undefined,
      createdAt: r.created_at as number,
      deliveredAt: (r.deliveredAt as number) ?? (r.delivered_at as number) ?? undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // task_context
  // -------------------------------------------------------------------------

  insertContext(c: TaskContext): void {
    this.db
      .prepare(
        "INSERT INTO task_context (task_id, version, objective, current_stage, done, decisions, changed_files, pending_issues, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        c.taskId,
        c.version,
        c.objective,
        c.currentStage ?? null,
        JSON.stringify(c.done),
        JSON.stringify(c.decisions),
        JSON.stringify(c.changedFiles),
        JSON.stringify(c.pendingIssues),
        c.updatedAt,
      );
  }

  getContext(taskId: TaskId): (TaskContext & { version: number }) | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_context WHERE task_id = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id as string,
      version: row.version as number,
      objective: row.objective as string,
      currentStage: (row.current_stage as string) ?? undefined,
      done: JSON.parse(row.done as string) as string[],
      decisions: JSON.parse(row.decisions as string) as string[],
      changedFiles: JSON.parse(row.changed_files as string) as string[],
      pendingIssues: JSON.parse(row.pending_issues as string) as string[],
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * 带版本校验的整存整取更新: version 不符返回 false（并发冲突）。
   * expectedVersion === 0 表示首写（库里还没有该任务的 context 行），
   * 走 INSERT 落 version=1；已有行则 UPDATE 校验 version。
   */
  updateContextOptimistic(
    expectedVersion: number,
    c: TaskContext,
  ): boolean {
    if (expectedVersion === 0) {
      try {
        this.db
          .prepare(
            "INSERT INTO task_context (task_id, version, objective, current_stage, done, decisions, changed_files, pending_issues, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            c.taskId,
            1,
            c.objective,
            c.currentStage ?? null,
            JSON.stringify(c.done),
            JSON.stringify(c.decisions),
            JSON.stringify(c.changedFiles),
            JSON.stringify(c.pendingIssues),
            c.updatedAt,
          );
        return true;
      } catch {
        return false; // 已有并发首写抢先落库：按冲突处理，让调用方重读再写
      }
    }
    const res = this.db
      .prepare(
        `UPDATE task_context SET version=?, objective=?, current_stage=?, done=?, decisions=?,
         changed_files=?, pending_issues=?, updated_at=? WHERE task_id=? AND version=?`,
      )
      .run(
        expectedVersion + 1,
        c.objective,
        c.currentStage ?? null,
        JSON.stringify(c.done),
        JSON.stringify(c.decisions),
        JSON.stringify(c.changedFiles),
        JSON.stringify(c.pendingIssues),
        c.updatedAt,
        c.taskId,
        expectedVersion,
      );
    return Number(res.changes) === 1;
  }

  // -------------------------------------------------------------------------
  // resource_locks
  // -------------------------------------------------------------------------

  tryAcquireLock(lock: ResourceLock): boolean {
    // 过期租约可被接管: DELETE 后再 INSERT, 包在事务里。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM resource_locks WHERE resource_key = ? AND lease_until < ?")
        .run(lock.resourceKey, lock.acquiredAt);
      const res = this.db
        .prepare(
          "INSERT OR IGNORE INTO resource_locks (resource_key, task_id, owner_session_id, acquired_at, lease_until) VALUES (?,?,?,?,?)",
        )
        .run(lock.resourceKey, lock.taskId, lock.ownerSessionId, lock.acquiredAt, lock.leaseUntil);
      this.db.exec("COMMIT");
      return Number(res.changes) === 1;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  releaseLocksForTask(taskId: TaskId): number {
    const res = this.db
      .prepare("DELETE FROM resource_locks WHERE task_id = ?")
      .run(taskId);
    return Number(res.changes);
  }

  renewLock(resourceKey: string, taskId: TaskId, leaseUntil: number): boolean {
    const res = this.db
      .prepare(
        "UPDATE resource_locks SET lease_until = ? WHERE resource_key = ? AND task_id = ?",
      )
      .run(leaseUntil, resourceKey, taskId);
    return Number(res.changes) === 1;
  }

  listLocks(): ResourceLock[] {
    const rows = this.db.prepare("SELECT * FROM resource_locks").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      resourceKey: r.resource_key as string,
      taskId: r.task_id as string,
      ownerSessionId: r.owner_session_id as string,
      acquiredAt: r.acquired_at as number,
      leaseUntil: r.lease_until as number,
    }));
  }

  // -------------------------------------------------------------------------
  // 幂等
  // -------------------------------------------------------------------------

  /** 幂等登记: 首次登记返回 true, 重复登记返回 false。 */
  claimIdempotency(scope: string, key: string, now: number): boolean {
    try {
      this.db
        .prepare("INSERT INTO idempotency (scope, key, created_at) VALUES (?,?,?)")
        .run(scope, key, now);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 维护
  // -------------------------------------------------------------------------

  purgeHistoryOlderThan(cutoff: number): { tasks: number; events: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.db
        .prepare(
          "SELECT id FROM tasks WHERE status IN ('succeeded','failed','cancelled','lost') AND completed_at IS NOT NULL AND completed_at < ?",
        )
        .all(cutoff) as { id: string }[];
      let tasks = 0;
      let events = 0;
      for (const { id } of expired) {
        events += Number(this.db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id).changes);
        this.db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(id);
        this.db.prepare("DELETE FROM task_context WHERE task_id = ?").run(id);
        this.db.prepare("DELETE FROM resource_locks WHERE task_id = ?").run(id);
        tasks += Number(this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes);
      }
      this.db.exec("COMMIT");
      return { tasks, events };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

function rowToTask(r: Record<string, unknown>): ManagedTask {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    ownerSessionId: r.owner_session_id as string,
    type: r.type as ManagedTask["type"],
    nativeId: (r.native_id as string) ?? undefined,
    nativeSessionId: (r.native_session_id as string) ?? undefined,
    title: r.title as string,
    objective: r.objective as string,
    status: r.status as TaskStatus,
    currentStage: (r.current_stage as string) ?? undefined,
    progressSummary: (r.progress_summary as string) ?? undefined,
    resultSummary: (r.result_summary as string) ?? undefined,
    errorSummary: (r.error_summary as string) ?? undefined,
    priority: r.priority as number,
    retryOf: (r.retry_of as string) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    completedAt: (r.completed_at as number) ?? undefined,
    children: r.children ? (JSON.parse(r.children as string) as TaskId[]) : undefined,
    labels: r.labels ? (JSON.parse(r.labels as string) as Record<string, string>) : undefined,
  };
}
