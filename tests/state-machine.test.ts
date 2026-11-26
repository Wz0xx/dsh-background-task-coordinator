/**
 * 状态机单测 — 任务书 T01 前置: 跳转表与终态保护（V1.1 状态集）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  mapNativeToStatus,
  isSettled,
  validateSequence,
  IllegalTransitionError,
} from "../lib/core/task-state-machine.js";
import type { TaskStatus } from "../lib/types.js";

test("合法主链: queued→starting→running→succeeded", () => {
  assert.ok(canTransition("queued", "starting"));
  assert.ok(canTransition("starting", "running"));
  assert.ok(canTransition("running", "succeeded"));
  assert.ok(validateSequence(["queued", "starting", "running", "succeeded"]) === null);
});

test("合法等待链: queued→starting→running→waiting_input→running→failed", () => {
  assert.ok(
    validateSequence(["queued", "starting", "running", "waiting_input", "running", "failed"]) === null,
  );
});

test("取消两态分离（V1.1 A07）: running→cancel_requested→cancelled", () => {
  assert.ok(canTransition("running", "cancel_requested"));
  assert.ok(canTransition("cancel_requested", "cancelled"));
  // 任务在取消确认前自己跑完了: 允许落 succeeded（事实优先）
  assert.ok(canTransition("cancel_requested", "succeeded"));
  assert.ok(validateSequence(["queued", "starting", "running", "cancel_requested", "cancelled"]) === null);
});

test("非法: queued 直达 succeeded / running 直达 cancelled", () => {
  assert.throws(() => assertTransition("queued", "succeeded"), IllegalTransitionError);
  assert.equal(validateSequence(["queued", "succeeded"]), "succeeded");
  // 未请求取消就直接 cancelled：跳过了 cancel_requested —— 拒绝
  assert.throws(() => assertTransition("running", "cancelled"), IllegalTransitionError);
});

test("非法: 终态再跳转（自跳转幂等允许, 其余拒绝）", () => {
  for (const t of ["succeeded", "failed", "cancelled", "lost"] as TaskStatus[]) {
    assert.ok(!canTransition(t, "running"));
    assert.ok(!canTransition(t, "waiting_input"));
    assert.ok(!canTransition(t, "queued"));
    assert.ok(!canTransition(t, "cancel_requested"));
  }
  // 终态 -> 自身: 状态机允许幂等 noop, 由 guardTerminal 在存储层拒绝真实变更
  assert.ok(canTransition("succeeded", "succeeded"));
});

test("lost 是终态: 不再回到活动态（重启后重建新任务, 不复活旧记录）", () => {
  assert.ok(canTransition("running", "lost"));
  assert.ok(!canTransition("lost", "running"));
});

test("同状态幂等允许", () => {
  assert.ok(canTransition("running", "running"));
});

test("原生状态映射", () => {
  assert.equal(mapNativeToStatus("running"), "running");
  assert.equal(mapNativeToStatus("waiting"), "waiting_input");
  assert.equal(mapNativeToStatus("settled-success"), "succeeded");
  assert.equal(mapNativeToStatus("settled-failure"), "failed");
  assert.equal(mapNativeToStatus("settled-cancelled"), "cancelled");
  assert.equal(mapNativeToStatus("gone"), "lost");
  assert.equal(mapNativeToStatus("idle"), null); // idle 不改写——语义由调用方定
  assert.ok(isSettled("settled-success"));
  assert.ok(!isSettled("running"));
});
