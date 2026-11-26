/**
 * 端到端单测 — 站在 mock 宿主上跑全链路（任务书 T01/T03/T06/T07/T09/T10 的协调器侧）。
 * 真实宿主并发验收（T02 前后台并行）在阶段 1 于真机执行, 不在本文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskCoordinator } from "../lib/core/task-coordinator.js";
import { mockRuntime } from "./helpers/mock-runtime.ts";

function freshCoordinator(over: Record<string, unknown> = {}) {
  const { runtime, jobs, agents, sessions } = mockRuntime();
  const dir = mkdtempSync(join(tmpdir(), "tc-"));
  const coord = new TaskCoordinator({
    runtime,
    dbPath: join(dir, "tasks.db"),
    homeDir: dir,
    config: {
      maxConsecutiveWakes: 2,
      lockLeaseMs: 60000,
      ...over,
    },
  });
  coord.start();
  return { coord, jobs, agents, sessions, runtime };
}

/** freshCoordinator 的异步版: 等对账完成（重启对账用例用）。 */
async function freshCoordinatorReady(over: Record<string, unknown> = {}) {
  const f = freshCoordinator(over);
  await f.coord.ready;
  return f;
}

test("T03 路线: 创建 job 任务 → running → 结算 → succeeded + 通知", async () => {
  const { coord, jobs, sessions } = freshCoordinator();
  const { task } = await coord.create({
    conversationId: "qq-group-1",
    ownerSessionId: "sess-1",
    type: "job",
    title: "跑构建",
    objective: "npm run build\n构建 lib",
    runInBackground: true,
  });
  assert.equal(task.status, "running");
  assert.ok(task.nativeId?.startsWith("mock-job-"));

  jobs.appendOutput(task.nativeId!, "compiled 42 files");
  jobs.settle(task.nativeId!, "done", "exit code: 0");

  // 结算回调是同步链里的异步分支: 让一拍
  await new Promise((r) => setImmediate(r));
  assert.equal(coord.get(task.id)!.status, "succeeded");
  assert.equal(coord.get(task.id)!.resultSummary, "exit code: 0");

  // 通知恰好一次, 唤醒通道
  const notes = sessions.notifications.filter((n) => n.owner === "sess-1");
  assert.equal(notes.length, 1);
  assert.ok(notes[0]!.wake);
  assert.match(notes[0]!.text, /完成/);
  assert.match(notes[0]!.text, /跑构建/);
  coord.stop();
});

test("结算幂等: 同一终态重复回调只通知一次", async () => {
  const { coord, jobs, sessions } = freshCoordinator();
  const { task } = await coord.create({
    conversationId: "c",
    ownerSessionId: "s",
    type: "job",
    title: "x",
    objective: "echo hi",
    runInBackground: true,
  });
  jobs.settle(task.nativeId!, "done", "first");
  jobs.settle(task.nativeId!, "done", "second");
  await new Promise((r) => setImmediate(r));
  const notes = sessions.notifications.filter((n) => n.text.includes("x"));
  assert.equal(notes.length, 1);
  coord.stop();
});

test("T09: 取消走真实 kill + 终态 cancelled + 通知", async () => {
  const { coord, jobs, sessions } = freshCoordinator();
  const { task } = await coord.create({
    conversationId: "c",
    ownerSessionId: "s",
    type: "job",
    title: "长任务",
    objective: "sleep 100",
    runInBackground: true,
  });
  const res = await coord.cancel(task.id, "不想跑了");
  assert.ok(res.ok);
  assert.equal(jobs.records.get(task.nativeId!)!.state, "cancelled");
  assert.equal(coord.get(task.id)!.status, "cancelled");
  await new Promise((r) => setImmediate(r));
  assert.ok(sessions.notifications.some((n) => n.text.includes("已取消")));
  coord.stop();
});

test("T06 协调器侧: job 指令诚实拒绝（无 stdin）, subagent 指令投递", async () => {
  const { coord } = freshCoordinator();
  // job: undeliverable
  const { task: jt } = await coord.create({
    conversationId: "c",
    ownerSessionId: "s",
    type: "job",
    title: "j",
    objective: "sleep 5",
    runInBackground: true,
  });
  const r1 = await coord.appendMessage(jt.id, "user", "改下参数");
  assert.equal(r1.status, "undeliverable");
  assert.match(r1.reason!, /stdin/);

  // subagent: 委派登记后投递成功
  const { task: st } = await coord.create({
    conversationId: "c",
    ownerSessionId: "s",
    type: "subagent",
    title: "开发",
    objective: "开发一个插件",
    runInBackground: true,
  });
  coord.registerDelegation(st.id, { agentId: "agent-1", sessionId: "sess-agent-1" });
  assert.equal(coord.get(st.id)!.status, "running");
  const r2 = await coord.appendMessage(st.id, "user", "顺便加个关键词屏蔽");
  assert.equal(r2.status, "delivered");
  assert.equal(r2.channel, "agent-inbox-next-turn");
  coord.stop();
});

test("追加指令幂等: 同内容重复受理只投一次", async () => {
  const { coord } = freshCoordinator();
  const { task } = await coord.create({
    conversationId: "c",
    ownerSessionId: "s",
    type: "subagent",
    title: "dev",
    objective: "do it",
    runInBackground: true,
  });
  coord.registerDelegation(task.id, { agentId: "a1", sessionId: "sa1" });
  const r1 = await coord.appendMessage(task.id, "user", "加开关");
  const r2 = await coord.appendMessage(task.id, "user", "加开关");
  assert.equal(r1.status, "delivered");
  assert.equal(r2.status, "delivered");
  assert.match(r2.reason!, /幂等键重复/);
  coord.stop();
});

test("唤醒预算: 连续结算超预算后不再 wake", async () => {
  const { coord, jobs, sessions } = freshCoordinator({ maxConcurrentTasks: 5 }); // 三个任务都要立即跑
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { task } = await coord.create({
      conversationId: "c",
      ownerSessionId: "s",
      type: "job",
      title: `任务${i}`,
      objective: `cmd${i}`,
      runInBackground: true,
    });
    ids.push(task.nativeId!);
  }
  jobs.settle(ids[0]!, "done", "1");
  await new Promise((r) => setImmediate(r));
  jobs.settle(ids[1]!, "done", "2");
  await new Promise((r) => setImmediate(r));
  jobs.settle(ids[2]!, "done", "3");
  await new Promise((r) => setImmediate(r));
  const wakes = sessions.notifications.filter((n) => n.wake);
  const quiets = sessions.notifications.filter((n) => !n.wake);
  // 预算 2: 前两单 wake, 第三单转 quiet（queued-inbox）
  assert.equal(wakes.length, 2);
  assert.equal(quiets.length, 1);
  coord.stop();
});

test("资源锁: 同文件冲突拒绝, 不同文件并行", async () => {
  const { coord } = freshCoordinator();
  const base = {
    conversationId: "c",
    ownerSessionId: "s",
    type: "job" as const,
    runInBackground: true,
  };
  const a = await coord.create({ ...base, title: "a", objective: "cmd a", resourceKeys: ["C:/data/shared.txt"] });
  assert.equal(a.task.status, "running");
  const b = await coord.create({ ...base, title: "b", objective: "cmd b", resourceKeys: ["c:/data/shared.txt"] });
  // 大小写/分隔符归一后同一资源: 冲突 -> failed
  assert.equal(b.task.status, "failed");
  assert.match(b.task.errorSummary!, /资源冲突/);
  const c = await coord.create({ ...base, title: "c", objective: "cmd c", resourceKeys: ["C:/data/other.txt"] });
  assert.equal(c.task.status, "running");
  coord.stop();
});

test("重启对账: running 任务句柄丢失 -> lost（不虚报 running）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tc-"));
  const dbPath = join(dir, "tasks.db");
  {
    const { runtime } = mockRuntime();
    const coord = new TaskCoordinator({ runtime, dbPath, homeDir: dir });
    coord.start(); await coord.ready;
    await coord.create({
      conversationId: "c",
      ownerSessionId: "s",
      type: "job",
      title: "幸存者",
      objective: "long cmd",
      runInBackground: true,
    });
    // 不 stop()——模拟进程崩溃
  }
  {
    const { runtime } = mockRuntime(); // 全新 mock: 原生记录全失
    const coord = new TaskCoordinator({ runtime, dbPath, homeDir: dir });
    coord.start(); await coord.ready; // 对账发生在这里
    // lost 不属于活动态——用 status 过滤查, 验证「不虚报 running」
    const t = coord.list({ status: "lost" })[0]!;
    assert.equal(t.status, "lost");
    assert.ok(!coord.list({ activeOnly: true }).some((x) => x.id === t.id));
    coord.stop();
  }
});

test("T10 协调器侧: 两个 job 并行推进", async () => {
  const { coord, jobs } = freshCoordinator();
  const a = await coord.create({ conversationId: "c", ownerSessionId: "s", type: "job", title: "A", objective: "cmdA", runInBackground: true });
  const b = await coord.create({ conversationId: "c", ownerSessionId: "s", type: "job", title: "B", objective: "cmdB", runInBackground: true });
  assert.equal(a.task.status, "running");
  assert.equal(b.task.status, "running");
  assert.ok(jobs.records.get(a.task.nativeId!)!.state === "running");
  assert.ok(jobs.records.get(b.task.nativeId!)!.state === "running");
  coord.stop();
});
