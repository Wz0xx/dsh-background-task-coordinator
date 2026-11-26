/**
 * 存储层单测 — node:sqlite 建表、CRUD、幂等、锁、乐观锁、历史清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CoordinatorDatabase } from "../lib/storage/database.js";
import type { ManagedTask } from "../lib/types.js";

function task(over: Partial<ManagedTask> = {}): ManagedTask {
  const now = Date.now();
  return {
    id: over.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: "conv-1",
    ownerSessionId: "sess-1",
    type: "job",
    title: "构建",
    objective: "npm run build\n构建产物",
    status: "queued",
    priority: 5,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

test("建表 + 任务 CRUD", () => {
  const db = CoordinatorDatabase.inMemory();
  const t = task();
  db.insertTask(t);
  const got = db.getTask(t.id);
  assert.ok(got);
  assert.equal(got!.title, "构建");
  assert.equal(got!.status, "queued");

  db.updateTaskFields(t.id, { status: "running", currentStage: "编译中" });
  assert.equal(db.getTask(t.id)!.status, "running");
  assert.equal(db.getTask(t.id)!.currentStage, "编译中");

  assert.equal(db.listTasks({ statuses: ["running"] }).length, 1);
  assert.equal(db.listTasks({ statuses: ["succeeded"] }).length, 0);
  db.close();
});

test("幂等键: 首次 true 重复 false", () => {
  const db = CoordinatorDatabase.inMemory();
  assert.ok(db.claimIdempotency("notice", "k1", Date.now()));
  assert.ok(!db.claimIdempotency("notice", "k1", Date.now()));
  assert.ok(db.claimIdempotency("notice", "k2", Date.now())); // 不同键不受影响
  db.close();
});

test("追加指令幂等: idempotency_key UNIQUE", () => {
  const db = CoordinatorDatabase.inMemory();
  const t = task();
  db.insertTask(t);
  const m = {
    messageId: "m1",
    taskId: t.id,
    sender: "user",
    content: "加个开关",
    idempotencyKey: "msg:k",
    status: "pending" as const,
    createdAt: Date.now(),
  };
  assert.ok(db.insertMessage(m));
  assert.ok(!db.insertMessage({ ...m, messageId: "m2" })); // 同键拒绝
  db.updateMessage("m1", { status: "delivered", channel: "agent-inbox-next-turn", deliveredAt: Date.now() });
  assert.equal(db.listMessages(t.id)[0]!.status, "delivered");
  db.close();
});

test("资源锁: 独占 / 租约过期接管 / 任务释放", async () => {
  const db = CoordinatorDatabase.inMemory();
  const t1 = task({ id: "t1" });
  const t2 = task({ id: "t2", status: "running" });
  db.insertTask(t1);
  db.insertTask(t2);

  assert.ok(db.tryAcquireLock({ resourceKey: "file:a", taskId: "t1", ownerSessionId: "sess-1", acquiredAt: Date.now() - 120000, leaseUntil: Date.now() + 60000 }));
  assert.ok(!db.tryAcquireLock({ resourceKey: "file:a", taskId: "t2", ownerSessionId: "sess-1", acquiredAt: Date.now(), leaseUntil: Date.now() + 60000 }));

  // 租约过期: t1 的 lease_until 在「现在」之前时, t2 的 DELETE 条件(lease_until < acquiredAt=now)成立
  await new Promise((r) => setTimeout(r, 5)); // 确保时钟前进, t1 租约语义上过期
  const stale = db.listLocks()[0]!;
  db.db.prepare("UPDATE resource_locks SET lease_until = ? WHERE resource_key = ?").run(Date.now() - 1, stale.resourceKey);
  assert.ok(db.tryAcquireLock({ resourceKey: "file:a", taskId: "t2", ownerSessionId: "sess-1", acquiredAt: Date.now(), leaseUntil: Date.now() + 60000 }));

  assert.equal(db.releaseLocksForTask("t2"), 1);
  assert.equal(db.listLocks().length, 0);
  db.close();
});

test("上下文乐观锁: 版本冲突拒绝", () => {
  const db = CoordinatorDatabase.inMemory();
  const t = task();
  db.insertTask(t);
  db.insertContext({ taskId: t.id, version: 1, objective: "目标", done: [], decisions: [], changedFiles: [], pendingIssues: [], updatedAt: Date.now() });

  const c1 = db.getContext(t.id)!;
  assert.equal(c1.version, 1);
  assert.ok(db.updateContextOptimistic(c1.version, { ...c1, done: ["第一步"], updatedAt: Date.now() }));
  assert.equal(db.getContext(t.id)!.version, 2);

  // 用旧版本再更新 -> 冲突
  assert.ok(!db.updateContextOptimistic(c1.version, { ...c1, done: ["乱写"], updatedAt: Date.now() }));
  assert.equal(db.getContext(t.id)!.done.length, 1);
  db.close();
});

test("历史清理: 只清终态且过期, 不动活动任务", () => {
  const db = CoordinatorDatabase.inMemory();
  const now = Date.now();
  const old = task({ id: "old", status: "succeeded", completedAt: now - 40 * 24 * 3600 * 1000, updatedAt: now });
  const active = task({ id: "act", status: "running" });
  db.insertTask(old);
  db.insertTask(active);
  db.insertEvent({ eventId: "e1", taskId: "old", eventType: "task-completed", createdAt: now });
  db.insertEvent({ eventId: "e2", taskId: "act", eventType: "task-started", createdAt: now });

  const res = db.purgeHistoryOlderThan(now - 30 * 24 * 3600 * 1000);
  assert.equal(res.tasks, 1);
  assert.equal(res.events, 1);
  assert.ok(!db.getTask("old"));
  assert.ok(db.getTask("act"));
  assert.equal(db.listEvents("act").length, 1);
  db.close();
});
