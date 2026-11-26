/**
 * Mock DshRuntime — 测试用仿真宿主。
 * 不模拟 AI 推理, 只模拟执行单元生命周期与事件面。
 */
import type {
  DshRuntime,
  DshJobsApi,
  DshAgentApi,
  DshSessionApi,
  NativeJobSpec,
  NativeJobStatus,
  NativeAgentRef,
} from "../../lib/adapters/dsh-runtime.js";

export class MockJobs implements DshJobsApi {
  readonly records = new Map<
    string,
    { spec: NativeJobSpec; state: NativeJobStatus["state"]; output: string[]; owner: string }
  >();
  private settleCbs = new Map<string, Set<(id: string, state: string, detail: string) => void>>();
  private seq = 0;
  limit = 10;

  async start(spec: NativeJobSpec, ownerSessionId: string): Promise<string> {
    const runningHere = [...this.records.values()].filter(
      (r) => r.owner === ownerSessionId && (r.state === "running" || r.state === "stopping"),
    ).length;
    if (runningHere >= this.limit) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.limit}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      );
    }
    const id = `mock-job-${++this.seq}`;
    this.records.set(id, { spec, state: "running", output: [], owner: ownerSessionId });
    return id;
  }

  async kill(jobId: string, _reason: string): Promise<void> {
    const r = this.records.get(jobId);
    if (r && r.state === "running") r.state = "cancelled";
    this.emitSettle(jobId);
  }

  async list(): Promise<NativeJobStatus[]> {
    return [...this.records.entries()].map(([jobId, r]) => ({
      jobId,
      state: r.state,
      recentOutput: r.output.join("\n").slice(-500),
    }));
  }

  async readOutput(jobId: string, from = 0) {
    const r = this.records.get(jobId);
    const all = (r?.output ?? []).join("\n");
    const text = all.slice(from);
    return { text, next: all.length, done: r?.state !== "running" };
  }

  onSettled(ownerSessionId: string, cb: (id: string, state: string, detail: string) => void) {
    let cbs = this.settleCbs.get(ownerSessionId);
    if (!cbs) {
      cbs = new Set();
      this.settleCbs.set(ownerSessionId, cbs);
    }
    cbs.add(cb);
    return () => {
      cbs!.delete(cb);
    };
  }

  // ---- 测试驱动 ----

  appendOutput(jobId: string, text: string): void {
    this.records.get(jobId)?.output.push(text);
  }

  settle(jobId: string, state: "done" | "failed" | "cancelled", detail = ""): void {
    const r = this.records.get(jobId);
    if (r) r.state = state;
    this.emitSettle(jobId, detail);
  }

  private emitSettle(jobId: string, detail = ""): void {
    const r = this.records.get(jobId);
    if (!r) return;
    for (const cb of this.settleCbs.get(r.owner) ?? []) {
      cb(jobId, r.state, detail);
    }
  }
}

export class MockAgents implements DshAgentApi {
  readonly children = new Map<string, { ref: NativeAgentRef; status: string; inbox: string[] }>();
  private seq = 0;
  spawnEnabled = false;

  async spawnChild(spec: { objective: string; parentSessionId: string; cwd?: string }) {
    if (!this.spawnEnabled) {
      throw new Error("spawnChild 未核验（Mode A 待阶段 0）");
    }
    const id = `mock-agent-${++this.seq}`;
    const ref = { agentId: id, sessionId: `sess-${id}` };
    this.children.set(id, { ref, status: "idle", inbox: [] });
    return ref;
  }

  registerDelegated(ref: NativeAgentRef): void {
    if (!this.children.has(ref.agentId)) {
      this.children.set(ref.agentId, { ref, status: "idle", inbox: [] });
    }
  }

  async deliverToAgent(ref: NativeAgentRef, message: string, mode: "next-turn" | "next-step") {
    const c = this.children.get(ref.agentId);
    if (!c) throw new Error(`agent 不可达: ${ref.agentId}`);
    c.inbox.push(`[${mode}] ${message}`);
  }

  async cancelAgent(ref: NativeAgentRef, _opts?: { keepInbox?: boolean }) {
    const c = this.children.get(ref.agentId);
    if (c) c.status = "cancelled";
  }

  async pollStatus(ref: NativeAgentRef): Promise<"running" | "idle" | "waiting" | "gone"> {
    const c = this.children.get(ref.agentId);
    if (!c || c.status === "cancelled") return "gone";
    return c.status as "running" | "idle" | "waiting";
  }

  async sendViaNativeChannel(ref: NativeAgentRef, text: string) {
    const c = this.children.get(ref.agentId);
    if (!c) throw new Error(`agent 不可达: ${ref.agentId}`);
    c.inbox.push(`[native] ${text}`);
  }
}

export class MockSessions implements DshSessionApi {
  readonly notifications: Array<{ owner: string; text: string; wake: boolean; at: number }> = [];
  private claimedHandlers = new Set<(owner: string) => void>();
  memoryMb = 2048;
  /** 控制下一次 notifyOwner 的返回值。 */
  nextOutcome: "woken" | "queued-inbox" | "deferred" = "woken";

  async notifyOwner(ownerSessionId: string, text: string, wake: boolean) {
    this.notifications.push({ owner: ownerSessionId, text, wake, at: Date.now() });
    return this.nextOutcome;
  }

  hostMemoryMb(): number {
    return this.memoryMb;
  }

  async runningSessions(): Promise<string[]> {
    return [];
  }

  /** 模拟用户在前台领取消息（重置唤醒预算的钩子）。 */
  fireClaimed(ownerSessionId: string): void {
    for (const cb of this.claimedHandlers) cb(ownerSessionId);
  }
}

export function mockRuntime(): { runtime: DshRuntime; jobs: MockJobs; agents: MockAgents; sessions: MockSessions } {
  const jobs = new MockJobs();
  const agents = new MockAgents();
  const sessions = new MockSessions();
  return { runtime: { jobs, agents, sessions }, jobs, agents, sessions };
}
