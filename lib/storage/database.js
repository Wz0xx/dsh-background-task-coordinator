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
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
export class CoordinatorDatabase {
    db;
    path;
    closed = false;
    /** 本次构造里实际做了什么权限收紧（供自检/日志报告，不猜）。 */
    permissionReport = { platform: process.platform, applied: [], skipped: null };
    /**
     * 收紧库文件权限。
     *
     * Unix：chmod 0600 / 目录 0700 —— 直接、可逆、不影响同用户的其他工具。
     * Windows：没有 POSIX 权限，posix 那套是空操作。**默认不做 icacls**，原因：
     *   `icacls /inheritance:r` 会把 ACL 收窄到「只有当前用户」，
     *   之后其他身份运行的工具（备份脚本、别的账户下的 sqlite 客户端）就读不到了。
     *   这是改系统行为，不该由插件在启动时悄悄做。
     * 想收窄的，在 config 里打开 `tightenWindowsAcl: true`，或者自己跑：
     *   icacls <tasks.db> /inheritance:r /grant:r "%USERNAME%:(F)"
     */
    tightenPermissions(dbPath, options = {}) {
        if (dbPath === ":memory:") {
            this.permissionReport.skipped = 'in-memory';
            return;
        }
        if (process.platform !== "win32") {
            try {
                chmodSync(dirname(dbPath), 0o700);
                this.permissionReport.applied.push('dir:0700');
            } catch { /* 尽力而为 */ }
            for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    chmodSync(p, 0o600);
                    this.permissionReport.applied.push(`${p.endsWith('-wal') ? 'wal' : p.endsWith('-shm') ? 'shm' : 'db'}:0600`);
                } catch { /* 边车文件可能尚未生成 */ }
            }
            return;
        }
        // Windows
        if (options.tightenWindowsAcl === true) {
            const user = process.env.USERNAME;
            if (!user) {
                this.permissionReport.skipped = 'win32: no USERNAME';
                return;
            }
            for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    execFileSync('icacls', [p, '/inheritance:r', '/grant:r', `${user}:(F)`], {
                        stdio: 'ignore',
                        windowsHide: true,
                        timeout: 5000,
                    });
                    this.permissionReport.applied.push(`${p.endsWith('-wal') ? 'wal' : p.endsWith('-shm') ? 'shm' : 'db'}:user-only`);
                } catch { /* 文件可能尚未生成，或 icacls 不可用 */ }
            }
            return;
        }
        this.permissionReport.skipped = 'win32: 默认不收窄 ACL（会影响其他身份运行的工具）；需要就设 tightenWindowsAcl: true';
    }
    constructor(dbPath, options = {}) {
        this.path = dbPath;
        if (dbPath !== ":memory:") {
            mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        }
        this.db = new DatabaseSync(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA foreign_keys = ON;");
        // 0.2.0：多进程（多个 DSH profile / 同 profile 双开）会同时写同一份库，
        // 不设 busy_timeout 时并发写直接抛 SQLITE_BUSY（审计 P2-7）。
        // 5 秒足够让持有写锁的一方提交完，超时才算真失败。
        this.db.exec("PRAGMA busy_timeout = 5000;");
        this.migrate();
        // 权限收紧放在建库之后：边车文件（-wal/-shm）要等 SQLite 打开才生成
        this.tightenPermissions(dbPath, options);
    }
    static inMemory() {
        return new CoordinatorDatabase(":memory:");
    }
    migrate() {
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
      -- 0.2.0：结算事件、探活、按 nativeSessionId 匹配都靠这一列，之前没建索引，
      -- 全表 500 条内存扫（审计 P1-4）。
      CREATE INDEX IF NOT EXISTS idx_tasks_native_session ON tasks(native_session_id);
      -- 0.2.0：活动任务查询与清理都按状态+时间，加个复合索引
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);

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
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'pending','delivered','undeliverable','cancelled')),
        channel TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_task ON task_messages(task_id, created_at);
      -- 0.2.0：幂等键改成 (task_id, idempotency_key) 联合唯一。
      -- 原来 idempotency_key 是**全表** UNIQUE，任务 A 与 B 用同一个显式键时，
      -- B 的消息会真实投出去但写库失败（审计 P1-7）。
      -- 老库由下面的 migrateMessagesUnique() 重建并补这个索引。
      CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_task_key
        ON task_messages(task_id, idempotency_key);

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
        this.migrateMessagesUnique();
    }
    /**
     * 0.2.0 迁移：把 task_messages 的幂等键从「全表 UNIQUE」改成「(task_id, key) 联合唯一」。
     *
     * SQLite 不能 ALTER 掉列级 UNIQUE，只能重建表。判据是 meta 里的 schema 版本，
     * 老库（没有这个键，或版本 < 2）走一次重建；新库直接跳过。
     *
     * 重建期间整表搬过去，不改任何数据 —— 只是松开原本过严的约束，
     * 所以不会丢东西，也不会让已有的重复键冲突（联合唯一比全表唯一宽松）。
     */
    migrateMessagesUnique() {
        const KEY = 'schema.task_messages.unique';
        // 版本 3 = 「联合唯一 + 外键 + CHECK 齐全」。
        // 版本 2 是 0.2.0 那个残缺状态（联合唯一有了，但外键和 CHECK 被丢掉），
        // 所以「版本号够」不能单独作为跳过条件 —— 得同时看表结构是不是真的对。
        const TARGET = 3;
        const getVersion = () => {
            const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY);
            return row ? Number(row.value) : 0;
        };
        const setVersion = (v) => {
            this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .run(KEY, String(v));
        };
        // 现有表的实际形态（0.2.1 修，审计 #3）：
        //   hasColumnUnique —— 老的「全表 UNIQUE」还在不在（在就要重建）
        //   hasFk           —— 有没有 REFERENCES tasks(id)
        //   hasCheck        —— 有没有 status CHECK
        const inspect = () => {
            const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_messages'").get();
            const sql = String(row?.sql ?? '');
            if (!sql) return { exists: false, hasColumnUnique: false, hasFk: false, hasCheck: false };
            return {
                exists: true,
                hasColumnUnique: /idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql),
                hasFk: /REFERENCES\s+tasks\s*\(/i.test(sql),
                hasCheck: /CHECK\s*\(\s*status\s+IN/i.test(sql),
            };
        };
        const st = inspect();
        // 表结构已经完全正确（联合唯一 + 外键 + CHECK 都在，且没有列级 UNIQUE）→ 跳过。
        // 这条判据比版本号硬：即使 meta 被清空或写了错值，只要表对就不做无谓重建。
        if (st.exists && !st.hasColumnUnique && st.hasFk && st.hasCheck) {
            if (getVersion() !== TARGET) setVersion(TARGET);
            return;
        }
        if (!st.exists && getVersion() >= TARGET) return;
        // 表还没建（meta 里也没版本）时不必重建 —— migrate() 的 CREATE 已经建好了正确的表。
        if (!st.exists) { setVersion(TARGET); return; }

        this.db.exec('BEGIN IMMEDIATE');
        try {
            // 复制到新表。
            //
            // 新表必须**原样保留外键和 CHECK 约束**，只松开 idempotency_key 那一列的 UNIQUE。
            // 0.2.0 建这张表时把 REFERENCES 和 status CHECK 一起丢了（0.2.1 修，审计 #3）：
            //   · 外键没了 → 能插入指向不存在任务的孤儿消息，purge 也带不走；
            //   · CHECK 没了 → status 能写任意字符串，而 ACTIVE/TERMINAL 判定全靠约定，
            //     一个手误的 'runing' 会让任务永远既不算活动也不算终态。
            // 那种表比迁移前更松，是一次静默的数据完整性退化。
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_messages_v2 (
          message_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          sender TEXT NOT NULL,
          content TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'pending','delivered','undeliverable','cancelled')),
          channel TEXT,
          reason TEXT,
          created_at INTEGER NOT NULL,
          delivered_at INTEGER
        );
      `);
            this.db.exec(`
        INSERT OR IGNORE INTO task_messages_v2
          (message_id, task_id, sender, content, idempotency_key, status, channel, reason, created_at, delivered_at)
        SELECT message_id, task_id, sender, content, idempotency_key, status, channel, reason, created_at, delivered_at
        FROM task_messages;
      `);
            this.db.exec('DROP TABLE task_messages;');
            this.db.exec('ALTER TABLE task_messages_v2 RENAME TO task_messages;');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_task ON task_messages(task_id, created_at);');
            this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_task_key ON task_messages(task_id, idempotency_key);');
            // 迁移完再核一次：结构不对就别写「完成」的版本号，让下次启动重试。
            const after = inspect();
            if (after.hasColumnUnique || !after.hasFk || !after.hasCheck) {
                throw new Error(`迁移后结构仍不完整（unique=${after.hasColumnUnique} fk=${after.hasFk} check=${after.hasCheck}）`);
            }
            setVersion(TARGET);
            this.db.exec('COMMIT');
        } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败也没别的办法 */ }
            // 迁移失败不阻塞启动：旧表还在，功能照常，只是幂等键仍是旧约束。
            throw e;
        }
    }
    // -------------------------------------------------------------------------
    // tasks
    // -------------------------------------------------------------------------
    insertTask(t) {
        this.db
            .prepare(`INSERT INTO tasks (
           id, conversation_id, owner_session_id, type, native_id, native_session_id,
           title, objective, status, current_stage, progress_summary,
           result_summary, error_summary, priority, retry_of,
           created_at, updated_at, completed_at, children, labels
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(t.id, t.conversationId, t.ownerSessionId, t.type, t.nativeId ?? null, t.nativeSessionId ?? null, t.title, t.objective, t.status, t.currentStage ?? null, t.progressSummary ?? null, t.resultSummary ?? null, t.errorSummary ?? null, t.priority, t.retryOf ?? null, t.createdAt, t.updatedAt, t.completedAt ?? null, t.children ? JSON.stringify(t.children) : null, t.labels ? JSON.stringify(t.labels) : null);
    }
    updateTaskFields(id, fields) {
        const sets = [];
        const vals = [];
        const map = {
            status: ["status", fields.status],
            nativeId: ["native_id", fields.nativeId],
            nativeSessionId: ["native_session_id", fields.nativeSessionId],
            currentStage: ["current_stage", fields.currentStage],
            progressSummary: ["progress_summary", fields.progressSummary],
            resultSummary: ["result_summary", fields.resultSummary],
            errorSummary: ["error_summary", fields.errorSummary],
            completedAt: ["completed_at", fields.completedAt],
            updatedAt: ["updated_at", fields.updatedAt],
            // labels 是 JSON 列：对象必须先序列化，否则会绑进 "[object Object]"
            labels: ["labels", fields.labels === undefined ? undefined : JSON.stringify(fields.labels)],
        };
        for (const [k, v] of Object.entries(map)) {
            if (v[1] !== undefined) {
                sets.push(`${v[0]} = ?`);
                vals.push(v[1] === null ? null : v[1]);
            }
        }
        if (!sets.length)
            return;
        vals.push(id);
        this.db
            .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
            .run(...vals);
    }
    getTask(id) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
        return row ? rowToTask(row) : undefined;
    }
    /**
     * 按执行器 id 找活动任务（0.2.0）。
     *
     * 以前是 listTasks({limit:500}) 拉全表再内存 .find()，两个问题：
     *   1. 任务数超过 500，活动任务掉出窗口 → 结算事件永远匹配不上（审计 P1-4）；
     *   2. 命中旧终态记录后提前 return，漏掉真正活跃的那条。
     * 这里直接在 SQL 里按两个 id 列 + 活动态过滤，走 idx_tasks_native_session。
     *
     * @param {string} nativeId 执行器 id（job 的 jobId / subagent 的会话 id）
     * @param {string[]} activeStatuses 视为「活动」的状态集合
     * @param {string} [type] 只找这个类型（可选）
     */
    findActiveByNative(nativeId, activeStatuses, type) {
        const sid = String(nativeId ?? '');
        if (!sid || !activeStatuses?.length) return undefined;
        const ph = activeStatuses.map(() => '?').join(',');
        const sql = `SELECT * FROM tasks
                     WHERE (native_id = ? OR native_session_id = ?)
                       AND status IN (${ph})
                       ${type ? 'AND type = ?' : ''}
                     ORDER BY created_at DESC LIMIT 1`;
        const params = [sid, sid, ...activeStatuses];
        if (type) params.push(type);
        const row = this.db.prepare(sql).get(...params);
        return row ? rowToTask(row) : undefined;
    }
    /** 活动任务（走 idx_tasks_status，不再拉全表）。 */
    listActive(activeStatuses) {
        if (!activeStatuses?.length) return [];
        const ph = activeStatuses.map(() => '?').join(',');
        const rows = this.db
            .prepare(`SELECT * FROM tasks WHERE status IN (${ph}) ORDER BY created_at DESC`)
            .all(...activeStatuses);
        return rows.map(rowToTask);
    }
    /**
     * 最近 N 条（不管状态），按创建时间倒序。
     *
     * 0.2.0 之前 `task_list {all:true}` 是 `listTasks({limit:500})` + 内存排序，
     * 而 listTasks 的 ORDER BY 是 `priority ASC, created_at DESC` ——
     * 优先级数字小的历史任务会一直排在前面，把最近的挤出去。
     * 这里直接按时间倒序取窗口，语义就是「最近」。
     */
    listRecent(limit, ownerSessionId) {
        const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
        const rows = ownerSessionId
            ? this.db.prepare("SELECT * FROM tasks WHERE owner_session_id = ? ORDER BY created_at DESC LIMIT ?").all(String(ownerSessionId), n)
            : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(n);
        return rows.map(rowToTask);
    }
    /** 清理过期历史（0.2.0 起由维护循环调用，见 index.js 的 sweepTimer）。 */
    listTasks(filter) {
        const where = [];
        const vals = [];
        if (filter.conversationId) {
            where.push("conversation_id = ?");
            vals.push(filter.conversationId);
        }
        if (filter.ownerSessionId) {
            where.push("owner_session_id = ?");
            vals.push(filter.ownerSessionId);
        }
        if (filter.statuses?.length) {
            where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
            vals.push(...filter.statuses);
        }
        if (filter.type) {
            where.push("type = ?");
            vals.push(filter.type);
        }
        const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY priority ASC, created_at DESC LIMIT ?`;
        vals.push(filter.limit ?? 100);
        const rows = this.db.prepare(sql).all(...vals);
        return rows.map(rowToTask);
    }
    activeTaskCount() {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','starting','running','waiting_input','cancel_requested')")
            .get();
        return row.n;
    }
    // -------------------------------------------------------------------------
    // task_events
    // -------------------------------------------------------------------------
    insertEvent(e) {
        this.db
            .prepare("INSERT INTO task_events (event_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)")
            .run(e.eventId, e.taskId, e.eventType, e.payload ? JSON.stringify(e.payload) : null, e.createdAt);
    }
    listEvents(taskId, limit = 200) {
        const rows = this.db
            .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?")
            .all(taskId, limit);
        return rows.map((r) => ({
            eventId: r.event_id,
            taskId: r.task_id,
            eventType: r.event_type,
            payload: r.payload ? JSON.parse(r.payload) : undefined,
            createdAt: r.created_at,
        }));
    }
    // -------------------------------------------------------------------------
    // task_messages
    // -------------------------------------------------------------------------
    insertMessage(m) {
        // 幂等键 UNIQUE 冲突 => 已受理过, 返回 false。
        try {
            this.db
                .prepare("INSERT INTO task_messages (message_id, task_id, sender, content, idempotency_key, status, channel, reason, created_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
                .run(m.messageId, m.taskId, m.sender, m.content, m.idempotencyKey, m.status, m.channel ?? null, m.reason ?? null, m.createdAt, m.deliveredAt ?? null);
            return true;
        }
        catch {
            return false;
        }
    }
    updateMessage(messageId, fields) {
        const sets = [];
        const vals = [];
        if (fields.status !== undefined) {
            sets.push("status = ?");
            vals.push(fields.status);
        }
        if (fields.channel !== undefined) {
            sets.push("channel = ?");
            vals.push(fields.channel);
        }
        if (fields.reason !== undefined) {
            sets.push("reason = ?");
            vals.push(fields.reason);
        }
        if (fields.deliveredAt !== undefined) {
            sets.push("delivered_at = ?");
            vals.push(fields.deliveredAt);
        }
        if (fields.content !== undefined) {
            sets.push("content = ?");
            vals.push(fields.content);
        }
        if (!sets.length)
            return;
        vals.push(messageId);
        this.db.prepare(`UPDATE task_messages SET ${sets.join(", ")} WHERE message_id = ?`).run(...vals);
    }
    /** 0.2.4：跨会话首次绑定冲突检测 —— 查同一个 native_session_id 是否已归属其他会话。 */
    findTaskByNativeSessionOtherOwner(nativeSessionId, ownerSessionId) {
        if (!nativeSessionId)
            return undefined;
        const row = this.db
            .prepare("SELECT * FROM tasks WHERE native_session_id = ? AND owner_session_id != '' AND owner_session_id != ? LIMIT 1")
            .get(String(nativeSessionId), String(ownerSessionId ?? ""));
        return row ? rowToTask(row) : undefined;
    }
    /** 0.2.4：强制 WAL checkpoint，供迁移删源前落盘确认。 */
    checkpoint() {
        try {
            this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        catch { /* 尽力落盘 */ }
    }
    /** 删一条消息（幂等键重试前腾位置用：同 key 只允许一行）。 */
    deleteMessage(messageId) {
        const res = this.db.prepare("DELETE FROM task_messages WHERE message_id = ?").run(messageId);
        return Number(res.changes);
    }
    listMessages(taskId) {
        const rows = this.db
            .prepare("SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC")
            .all(taskId);
        return rows.map((r) => ({
            messageId: r.message_id,
            taskId: r.task_id,
            sender: r.sender,
            content: r.content,
            idempotencyKey: r.idempotency_key,
            status: r.status,
            channel: r.channel ?? undefined,
            reason: r.reason ?? undefined,
            createdAt: r.created_at,
            deliveredAt: r.deliveredAt ?? r.delivered_at ?? undefined,
        }));
    }
    // -------------------------------------------------------------------------
    // task_context
    // -------------------------------------------------------------------------
    insertContext(c) {
        this.db
            .prepare("INSERT INTO task_context (task_id, version, objective, current_stage, done, decisions, changed_files, pending_issues, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(c.taskId, c.version, c.objective, c.currentStage ?? null, JSON.stringify(c.done), JSON.stringify(c.decisions), JSON.stringify(c.changedFiles), JSON.stringify(c.pendingIssues), c.updatedAt);
    }
    getContext(taskId) {
        const row = this.db
            .prepare("SELECT * FROM task_context WHERE task_id = ?")
            .get(taskId);
        if (!row)
            return undefined;
        return {
            taskId: row.task_id,
            version: row.version,
            objective: row.objective,
            currentStage: row.current_stage ?? undefined,
            done: JSON.parse(row.done),
            decisions: JSON.parse(row.decisions),
            changedFiles: JSON.parse(row.changed_files),
            pendingIssues: JSON.parse(row.pending_issues),
            updatedAt: row.updated_at,
        };
    }
    /**
     * 带版本校验的整存整取更新: version 不符返回 false（并发冲突）。
     * expectedVersion === 0 表示首写（库里还没有该任务的 context 行），
     * 走 INSERT 落 version=1；已有行则 UPDATE 校验 version。
     */
    updateContextOptimistic(expectedVersion, c) {
        if (expectedVersion === 0) {
            try {
                this.db
                    .prepare("INSERT INTO task_context (task_id, version, objective, current_stage, done, decisions, changed_files, pending_issues, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
                    .run(c.taskId, 1, c.objective, c.currentStage ?? null, JSON.stringify(c.done), JSON.stringify(c.decisions), JSON.stringify(c.changedFiles), JSON.stringify(c.pendingIssues), c.updatedAt);
                return true;
            }
            catch {
                return false; // 已有并发首写抢先落库：按冲突处理，让调用方重读再写
            }
        }
        const res = this.db
            .prepare(`UPDATE task_context SET version=?, objective=?, current_stage=?, done=?, decisions=?,
         changed_files=?, pending_issues=?, updated_at=? WHERE task_id=? AND version=?`)
            .run(expectedVersion + 1, c.objective, c.currentStage ?? null, JSON.stringify(c.done), JSON.stringify(c.decisions), JSON.stringify(c.changedFiles), JSON.stringify(c.pendingIssues), c.updatedAt, c.taskId, expectedVersion);
        return Number(res.changes) === 1;
    }
    // -------------------------------------------------------------------------
    // resource_locks
    // -------------------------------------------------------------------------
    tryAcquireLock(lock) {
        // 过期租约可被接管: DELETE 后再 INSERT, 包在事务里。
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare("DELETE FROM resource_locks WHERE resource_key = ? AND lease_until < ?")
                .run(lock.resourceKey, lock.acquiredAt);
            const res = this.db
                .prepare("INSERT OR IGNORE INTO resource_locks (resource_key, task_id, owner_session_id, acquired_at, lease_until) VALUES (?,?,?,?,?)")
                .run(lock.resourceKey, lock.taskId, lock.ownerSessionId, lock.acquiredAt, lock.leaseUntil);
            this.db.exec("COMMIT");
            return Number(res.changes) === 1;
        }
        catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    releaseLocksForTask(taskId) {
        const res = this.db
            .prepare("DELETE FROM resource_locks WHERE task_id = ?")
            .run(taskId);
        return Number(res.changes);
    }
    renewLock(resourceKey, taskId, leaseUntil) {
        const res = this.db
            .prepare("UPDATE resource_locks SET lease_until = ? WHERE resource_key = ? AND task_id = ?")
            .run(leaseUntil, resourceKey, taskId);
        return Number(res.changes) === 1;
    }
    listLocks() {
        const rows = this.db.prepare("SELECT * FROM resource_locks").all();
        return rows.map((r) => ({
            resourceKey: r.resource_key,
            taskId: r.task_id,
            ownerSessionId: r.owner_session_id,
            acquiredAt: r.acquired_at,
            leaseUntil: r.lease_until,
        }));
    }
    // -------------------------------------------------------------------------
    // 幂等
    // -------------------------------------------------------------------------
    /** 幂等登记: 首次登记返回 true, 重复登记返回 false。 */
    claimIdempotency(scope, key, now) {
        try {
            this.db
                .prepare("INSERT INTO idempotency (scope, key, created_at) VALUES (?,?,?)")
                .run(scope, key, now);
            return true;
        }
        catch {
            return false;
        }
    }
    // -------------------------------------------------------------------------
    // 维护
    // -------------------------------------------------------------------------
    purgeHistoryOlderThan(cutoff) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const expired = this.db
                .prepare("SELECT id FROM tasks WHERE status IN ('succeeded','failed','cancelled','lost') AND completed_at IS NOT NULL AND completed_at < ?")
                .all(cutoff);
            let tasks = 0;
            let events = 0;
            for (const { id } of expired) {
                events += Number(this.db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id).changes);
                this.db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(id);
                this.db.prepare("DELETE FROM task_context WHERE task_id = ?").run(id);
                this.db.prepare("DELETE FROM resource_locks WHERE task_id = ?").run(id);
                tasks += Number(this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes);
            }
            // 0.2.0：幂等表也一起清。以前只删任务行，idempotency 表只增不减，
            // 同 key 的终态通知账永远留着（审计 P1-4「永不清理」的另一半）。
            const idem = Number(this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff).changes);
            this.db.exec("COMMIT");
            return { tasks, events, idempotency: idem };
        }
        catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    /** 库规模摸底（自检/维护日志用，不参与业务判断）。 */
    stats() {
        const one = (sql) => {
            try {
                const r = this.db.prepare(sql).get();
                return Number(r?.n ?? 0);
            }
            catch {
                return 0;
            }
        };
        return {
            tasks: one("SELECT COUNT(*) AS n FROM tasks"),
            active: one("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','starting','running','waiting_input','cancel_requested')"),
            events: one("SELECT COUNT(*) AS n FROM task_events"),
            messages: one("SELECT COUNT(*) AS n FROM task_messages"),
            pendingMessages: one("SELECT COUNT(*) AS n FROM task_messages WHERE status = 'pending'"),
            idempotency: one("SELECT COUNT(*) AS n FROM idempotency"),
        };
    }
    /** 待补投的消息（绑定 agent 后 flush 用）。 */
    listPendingMessages(taskId) {
        const rows = this.db
            .prepare("SELECT * FROM task_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC")
            .all(taskId);
        return rows.map((r) => ({
            messageId: r.message_id,
            taskId: r.task_id,
            sender: r.sender,
            content: r.content,
            idempotencyKey: r.idempotency_key,
            status: r.status,
            channel: r.channel ?? undefined,
            reason: r.reason ?? undefined,
            createdAt: r.created_at,
            deliveredAt: r.delivered_at ?? undefined,
        }));
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        // WAL 收尾：close() 前 checkpoint 一次，让 -wal 文件落地，
        // 否则 dispose 之后残留的 -wal 会在下次启动时被当成未提交事务重放。
        try {
            this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        catch { /* checkpoint 失败不阻塞关闭 */ }
        try {
            this.db.close();
        }
        catch { /* 已关闭 */ }
    }
}
function rowToTask(r) {
    return {
        id: r.id,
        conversationId: r.conversation_id,
        ownerSessionId: r.owner_session_id,
        type: r.type,
        nativeId: r.native_id ?? undefined,
        nativeSessionId: r.native_session_id ?? undefined,
        title: r.title,
        objective: r.objective,
        status: r.status,
        currentStage: r.current_stage ?? undefined,
        progressSummary: r.progress_summary ?? undefined,
        resultSummary: r.result_summary ?? undefined,
        errorSummary: r.error_summary ?? undefined,
        priority: r.priority,
        retryOf: r.retry_of ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        completedAt: r.completed_at ?? undefined,
        children: r.children ? JSON.parse(r.children) : undefined,
        labels: r.labels ? JSON.parse(r.labels) : undefined,
    };
}
//# sourceMappingURL=database.js.map