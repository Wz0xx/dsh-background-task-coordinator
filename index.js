// dsh-background-task-coordinator —— 后台任务协调器（Host 侧插件）
//
// 为什么独立成插件：任务台账、并发预算、资源锁是跨会话的通用能力，
// 任何一个会话都该能创建/查询/取消后台任务，不用每次借道聊天记录。
//
// 边界（有意为之）：
// - 不重新实现 DSH 的 Agent 执行循环。AI 长任务走原生 subagent 工具
//   （前台创建后回填登记，Mode B），耗时 shell 走 ctx.jobs（VERIFIED）。
// - 状态真源是 DSH 原生 Agent/Job；SQLite 台账只是投影，坏了可随时删库重建。
// - 数据全部隔离在 ~/.dsh/background-task-coordinator/，卸载 = 删目录 + 摘 insert。
//
// 阶段 0 实测点（V1-V6）见 docs/接口核验表.md；本文件里所有「探测」都
// 返回真实探测结果，不伪造成功。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  resolveSubagentSessionId,
  probeSubagentCapabilities,
  getAgentHandle,
} from './compat/subagents-adapter.js';

export const inject = ['tools', 'jobs', 'agents', 'systemPrompt'];
/**
 * 系统提示里那一段。工具注册了不等于会用——不写这一段，新会话里的模型看得到 task_create
 * 也不知道什么时候该伸手，等于装了开关没贴标签。
 */
const PROMPT_TEXT = `## 后台任务

**默认扔后台。** 跑命令之前先问一句「这一步要不要等」。要等的（十秒以上），就扔后台：要么 \`task_create\` 建个 job，要么直接用 \`ops_bash\` 的 \`run_in_background\`。别让伙伴盯着光标转圈。

基本都要等的：构建、测试、安装依赖、编译、训练、下载、解压、扫大目录、跑脚本、查数据库、几十次网络请求。
留在前台就行的：读文件、\`cat\`、\`head\`、看一行 \`git status\`、小目录 \`ls\`/\`grep\`、\`echo\`、\`date\`——这类要立刻拿到输出才能决定下一步。

判据不是命令名叫什么。\`node build.js\` 可能三秒也可能半小时。**拿不准就后台跑**：慢一点没有代价，停下来让人等着才有。

- **建**：\`task_create\`。\`type=job\` 是命令，\`objective\` 第一行写能直接执行的命令行，后续行写它在做什么；\`type=subagent\` 是交给另一个你自己，\`objective\` 写清目标和验收。标题两到三十个字。
- **查**：\`task_list\` 看有哪些在跑，\`task_describe\` 看某一个的阶段、进度和结果摘要。进度只报实到的输出段数，不要编百分比。
- **追加**：跑到一半要改要求，用 \`task_append_message\`。job 这条拿不到 stdin，会如实回 undeliverable；subagent 走原生通道，下一步就收到。
- **停**：\`task_cancel\`。取消会按进程树杀，不留尾巴。
- **留话**：\`task_context\` 记阶段、关键决策、改动过的文件、待办。另一个会话接手时不用重新问一遍。
- **绑子代理**：用 \`subagent\` 工具建完，把返回的 id 交给 \`task_register_delegation\`，台账才会跟着原生状态走；不绑的话它永远停在 running。

伙伴说了「放后台」就直接建，不用问要不要；他没说但这件事明显要跑很久，建完告他一声就行。任务结束会自己回来告诉结果，不用一直盯着查。`;

const HOME_DATA = path.join(os.homedir(), '.dsh', 'background-task-coordinator');

// 子进程在中文 Windows 上默认吐 GBK；先按 UTF-8 严格试一次，失败就认 GBK，认下就不再变。
function makeChunkDecoder() {
  let enc = null;
  return (buf) => {
    if (enc === null) {
      try {
        const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        enc = 'utf8';
        return s;
      } catch {
        enc = 'gbk';
        return new TextDecoder('gbk').decode(buf);
      }
    }
    return enc === 'utf8'
      ? new TextDecoder('utf-8').decode(buf)
      : new TextDecoder('gbk').decode(buf);
  };
}

// ---------------------------------------------------------------------------
// 台账存储：SQLite（node:sqlite，宿主 Node v24.21.0 内置稳定）。
// schema/存储层来自 src/storage 编译产物 lib/storage/database.js——23/23 单测全绿那套。
// 状态真源是 DSH 原生 Agent/Job，SQLite 只是更耐用的投影载体（坏了删 tasks.db 重建）。
// 旧 tasks.json 首次启动时一次性迁移进来，迁完改名 .migrated 保留。
// ---------------------------------------------------------------------------
import { CoordinatorDatabase } from './lib/storage/database.js';

const SCHEMA = 2;
let _sqlite = null; // CoordinatorDatabase 单例
// 模块级日志钩子：apply() 时注入，供 migrate 等模块级函数使用
let _log = () => {};

function db() {
  if (!_sqlite) {
    _sqlite = new CoordinatorDatabase(path.join(HOME_DATA, 'tasks.db'));
    migrateJsonFileIfNeeded();
  }
  return _sqlite;
}

/** 旧 tasks.json → SQLite 一次性迁移。 */
function migrateJsonFileIfNeeded() {
  const f = path.join(HOME_DATA, 'tasks.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return; // 没有旧文件或坏了：SQLite 已是新账，不迁移
  }
  try {
    const tasks = raw && typeof raw === 'object' ? raw.tasks : {};
    const events = Array.isArray(raw?.events) ? raw.events : [];
    const OLD_MAP = { completed: 'succeeded', interrupted: 'lost', waiting: 'waiting_input' };
    let n = 0;
    let skip = 0;
    for (const t of Object.values(tasks)) {
      if (!t || typeof t !== 'object' || !t.id) continue;
      const status = OLD_MAP[t.status] ?? t.status;
      // 逐条幂等：任务主体已存在（上次迁移崩在半路的残余）就跳过插入。
      if (_sqlite.getTask(t.id)) { skip += 1; }
      else {
        _sqlite.insertTask({
          id: t.id,
          conversationId: t.conversationId ?? 'unknown',
          ownerSessionId: t.conversationId ?? 'unknown',
          type: t.type === 'subagent' ? 'subagent' : 'job',
          nativeId: t.nativeId ?? undefined,
          nativeSessionId: t.nativeSessionId ?? undefined,
          title: t.title ?? '未命名任务',
          objective: t.objective ?? '',
          status: TERMINAL.has(status) || ACTIVE.has(status) ? status : 'lost',
          currentStage: t.stage ?? undefined,
          progressSummary: undefined,
          resultSummary: t.resultSummary ?? undefined,
          errorSummary: t.errorSummary ?? undefined,
          priority: 5,
          createdAt: t.createdAt ?? Date.now(),
          updatedAt: t.updatedAt ?? Date.now(),
          completedAt: TERMINAL.has(status) ? (t.updatedAt ?? Date.now()) : undefined,
        });
        n += 1;
      }
      // 消息与 context 在任务存在性判断之外照常尝试——它们本身幂等：
      // 消息撞幂等键 insertMessage 返回 false，context 重复由单条 catch 吃掉。
      // 崩在「任务已插、消息未插」之间时，重启后这里能补齐，不丢数据。
      for (const m of t.messages ?? []) {
        _sqlite.insertMessage({
          messageId: m.mid ?? `msg-${randomUUID()}`,
          taskId: t.id,
          sender: m.sender ?? 'user',
          content: m.content ?? '',
          idempotencyKey: m.idempotencyKey ?? `legacy:${t.id}:${m.mid ?? randomUUID()}`,
          status: m.status === 'delivered' ? 'delivered' : 'undeliverable',
          channel: m.mode === 'next-step' ? 'agent-inbox-next-step' : 'agent-inbox-next-turn',
          reason: m.reason ?? undefined,
          createdAt: m.at ?? Date.now(),
          deliveredAt: m.status === 'delivered' ? (m.at ?? Date.now()) : undefined,
        });
      }
      // context 也迁（V1.0 台账里的共享上下文是 T11 的验收证据，不能丢）。
      if (t.context && typeof t.context === 'object') {
        try {
          _sqlite.insertContext({
            taskId: t.id,
            version: t.context.version ?? 1,
            objective: t.objective ?? '',
            currentStage: t.context.stage,
            done: [],
            decisions: t.context.decisions ?? [],
            changedFiles: t.context.changedFiles ?? [],
            pendingIssues: t.context.pending ?? [],
            updatedAt: t.context.updatedAt ?? t.updatedAt ?? Date.now(),
          });
        } catch { /* 单条失败跳过（含重复迁移时已存在的情况），不阻断整体 */ }
      }
    }
    for (const e of events) {
      if (!e?.taskId) continue;
      try {
        _sqlite.insertEvent({
          eventId: e.eventId ?? `ev-${randomUUID()}`,
          taskId: e.taskId,
          eventType: e.type ?? 'task-progress',
          payload: e.payload ? { note: String(e.payload).slice(0, 300) } : undefined,
          createdAt: e.at ?? Date.now(),
        });
      } catch { /* 外键缺失等：单条跳过 */ }
    }
    fs.renameSync(f, f + '.migrated');
    _log(`旧台账迁移：${n} 条任务从 tasks.json 迁入 SQLite${skip ? `（跳过已存在的 ${skip} 条）` : ''}，原文件改名 .migrated`);
  } catch (e) {
    _log(`tasks.json 迁移失败（SQLite 照常使用）：${String(e).slice(0, 160)}`);
  }
}

// ---- 兼容层：原有工具代码沿用 loadTasks/saveTasks/db.tasks 风格 ----
// loadTasks 返回 { tasks: {id: 投影}, events: [...] } 的只读快照；
// saveTasks 变成 no-op（SQLite 同步落库，无需显式保存）。
// 「读-改-写」的工具路径改用下面的 withTask 原子操作。

/**
 * 台账行 → 工具内部用的任务对象（唯一入口）。
 *
 * 为什么必须走这个函数：getAgentHandle 靠 nativeSessionId 找 agent，
 * 少这个字段就会退回用 agent 名字查 ctx.agents（该表只按 session id 索引）→ 恒 undefined。
 * 0.1.5 就是三处工具各手抄了一遍字段，describe 与 append 两处漏了 nativeSessionId，
 * 于是「改成 getAgentHandle」等于空转（2026-11-27 反馈 §1）。
 *
 * 新增工具一律调它，不要再手拼。
 */
function toTaskHandle(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId ?? null,
    type: row.type === 'subagent' ? 'subagent' : 'job',
    title: row.title ?? null,
    objective: row.objective ?? null,
    status: row.status ?? null,
    // 两者都要：nativeId 是 agent 名（登记时人给的那半），nativeSessionId 是反查出来的真会话 id。
    nativeId: row.nativeId ?? null,
    nativeSessionId: row.nativeSessionId ?? null,
    stage: row.currentStage ?? null,
    // deadline 不落独立列，存在 labels JSON 里（见 task_create 的 insertTask）。
    // 直接读 row.deadlineAt 恒为 undefined —— 0.1.6 那句「已过 deadline」的提示因此永不触发
    // （2026-11-27 issue #1 A2）。这里从 labels 取，注意存的是字符串。
    deadlineAt: (() => {
      const raw = row.labels?.deadlineAt;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    resultSummary: row.resultSummary ?? null,
    errorSummary: row.errorSummary ?? null,
    labels: row.labels ?? null,
  };
}

function loadTasks() {
  const d = db();
  const tasks = {};
  for (const t of d.listTasks({ limit: 500 })) {
    tasks[t.id] = {
      ...toTaskHandle(t),
      version: 1,
      context: null, // 上下文经 db().getContext 读（工具路径单独处理）
      messages: [],
    };
  }
  const events = [];
  for (const t of Object.keys(tasks)) {
    for (const e of d.listEvents(t, 200)) {
      events.push({ eventId: e.eventId, taskId: e.taskId, type: e.eventType, payload: e.payload?.note ?? (e.payload ? JSON.stringify(e.payload).slice(0, 300) : undefined), at: e.createdAt });
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { tasks, events };
}

function saveTasks() { /* SQLite 同步落库，保留调用点兼容 */ }

/** FNV-1a 32 位短哈希（幂等键用，非安全用途）。 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 读-改-写原子操作：拿到最新投影，改完立即落库。 */
function withTask(taskId, fn) {
  const d = db();
  const t = d.getTask(taskId);
  if (!t) return null;
  return fn(t, () => d.getTask(taskId));
}

function newTaskId() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input', 'cancel_requested']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'lost']);

// 事件流水（任务书 4.1）：eventId/taskId/type/actor/payload/at。
function emitEvent(_dbRef, taskId, type, _actor, payload) {
  try {
    db().insertEvent({
      eventId: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      eventType: type,
      payload: payload === undefined || payload === null || payload === '' ? undefined : { note: String(payload).slice(0, 300) },
      createdAt: Date.now(),
    });
  } catch { /* 任务还没落库时先发事件会外键失败：静默 */ }
}

// ---------------------------------------------------------------------------
// 通知账（任务书 6.4 / A10）：同 taskId 终态最多入账一次。
// 实际送达靠 DSH 原生通道（job 结算唤醒 / subagent 父子回灌）——这里记的是
// 「协调器欠不欠一条通知」的账，并给原生通知补上防重与补发依据。
// 通知账落 SQLite idempotency 表（scope=notice）。
// ---------------------------------------------------------------------------
function settleNotification(_dbRef, t) {
  const key = `notice:${t.id}:${t.status}`;
  const claimed = db().claimIdempotency('notice', key, Date.now());
  if (!claimed) return; // 已入过账
  emitEvent(null, t.id, 'task.notified', 'notifier', `终态 ${t.status} 通知已入账（原生通道送达）`);
}

// ---------------------------------------------------------------------------
// ctx.jobs 探测（V3：服务键名与 start 语义实测）
// ---------------------------------------------------------------------------

function probeJobs(ctx, injected) {
  const candidates = ['jobs', 'jobRegistry', 'backgroundJobs'];
  const found = [];
  for (const key of candidates.filter(k => injected.has(k))) {
    const svc = ctx[key];
    if (svc && typeof svc === 'object') {
      found.push({
        key,
        methods: Object.keys(svc).filter((k) => typeof svc[k] === 'function').slice(0, 12),
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : null;
  const log = (msg) => logger?.info?.(`[task-coordinator] ${msg}`);
  _log = log; // 模块级函数（migrate 等）也要能打日志

  const INJECTED = new Set(inject);
  const jobsProbe = probeJobs(ctx, INJECTED);

  // ---------------------------------------------------------------------
  // 系统提示：教模型什么时候用这些工具（任务书阶段 2 的后半）
  // ---------------------------------------------------------------------
  let offPrompt = null;
  if (typeof ctx.systemPrompt?.section === 'function') {
    try {
      const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
        ? ctx.systemPrompt.getSectionOrder('TOOL_JOBS')
        : 1600;
      offPrompt = ctx.systemPrompt.section({ name: 'tool-jobs-background-tasks', order, text: PROMPT_TEXT });
      log(`系统提示已加一段（order=${order}）`);
    } catch (e) {
      log(`系统提示加不进去（不阻塞）：${String(e).slice(0, 160)}`);
    }
  } else {
    log('ctx.systemPrompt 不可用，跳过提示词');
  }

  log(`ctx.jobs 探测：${jobsProbe.length ? JSON.stringify(jobsProbe) : '未找到（dsh-jobs-local 未挂载?）'}`);

  // 自检：反射拿不到方法名（ctx.jobs 是受控代理，实测 methods 为空但 start 能调），
  // 所以别拿 probe 的结果判断通不通，直接看 start 是不是函数。
  const jobReady = (() => {
    try { return typeof ctx.jobs?.start === 'function'; } catch { return false; }
  })();
  if (jobReady) {
    log('后台作业：可用');
  } else {
    log('后台作业：不可用——ctx.jobs.start 不存在。需要 @deepseek-ai/dsh-tool-jobs 在组合里；'
      + '没有它 task_create 只能建 subagent，建 job 会报 "no job controller serves this agent"。');
  }


  /**
   * 兜底探活（一次扫描）：把「原生已回收但没收到 subagent/end」的活动 subagent 任务补落 lost。
   *
   * 只对带 nativeSessionId 的行动手（有 id 才探得动）；解析不出 id 的一律不动 ——
   * 那是「不知道」，不是「死了」。返回本轮补落的条数。
   *
   * task_list 与 task_describe 都调它（2026-11-27 反馈 §3：
   * 文档写了两处都触发，代码原来只有 task_list，两头不靠）。
   */
  function sweepOnce(d) {
    let swept = 0;
    for (const t of d.listTasks({ limit: 500 })) {
      if (t.type !== 'subagent' || !ACTIVE.has(t.status) || !t.nativeSessionId) continue;
      if (getAgentHandle(ctx, t)) continue;
      d.updateTaskFields(t.id, {
        status: 'lost',
        currentStage: 'reconciled',
        errorSummary: '探活兜底：原生 subagent 已回收，但没收到 subagent/end',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      emitEvent(null, t.id, 'task.lost', 'reconciler', '探活兜底');
      settleNotification(null, { id: t.id, status: 'lost' });
      swept += 1;
    }
    return swept;
  }

  const disposers = [
    // ---------------------------------------------------------------------
    // task_create —— 创建后台任务（阶段 1：仅 job 类型可直创）
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_create',
      description: '创建后台任务。type=job：objective 第一行必须是可执行命令（如 npm run build），协调器经 ctx.jobs 后台启动，立即返回 taskId；type=subagent：AI 长任务——前台先用原生 subagent 工具创建子代理，拿到 agentId 后调 task_register_delegation 绑定。运行期间前台照常聊天。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['job', 'subagent'], description: '任务类型' },
          title: { type: 'string', description: '任务标题（2-30 字）' },
          objective: { type: 'string', description: 'job：第一行命令，后续行描述；subagent：任务目标' },
          conversationId: { type: 'string', description: '发起会话标识（QQ 群号/私聊/Web），缺省 current' },
        },
      },
      output: textOut(),
      async execute(args, exec) {
        const realType = args?.type === 'subagent' ? 'subagent' : 'job';
        const title = String(args?.title ?? '').slice(0, 60) || '未命名任务';
        const objective = String(args?.objective ?? '');
        const conversationId = String(args?.conversationId ?? 'current');
        if (!objective.trim()) return { ok: false, text: 'objective 不能为空' };
        // 注册表认的真实会话 id（0.2.2 起 start(spec) 强制解析 spec.owner 的活 agent；
        // 字面量 "current" 会报 session "current" has no live agent）。
        // 写进台账 ownerSessionId，后续 kill/readAt/get 全带它做 caller（assertAccess 围栏）。
        const ownerSessionId = String(exec?.agent?.id ?? '') || conversationId;

        // ---- 资源治理（任务书表 6 / A11）：创建执行器前原子占位 ----
        // 限额配置化：DSH_COORD_LIMITS 环境变量可覆盖（JSON：{"global":3,"perOwner":2,"timeoutMinutes":120}）
        const d = db();
        let LIMITS = { global: 3, perOwner: 2, timeoutMinutes: 120 };
        try {
          const raw = process.env.DSH_COORD_LIMITS;
          if (raw) LIMITS = { ...LIMITS, ...JSON.parse(raw) };
        } catch { /* 环境变量坏了用默认 */ }
        const activeAll = d.listTasks({ limit: 500 }).filter((x) => ACTIVE.has(x.status));
        if (activeAll.length >= LIMITS.global) {
          return { ok: false, text: `已达全局活动任务上限（${activeAll.length}/${LIMITS.global}）。等一个结束再建，或用 DSH_COORD_LIMITS 调限额。（A11：不绕过限额启动）` };
        }
        const mine = activeAll.filter((x) => x.conversationId === conversationId);
        if (mine.length >= LIMITS.perOwner) {
          return { ok: false, text: `本会话活动任务已达上限（${mine.length}/${LIMITS.perOwner}）：${mine.map((x) => x.id).join('、')}。先 task_list 看看哪些该收尾。` };
        }

        const id = newTaskId();
        const deadlineAt = Date.now() + LIMITS.timeoutMinutes * 60_000;
        // 先落库（queued），再推进状态——SQLite 同步事务，启动失败也留痕。
        // deadline 落 labels JSON 列（schema 不加列），sweep 从读回的 labels.deadlineAt 取。
        d.insertTask({
          id,
          conversationId,
          ownerSessionId,
          type: realType,
          title,
          objective,
          status: 'queued',
          currentStage: 'created',
          priority: 5,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          labels: { deadlineAt: String(deadlineAt), deadlineMinutes: String(LIMITS.timeoutMinutes) },
        });
        emitEvent(null, id, 'task.created', 'model', `type=${realType} title=${title} deadline=${LIMITS.timeoutMinutes}min`);
        const t = { id, conversationId, type: realType, title, objective, status: 'queued', nativeId: null, stage: 'created', deadlineAt };

        if (realType === 'job') {
          const registry = ctx.jobs;
          if (!registry || typeof registry.start !== 'function') {
            d.updateTaskFields(id, {
              status: 'failed',
              errorSummary: 'ctx.jobs 不可用（缺 @deepseek-ai/dsh-tool-jobs）',
              updatedAt: Date.now(),
              completedAt: Date.now(),
            });
            emitEvent(null, id, 'task.failed', 'coordinator', t.errorSummary ?? 'ctx.jobs 不可用');
            return {
              ok: false,
              text: `ctx.jobs 不可用（探测到：${JSON.stringify(jobsProbe)}）。耗时命令需要 dsh-jobs-local 挂载。（taskId=${id}）`,
            };
          }
          d.updateTaskFields(id, { status: 'starting', currentStage: 'creating-executor', updatedAt: Date.now() });
          t.status = 'starting';
          t.stage = 'creating-executor';
          // cwd：会话工作目录（ctx.workingDirectory 是宿主的每会话目录真源）。
          // 取不到就如实拒绝——绝不落 DSH 进程目录（反馈第 2 条）。
          // sandbox 对齐：非 danger-full-access 会话必须过 ctx.sandbox.confine（反馈第 1 条），
          // confine 抛错/被拒 = 会话不允许自由 shell，如实拒绝，绝不绕过。
          const firstLine = objective.split('\n', 1)[0].trim();
          const parts = firstLine.split(/\s+/);
          let cwd = null;
          try {
            const ag = exec?.agent ?? null;
            if (ag) cwd = await ctx.workingDirectory?.ensure?.(ag, undefined) ?? null;
          } catch { /* ensure 失败按无 cwd 处理 */ }
          if (!cwd) {
            d.updateTaskFields(id, { status: 'failed', errorSummary: 'working directory unavailable', updatedAt: Date.now(), completedAt: Date.now() });
            return { ok: false, text: `建任务失败：拿不到本会话的工作目录（cwd），拒绝落 DSH 进程目录跑命令。（taskId=${id}）` };
          }
          const wrapped = process.platform === 'win32'
            ? ['cmd.exe', '/d', '/s', '/c', firstLine]
            : ['bash', '-c', firstLine];
          try {
            const policy = exec?.agent ? await ctx.sandboxPolicy?.resolve?.({ session: exec.agent.session }) : null;
            if (policy && policy.mode !== 'danger-full-access' && typeof ctx.sandbox?.confine === 'function') {
              const sandboxed = await ctx.sandbox.confine(wrapped, policy);
              if (Array.isArray(sandboxed?.argv) && sandboxed.argv.length) wrapped.splice(0, wrapped.length, ...sandboxed.argv);
            }
          } catch (e) {
            d.updateTaskFields(id, { status: 'failed', errorSummary: `sandbox 拒绝: ${String(e).slice(0, 120)}`, updatedAt: Date.now(), completedAt: Date.now() });
            return { ok: false, text: `建任务失败：sandbox 拒绝（${String(e).slice(0, 120)}）——当前会话沙箱策略不允许自由 shell。（taskId=${id}）` };
          }
          try {
          const jobId = registry.start({
              kind: 'bash',
              label: title,
              owner: ownerSessionId,
              run(job) {
                const child = spawn(parts[0], parts.slice(1), {
                  shell: true,
                  windowsHide: true,
                  cwd,
                });
                const decodeOut = makeChunkDecoder();
                const decodeErr = makeChunkDecoder();
                // JobHandle.updateProgress(line)：注册表把它投影到 JobView.progress，
                // task_describe 读它 —— 任务书 4.2 的「不许伪造百分比」，这里只报实到的段数。
                let chunks = 0;
                const bump = () => {
                  chunks += 1;
                  try { job.updateProgress(`已收到 ${chunks} 段输出`); } catch { /* 注册表没这个方法就跳过 */ }
                };
                if (child.stdout) {
                  child.stdout.on('data', (d2) => {
                    job.append(decodeOut(d2), { channel: 'stdout' });
                    bump();
                  });
                }
                if (child.stderr) {
                  child.stderr.on('data', (d2) => {
                    job.append(decodeErr(d2), { channel: 'stderr' });
                    bump();
                  });
                }
                return {
                  cancel() {
                    // shell:true 起的是 cmd.exe，它下面的真进程不跟着死——
                    // 必须按进程树杀（taskkill /T），否则台账标了 cancelled、进程还在跑。
                    try {
                      if (process.platform === 'win32' && child.pid) {
                        execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
                      } else {
                        child.kill('SIGKILL');
                      }
                    } catch { /* 已退出 */ }
                  },
                  done: new Promise((resolve) => {
                    child.on('close', (code) => {
                      resolve(code === 0
                        ? { status: 'completed' }
                        : { status: 'failed', detail: `exit ${code}` });
                    });
                  }),
                };
              },
            });
            t.nativeId = String(jobId ?? '');
            t.status = 'running';
            t.stage = 'running';
            d.updateTaskFields(id, { status: 'running', nativeId: t.nativeId, updatedAt: Date.now() });
            emitEvent(null, id, 'task.started', 'coordinator', `native=${t.nativeId}`);
            log(`job 启动：${id} → native ${t.nativeId}`);
          } catch (e) {
            const errSummary = `start 失败: ${String(e).slice(0, 200)}`;
            d.updateTaskFields(id, { status: 'failed', errorSummary: errSummary, updatedAt: Date.now(), completedAt: Date.now() });
            emitEvent(null, id, 'task.failed', 'coordinator', errSummary);
            return { ok: false, text: `任务已记录但启动失败：${errSummary}（taskId=${id}）` };
          }
        }

        const lines = [
          `已受理后台任务：${title}`,
          `taskId=${t.id}`,
          `type=${realType}`,
        ];
        if (t.nativeId) lines.push(`nativeId=${t.nativeId}`);
        lines.push(`状态=${t.status}`);
        if (realType === 'job') lines.push('注意：job 类型不支持中途追加指令（无 stdin 写端），要中途改要求请用 subagent 类型。');
        return { ok: true, text: lines.join('\n') };
      },
    }),

    // ---------------------------------------------------------------------
    // task_list —— 列任务
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_list',
      description: '列出后台任务（默认只看活动中的）。状态是协调器投影；原生事实以 DSH Agent/Job 为准。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          all: { type: 'boolean', description: 'true 时连终态也列（最近 50 条）' },
        },
      },
      output: textOut(),
      async execute(args) {
        const d = db();
        // 兜底探活：**只有 task_list 会写台账**（2026-11-27 issue #1 A1 ——
        // describe 曾也调它，但那是只读工具写终态，会把瞬时查不到的活任务打死）。
        const swept = sweepOnce(d);
        if (swept) log(`探活兜底：${swept} 条 subagent 任务原生已回收，补落 lost`);
        const all = d.listTasks({ limit: 500 }).sort((a, b) => b.createdAt - a.createdAt);
        const wantAll = Boolean(args?.all);
        const rows = (wantAll ? all : all.filter((t) => ACTIVE.has(t.status))).slice(0, 50);
        if (!rows.length) return { ok: true, text: '（无任务）' };
        const lines = rows.map((t) =>
          `${t.id}  [${t.status}]  ${t.title}  (${t.type}${t.nativeId ? `/${t.nativeId}` : ''})  ${new Date(t.createdAt).toLocaleString()}`,
        );
        if (swept) lines.unshift(`（本轮探活补落 ${swept} 条 lost）`);
        return { ok: true, text: lines.join('\n') };
      },
    }),

    // ---------------------------------------------------------------------
    // task_describe —— 单任务详情（自然语言查询的落点）
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_describe',
      description: '查单个后台任务的详情：状态、阶段、最近事件、结果/错误摘要。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
        },
      },
      output: textOut(),
      async execute(args) {
        const d = db();
        // 只读工具不写台账（2026-11-27 issue #1 A1）。
        //
        // 0.1.6 这里调了 sweepOnce(d) —— 那是「扫全表 + 把查不到的补落 lost」的写操作。
        // 问题：ctx.agents.get 可能瞬时查不到活着的 agent，而 lost 在 TERMINAL 里、
        // 不可逆。一个只读的 describe 会因此把活着的任务打死。
        // 改成：只对这一条做**只读**探活，查不到只在输出里提示，不动状态。
        // 真正的状态清理留给 task_list（明确的「列一下」动作）与 subagent/end 结算。
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        const t = toTaskHandle(row);
        t.context = d.getContext(tid) ?? null;
        const lines = [
          `任务 ${t.id} 「${t.title}」 [${t.status}]`,
          `类型：${t.type}${t.nativeId ? `（native=${t.nativeId}）` : ''}`,
        ];
        // 发起信息（0.1.6 之前是个永远不输出的死变量，issue #1 C1）
        lines.push(`发起：${t.conversationId ?? '—'}  ${t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}`);

        // subagent：真源在 DSH，台账只是投影 —— 这里现查一次原生 agent。
        // 只读：查不到只提示，不改台账状态（改状态是 task_list / subagent/end 的事）。
        if (t.type === 'subagent' && (t.nativeSessionId || t.nativeId)) {
          try {
            const ag = getAgentHandle(ctx, t);
            if (!ag) {
              lines.push('原生 agent：查不到（可能已结束回收）');
              if (ACTIVE.has(t.status)) {
                lines.push('  ↳ 台账仍记 ' + t.status + '。要落终态请调 task_list（会做探活补落），'
                  + '或 task_cancel 显式取消。describe 自己不写台账。');
              }
            } else {
              const keys = Object.getOwnPropertyNames(ag).slice(0, 14).join(',');
              lines.push(`原生 agent：keys=${keys}`);
              lines.push(`原生 status=${JSON.stringify(ag.status)}`);
            }
          } catch (e) {
            lines.push(`原生状态查询失败：${String(e).slice(0, 120)}`);
          }
        }
        if (t.stage && t.stage !== t.status) lines.push(`阶段：${t.stage}`);
        if (t.context) {
          const c = t.context;
          lines.push(`上下文 v${c.version}（${new Date(c.updatedAt).toLocaleString()}）`);
          if (c.currentStage) lines.push(`  阶段：${c.currentStage}`);
          if (c.decisions?.length) lines.push(`  决策：${c.decisions.slice(0, 3).join('；')}`);
          if (c.changedFiles?.length) lines.push(`  改动：${c.changedFiles.slice(0, 5).join('、')}`);
          if (c.pendingIssues?.length) lines.push(`  待办：${c.pendingIssues.slice(0, 3).join('；')}`);
        }
        if (t.resultSummary) lines.push(`结果：${t.resultSummary}`);
        if (t.errorSummary) lines.push(`错误：${t.errorSummary}`);
        if (t.status === 'cancel_requested') lines.push('状态：取消已请求，等原生执行器确认后落 cancelled（A07 两态分离）');
        if (t.deadlineAt && Date.now() > t.deadlineAt && ACTIVE.has(t.status)) lines.push('注意：已过 deadline，等结算或超时清理');
        // 最近事件流水（任务书 4.1）：给查询一个可追的轨迹
        const evs = d.listEvents(tid, 200).slice(-5);
        if (evs.length) {
          lines.push('最近事件：');
          for (const e of evs) lines.push(`  ${new Date(e.createdAt).toLocaleTimeString()} [${e.eventType}] ${e.payload?.note ?? ''}`);
        }
        // Job 输出非消耗读。有主 job 的 get/readAt 受 assertAccess 围栏：
        // caller 必须等于 owner（task_create 落台账的 owner_session_id）。
        const rowFull = d.getTask(tid);
        const caller = rowFull?.ownerSessionId ?? undefined;
        if (t.type === 'job' && t.nativeId && ctx.jobs?.get) {
          try {
            const jv = ctx.jobs.get(t.nativeId, caller);
            if (jv?.progress) lines.push(`进度：${jv.progress}`);
          } catch { /* 读不到进度不阻塞详情 */ }
        }
        if (t.type === 'job' && t.nativeId && ctx.jobs?.readAt) {
          try {
            const r = ctx.jobs.readAt(t.nativeId, 0, caller);
            const raw = (r?.chunks ?? []).map((c) => c?.text ?? '').join('');
            // A12 截断策略：先按行取尾 8 行，单行仍过长再裁到 500 字符
            const tail = raw
              .split('\n')
              .slice(-8)
              .map((l) => (l.length > 500 ? `${l.slice(0, 500)}…（截断）` : l))
              .join('\n');
            if (tail.trim()) lines.push('最近输出（非消耗读）：', ...tail.split('\n').map((l) => `  ${l}`));
          } catch { /* 输出读不到不阻塞详情 */ }
        }
        return { ok: true, text: lines.join('\n') };
      },
    }),

    // ---------------------------------------------------------------------
    // task_register_delegation —— Mode B 登记（subagent 由前台创建）
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_register_delegation',
      description: '把已创建的 subagent 绑定到任务：创建 subagent 时原生返回的 agentId/sessionId 在这里登记，任务进入 running。之后可用 task_append_message 向它递指令（经原生 send_message 通道）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          agentId: { type: 'string', description: 'subagent 工具返回的子代理 id' },
          sessionId: { type: 'string', description: '子代理会话 id（原生返回值）' },
        },
      },
      output: textOut(),
      async execute(args, exec) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        if (row.type !== 'subagent') return { ok: false, text: '只有 subagent 类型需要登记委派' };
        const agentName = String(args?.agentId ?? '').trim();
        if (!agentName) return { ok: false, text: 'agentId 不能为空（原生 subagent 工具返回的 agent 名）' };
        // 原生 subagent 工具只回 "started subagent <name>"，拿不到会话 id；
        // 结算事件 subagent/end 只带会话 id。两边要接上，必须在这里把名字换成 id：
        //   0.2.2+ resolveName(caller, name) → SessionId
        //   0.2.1  listChildren(parentSessionId) → 按 label 匹配
        // 反查不出来就留 null（绝不把名字当 id 落库），并在返回文本里说清楚结算靠兜底。
        //
        // caller 兜底（2026-11-27 issue #1 A3）：exec.agent 在工具调用上下文里可能是空的，
        // 而 listChildren 分支要 caller.session.id 当父会话 —— 空了就必然反查不到。
        // 台账里记着 ownerSessionId，拿它造一个最小 caller 再试。
        const caller = exec?.agent
          ?? (row.ownerSessionId ? { session: { id: row.ownerSessionId }, id: row.ownerSessionId } : undefined);
        const realSid = await resolveSubagentSessionId(
          ctx,
          agentName,
          caller,
          String(args?.sessionId ?? ''),
        );
        // queued → starting → running（V1.1 表 3：不再直达）
        const from = row.status;
        if (from === 'queued') d.updateTaskFields(tid, { status: 'starting', updatedAt: Date.now() });
        d.updateTaskFields(tid, {
          status: 'running',
          nativeId: agentName,
          nativeSessionId: realSid ?? null,
          currentStage: 'delegated',
          updatedAt: Date.now(),
        });
        emitEvent(
          null, tid, 'task.started', 'coordinator',
          `delegated → agent ${agentName}${realSid ? ` session ${realSid}` : '（session 未解析）'}`,
        );
        log(`委派登记：${tid} → agent ${agentName} session=${realSid ?? '未解析'}`);
        const tail = realSid
          ? `已解析到会话 ${realSid}，结算会由 subagent/end 自动落账。`
          : '没能解析出会话 id（原生工具不返回、按名字反查也落空）：结算不靠事件，'
            + '会在 task_list / task_describe 时按探活兜底落 lost；要确定状态请显式 task_cancel。';
        return { ok: true, text: `已绑定：task ${tid} ↔ agent ${agentName}，任务进入 running。\n${tail}` };
      },
    }),

    // ---------------------------------------------------------------------
    // task_append_message —— 追加指令
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_append_message',
      description: '向运行中的后台任务追加指令。subagent：经原生通道投递（下一可接收时机处理，不打断当前工具调用）；job：诚实拒绝——原生无 stdin 写端，请记录为后续步骤或转交所属 subagent。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          content: { type: 'string' },
          idempotencyKey: { type: 'string', description: '幂等键：同键重复提交只投一次（任务书 11.1）' },
          mode: { type: 'string', enum: ['next-turn', 'next-step'], description: 'next-turn 常规追加；next-step 紧急修正' },
        },
      },
      output: textOut(),
      async execute(args) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        const content = String(args?.content ?? '');
        if (!content.trim()) return { ok: false, text: '指令内容为空' };
        const mode = args?.mode === 'next-step' ? 'next-step' : 'next-turn';
        const idem = String(args?.idempotencyKey ?? '').slice(0, 128);
        const mid = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const t = toTaskHandle(row);

        // 幂等键去重（任务书表 7 / 11.1）：显式键或自动键（内容哈希）命中即不再投。
        const autoKey = `msg:${tid}:user:${fnv1a(content)}`;
        const checkKey = idem || autoKey;
        const dup = d.listMessages(tid).find((m) => m.idempotencyKey === checkKey);
        if (dup) {
          return { ok: dup.status === 'delivered', text: `幂等命中：指令 ${dup.messageId} 已是 ${dup.status}，本次未重复投递。（idempotencyKey=${checkKey}）` };
        }

        if (t.type === 'job') {
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: content.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: 'job 无 stdin（原生契约）',
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `undeliverable: ${content.slice(0, 80)}`);
          return { ok: false, text: `未投递：background job 不支持 stdin 追加（原生契约如此，不伪装）。指令已记录（${mid}），可排队为任务后续步骤或转交所属 subagent。` };
        }
        if (!t.nativeId) {
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: content.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'pending',
            channel: 'none',
            reason: '任务尚未绑定 subagent',
            createdAt: Date.now(),
          });
          return { ok: false, text: '任务尚未绑定 subagent（先 task_register_delegation）。指令已登记为 pending，绑定后补投。' };
        }
        // 真实投递：ctx.agents.get(sessionId) 拿活着的 agent，调 followup / steer。
        // ctx.agents 只按 session id 索引 —— 台账里 nativeId 是 agent 名，必须用 nativeSessionId
        // （没解析出才退回名字，会查不到，那就是如实报不可达，不装作投出去了）。
        const ag = getAgentHandle(ctx, t);
        if (!ag) {
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: content.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: 'agent 已结束或不可达（原生 agents.get 查不到）',
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `undeliverable: ${content.slice(0, 80)}`);
          return { ok: false, text: `未投递：agent ${t.nativeId} 已结束或不可达（原生 agents.get 查不到）。指令已记录（${mid}）。` };
        }
        try {
          // followup / steer 收的是消息对象，不是字符串：裸字符串会让它在读 source.kind 时炸
          // （构造方式照 @deepseek-ai/dsh-llm 的 createUserMessage：id + role + content + source）
          const message = {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: content }],
            source: { kind: 'user' },
          };
          if (mode === 'next-step' && typeof ag.steer === 'function') ag.steer(message);
          else if (typeof ag.followup === 'function') ag.followup(message);
          else throw new Error('这个 agent 没有 followup/steer');
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: content.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'delivered',
            channel: mode === 'next-step' ? 'agent-inbox-next-step' : 'agent-inbox-next-turn',
            createdAt: Date.now(),
            deliveredAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `delivered(${mode}): ${content.slice(0, 80)}`);
          const sid = t.nativeSessionId || t.nativeId;
          return { ok: true, text: `已投递到 agent ${t.nativeId}${t.nativeSessionId ? `（会话 ${sid}）` : ''}（${mid}，mode=${mode}）。busy 时进收件箱，下一可接收时机处理，不打断当前工具调用。` };
        } catch (e) {
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: content.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: String(e).slice(0, 160),
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `failed: ${content.slice(0, 80)}`);
          return { ok: false, text: `投递失败：${String(e).slice(0, 200)}（${mid}）` };
        }
      },
    }),

    // ---------------------------------------------------------------------
    // task_cancel —— 取消（真实原生取消 + 终态确认）
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_cancel',
      description: '取消后台任务。job：调原生 kill 并确认终态；subagent：调原生 interrupt_agent。取消后更新台账并通知。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      output: textOut(),
      async execute(args) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        if (TERMINAL.has(row.status)) return { ok: false, text: `任务已终态（${row.status}），无需取消` };
        if (row.status === 'cancel_requested') {
          return { ok: true, text: `取消已请求过（task ${tid}），等执行器确认，别重复发。` };
        }
        const t = toTaskHandle(row);
        const reason = String(args?.reason ?? '用户取消').slice(0, 200);
        let nativeOk = null;
        try {
          if (t.type === 'job' && ctx.jobs?.kill) {
            // 契约：kill(id, caller?, reason?)。有主 job 的 caller 必须 = owner（assertAccess 围栏），
            // 用台账 owner_session_id（task_create 时落的真实会话 id）；无主 job 才传 undefined。
            ctx.jobs.kill(t.nativeId, row.ownerSessionId ?? undefined, reason);
            nativeOk = 'killed';
          } else if (t.type === 'subagent' && t.nativeId) {
            // 原生取消走 interrupt_agent 工具（模型侧）；插件层直接可达性是 V6 探测点
            nativeOk = 'interrupt-requested(经模型工具)';
          }
        } catch (e) {
          nativeOk = `cancel 调用失败: ${String(e).slice(0, 160)}`;
        }
        // job：kill 调用即终局（原生契约），直接落 cancelled；
        // subagent：interrupt 只是「请求」，确认要等原生 subagent/end —— 两个状态分开（任务书表 3 / A07）。
        if (t.type === 'job' && nativeOk === 'killed') {
          d.updateTaskFields(tid, { status: 'cancelled', currentStage: 'cancelled', errorSummary: reason, updatedAt: Date.now(), completedAt: Date.now() });
          emitEvent(null, tid, 'task.cancelled', 'user', reason);
          settleNotification(null, { id: tid, status: 'cancelled' });
          t.status = 'cancelled';
        } else {
          d.updateTaskFields(tid, { status: 'cancel_requested', currentStage: 'cancelling', errorSummary: reason, updatedAt: Date.now() });
          emitEvent(null, tid, 'task.cancel_requested', 'user', `${reason}（native: ${nativeOk ?? '未绑定执行单元'}）`);
          t.status = 'cancel_requested';
        }
        log(`取消：${tid}（${nativeOk}）`);
        const stateWord = t.status === 'cancelled' ? '已取消' : '已请求取消（cancel_requested），等原生确认后落终态';
        return { ok: true, text: `task ${tid} ${stateWord}。原生动作：${nativeOk ?? '无需（未绑定执行单元）'}。` };
      },
    }),

    // ---------------------------------------------------------------------
    // task_context —— 共享任务上下文（任务书 4.6）
    //   不传内容字段 = 读；传了 = 覆盖写，带版本号。
    //   每个数组最多 20 项、每项最多 200 字，整体不超过 8 KB —— 前台只读摘要，
    //   不把后台的完整推理和工具输出搬过来。
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_context',
      description: '读写后台任务的共享上下文：阶段、关键决策、改动过的文件、待办。不传内容字段就是读；传了就覆盖写（版本号 +1）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          stage: { type: 'string', description: '当前阶段，一句话' },
          decisions: { type: 'array', items: { type: 'string' }, description: '关键决策，最多 20 条' },
          changedFiles: { type: 'array', items: { type: 'string' }, description: '改动过的文件，最多 20 条' },
          pending: { type: 'array', items: { type: 'string' }, description: '待办，最多 20 条' },
        },
        required: ['taskId'],
      },
      output: textOut(),
      async execute(args) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };

        const clean = (v) => (Array.isArray(v) ? v : [])
          .map((x) => String(x).slice(0, 200))
          .slice(0, 20);

        const writing =
          args?.stage !== undefined ||
          args?.decisions !== undefined ||
          args?.changedFiles !== undefined ||
          args?.pending !== undefined;

        if (writing) {
          const ctxNow = d.getContext(tid) || { version: 0, done: [], decisions: [], changedFiles: [], pendingIssues: [] };
          // 落地版上下文语义保持：stage/decisions/changedFiles/pending 四字段，乐观锁版本号
          const next = {
            taskId: tid,
            version: (ctxNow.version || 0) + 1,
            objective: row.objective,
            currentStage: args?.stage !== undefined ? String(args.stage).slice(0, 200) : (ctxNow.currentStage ?? ctxNow.stage),
            done: ctxNow.done ?? [],
            decisions: args?.decisions !== undefined ? clean(args.decisions) : (ctxNow.decisions ?? []),
            changedFiles: args?.changedFiles !== undefined ? clean(args.changedFiles) : (ctxNow.changedFiles ?? []),
            pendingIssues: args?.pending !== undefined ? clean(args.pending) : (ctxNow.pendingIssues ?? ctxNow.pending ?? []),
            updatedAt: Date.now(),
          };
          const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
          if (bytes > 8192) {
            return { ok: false, text: `上下文太大（${bytes} 字节 > 8192），缩一缩再写。` };
          }
          // 乐观锁写：版本冲突拒绝
          const wrote = d.updateContextOptimistic(ctxNow.version || 0, next);
          if (!wrote) {
            return { ok: false, text: `上下文版本冲突（库里已是 v${d.getContext(tid)?.version}），重读再写。` };
          }
          d.updateTaskFields(tid, { updatedAt: Date.now() });
          return { ok: true, text: `上下文已更新到 v${next.version}（${bytes} 字节）。` };
        }

        const c = d.getContext(tid);
        if (!c) return { ok: true, text: '这个任务还没有上下文。' };
        const lines = [
          `上下文 v${c.version}，更新于 ${new Date(c.updatedAt).toLocaleString()}`,
          `阶段：${c.currentStage || '（未写）'}`,
          `决策：${(c.decisions || []).length ? c.decisions.join(' / ') : '（无）'}`,
          `改动文件：${(c.changedFiles || []).length ? c.changedFiles.join(' / ') : '（无）'}`,
          `待办：${(c.pendingIssues || []).length ? c.pendingIssues.join(' / ') : '（无）'}`,
        ];
        return { ok: true, text: lines.join('\n') };
      },
    }),

    // ---------------------------------------------------------------------
    // task_probe —— 阶段 0 探测器（V3/V6 的实测入口，验收后保留为诊断工具）
    // ---------------------------------------------------------------------
    ctx.tools.register({
      name: 'task_probe',
      description: '阶段 0 接口探测：列出 ctx 上与 jobs/agents/tools/subagents 相关的服务键与方法面。验收后保留为诊断工具。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOut(),
      async execute() {
        // 直接按名字探：Cordis 的服务不一定出现在 Object.keys(ctx) 上。
        const probe = {};
        for (const k of ['jobs', 'agents', 'tools', 'subagents']) {
          try {
            const v = ctx[k];
            if (!v) {
              probe[k] = 'undefined';
              continue;
            }
            const proto = Object.getPrototypeOf(v);
            const names = proto ? Object.getOwnPropertyNames(proto) : [];
            probe[k] = names.filter((n) => n !== 'constructor').slice(0, 24);
          } catch (e) {
            probe[k] = 'error: ' + String(e).slice(0, 100);
          }
        }
        return {
          ok: true,
          text: [
            `jobs 候选：${JSON.stringify(jobsProbe)}`,
            `直接探：${JSON.stringify(probe, null, 1)}`,
          ].join('\n'),
        };
      },
    }),
  ];

  log(`已注册 8 个工具（7 任务 + task_probe 诊断）；数据目录 ${HOME_DATA}`);

  // -------------------------------------------------------------------------
  // 启动自检：能力三态报告（对照《DSH 插件跨版本兼容层开发任务书》§5.2 / §9）。
  // 只做反射检测，不起真实任务、不发消息（任务书 §16）。
  // subagent.resolve_name 是 0.2.2 才有的：本机 0.2.1-rc.4 上是 unsupported，
  // 那条路走 list_children 降级 —— 报告里写清楚，省得下次再猜。
  // -------------------------------------------------------------------------
  let compatReport = null;
  try {
    // 探测单个能力：读属性本身也可能抛（受控代理），一项抛不该拖垮整份报告。
    const has = (fn) => {
      try { return fn() ? 'supported' : 'unsupported'; } catch { return 'unsupported'; }
    };
    const subCaps = probeSubagentCapabilities(ctx);
    // caps 的每一项都带 required 标记：
    //   required = 缺了插件核心功能就不能用（→ overallStatus 判 incompatible）
    //   optional = 缺了只是少一条路（→ 记进 degraded，但不影响 overallStatus）
    // 0.1.5 的错误是把「任何一项 unsupported」都算 degraded，导致 0.2.2 上恒 degraded
    // ——一个永远亮的告警等于没有告警（2026-11-27 反馈 §2）。
    const caps = {
      'job.start': { status: has(() => typeof ctx.jobs?.start === 'function'), required: true },
      'job.inspect': { status: has(() => typeof ctx.jobs?.get === 'function' && typeof ctx.jobs?.readAt === 'function'), required: true },
      'job.cancel': { status: has(() => typeof ctx.jobs?.kill === 'function'), required: true },
      'job.settle_event': { status: has(() => typeof ctx.jobs?.events?.subscribe === 'function'), required: false },
      'job.activity_event': { status: has(() => typeof ctx.on === 'function'), required: false },
      'agent.get': { status: has(() => typeof ctx.agents?.get === 'function'), required: true },
      'subagent.resolve_name': { status: subCaps.resolveName, required: false },
      'subagent.list_children': { status: subCaps.listChildren, required: false },
      'sandbox.confine': { status: has(() => typeof ctx.sandbox?.confine === 'function'), required: false },
      'sandbox.policy': { status: has(() => typeof ctx.sandboxPolicy?.resolve === 'function'), required: false },
      'working_directory': { status: has(() => typeof ctx.workingDirectory?.ensure === 'function'), required: false },
      'system_prompt.section': { status: has(() => typeof ctx.systemPrompt?.section === 'function'), required: false },
    };

    // 组合能力：subagent 结算只要有**任意一条**反查路即可（resolve_name 或 list_children，OR 关系）。
    // 单独看 list_children 是 unsupported 不代表降级 —— 它只是 0.2.1 的降级路径。
    const canResolveByOurselves = caps['subagent.resolve_name'].status === 'supported'
      || caps['subagent.list_children'].status === 'supported';
    caps['subagent.settle_resolve'] = {
      status: canResolveByOurselves ? 'supported' : 'unsupported',
      required: false,
    };

    const missingRequired = Object.entries(caps)
      .filter(([, c]) => c.required && c.status !== 'supported')
      .map(([k]) => k);
    // degraded 只算「非必需且确实缺」的。
    // 但 resolve_name / list_children 是 OR 关系的一对手段：只要有一条能用就不算降级，
    // 单独把另一条报成 degraded 就是误报（0.2.2 上必然如此 → 恒 degraded → 告警失效）。
    const orGroup = new Set(['subagent.resolve_name', 'subagent.list_children', 'subagent.settle_resolve']);
    const degraded = Object.entries(caps)
      .filter(([k, c]) => {
        if (c.required || c.status === 'supported') return false;
        if (orGroup.has(k)) return !canResolveByOurselves; // 整组一起判，不单独报
        return true;
      })
      .map(([k]) => k);

    compatReport = {
      overallStatus: missingRequired.length ? 'incompatible' : degraded.length ? 'degraded' : 'compatible',
      missingRequired,
      degraded,
      caps: Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, c.status])),
      requiredFlags: Object.fromEntries(Object.entries(caps).filter(([, c]) => c.required).map(([k]) => [k, true])),
    };
    // 日志直接序列化对象本身，避免手写字段名和对象字段名对不上（overallStatus vs status）。
    log(`compat: ${JSON.stringify(compatReport)}`);
    if (missingRequired.length) {
      log(`compat 警告：必需能力缺失（${missingRequired.join('、')}），相关任务类型将无法使用。`);
    }
    if (!canResolveByOurselves) {
      log('compat 提示：resolve_name 与 list_children 都不可用，subagent 结算只能靠 task_list 探活兜底。');
    }
  } catch (e) {
    log(`compat 检测失败（不阻塞）：${String(e).slice(0, 160)}`);
  }

  // -------------------------------------------------------------------------
  // 启动对账（任务书 5.4）：台账里的 running 只是投影，真源在 DSH。
  // 插件重新加载 / 宿主重启后，先问一遍原生：还在不在。查不到的标 lost，
  // 绝不把数据库里的 running 当成事实。
  // -------------------------------------------------------------------------
  try {
    const d0 = db();
    let fixed = 0;
    for (const t of d0.listTasks({ limit: 500 })) {
      if (!ACTIVE.has(t.status)) continue;
      let alive = false;
      try {
        if (t.type === 'job' && t.nativeId) {
          // caller 用台账 owner_session_id（assertAccess 围栏：查别人的有主 job 会抛错）。
          const v = ctx.jobs?.get?.(t.nativeId, t.ownerSessionId ?? undefined);
          alive = !!v && (v.status === 'running' || v.status === 'stopping');
        } else if (t.type === 'subagent' && (t.nativeSessionId || t.nativeId)) {
          // 只认 session id：反查出 id 的按 id 探活；没解析出的（nativeSessionId=null）
          // 拿名字探必然查不到 —— 那种情况不该判 lost（是不知道，不是死了），留给兜底与显式取消。
          alive = t.nativeSessionId ? !!getAgentHandle(ctx, t) : true;
        } else {
          alive = false;
        }
      } catch { alive = false; }
      if (!alive) {
        // 恢复矩阵（任务书表 5）：lost，不虚报 running；事件留痕；走统一终态（带通知账）。
        d0.updateTaskFields(t.id, {
          status: 'lost',
          currentStage: 'reconciled',
          errorSummary: '重启后原生执行单元已不存在（台账投影修正，非真实失败）',
          updatedAt: Date.now(),
          completedAt: Date.now(),
        });
        emitEvent(null, t.id, 'task.lost', 'coordinator', '重启后原生执行单元已不存在（台账投影修正，非真实失败）');
        settleNotification(null, { id: t.id, status: 'lost' });
        fixed += 1;
      }
    }
    if (fixed) {
      log(`启动对账：${fixed} 条活动任务在原生侧已不存在，标为 lost（含终态未通知的补发）`);
    } else {
      log('启动对账：没有需要修正的活动任务');
    }
  } catch (e) {
    log(`启动对账失败（不阻塞）：${String(e).slice(0, 160)}`);
  }


  // -------------------------------------------------------------------------
  // 原生事件订阅 —— subagent 的真源在 DSH，台账只是投影（任务书 4.2 / 5.4）。
  // 事件签名来自 cordis inspect → host/Event：
  //   'subagent/start'(info: SubagentRunInfo) / 'subagent/end'(info: SubagentRunEndInfo)
  //   'agent/status'({ agent, status: 'idle' | 'running' }) / 'agent/disposed'({ agent })
  // -------------------------------------------------------------------------
  try {
    const offEnd = ctx.on('subagent/end', (info) => {
      log(`subagent/end：${JSON.stringify(info).slice(0, 400)}`);
      // SubagentRunEndInfo 原文只带 { runId, provider, id: SessionId, local, stopReason }：
      // 没有 sessionId / agentId / childId。前三个兜底恒 undefined，最终落 info.id。
      const id = info?.sessionId ?? info?.childId ?? info?.agentId ?? info?.id;
      if (!id) return;
      const sid = String(id);
      const d = db();
      // 必须两个字段都比：nativeId 存 agent 名（人给的那半），nativeSessionId 存真会话 id（反查那半）。
      // 0.1.4 及以前只比 nativeId，事件到了也认不出 → 台账永远 running（2026-11-27 反馈 #2）。
      const t = d.listTasks({ limit: 500 }).find(
        (x) => x.nativeId === sid || (x.nativeSessionId != null && x.nativeSessionId === sid),
      );
      if (!t || !ACTIVE.has(t.status)) return;
      const raw = String(info?.stopReason ?? info?.status ?? info?.reason ?? info?.outcome ?? '');
      // A07 会合规则：cancel_requested 状态下收到原生结束事件，无论 stopReason 是什么
      // （常见 aborted/aborted:true，不含 cancel 字样），都落 cancelled——
      // 协调器自己请求过取消，结束就是确认，事实链完整。
      // 其余情况才按 stopReason 推断：含 cancel 落 cancelled；含 fail/error/abort 落 failed。
      const cancelled = t.status === 'cancel_requested' || /cancel/i.test(raw);
      const failed = !cancelled && /fail|error|abort/i.test(raw);
      // cancel_requested 收到原生取消确认 → cancelled（两个状态的会合点，任务书表 5）
      const status = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
      d.updateTaskFields(t.id, {
        status,
        currentStage: 'settled',
        errorSummary: failed ? raw.slice(0, 200) : cancelled ? (t.errorSummary ?? '执行器确认停止') : undefined,
        resultSummary: !failed && !cancelled ? '子代理已结束（原生 subagent/end）' : undefined,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      emitEvent(null, t.id, failed ? 'task.failed' : cancelled ? 'task.cancelled' : 'task.succeeded', 'executor', raw.slice(0, 200));
      settleNotification(null, { id: t.id, status });
      log(`结算：${t.id} → ${status}（subagent/end）`);
    });
    if (typeof offEnd === 'function') disposers.push(offEnd);
    log('已订阅 subagent/end');
  } catch (e) {
    log(`subagent/end 订阅失败：${String(e).slice(0, 160)}`);
  }


  // 结算通知投递（V5）：ctx.jobs 结算订阅，回收终态并带通知账。
  try {
    // 契约：events.subscribe({ owner } | { owners:'all'|'scope' }, listener) -> disposer
    if (ctx.jobs?.events && typeof ctx.jobs.events.subscribe === 'function') {
      const off = ctx.jobs.events.subscribe({ owners: 'all' }, (ev) => {
        if (!ev || ev.type !== 'settled') return;
        const jobId = ev.job?.id;
        const st = String(ev.job?.status ?? '');
        const detail = ev.job?.detail;
        const d = db();
        const t = d.listTasks({ limit: 500 }).find((x) => x.nativeId === String(jobId));
        if (!t || !ACTIVE.has(t.status)) return;
        const terminal =
          st === 'completed' ? 'succeeded' :
          st === 'failed' ? 'failed' :
          st === 'killed' ? 'cancelled' : null;
        if (!terminal) return;
        d.updateTaskFields(t.id, {
          status: terminal,
          currentStage: 'settled',
          resultSummary: terminal === 'succeeded' ? String(detail ?? '作业正常结束').slice(0, 300) : undefined,
          errorSummary: terminal !== 'succeeded' ? String(detail ?? terminal).slice(0, 300) : undefined,
          updatedAt: Date.now(),
          completedAt: Date.now(),
        });
        emitEvent(null, t.id, terminal === 'succeeded' ? 'task.succeeded' : terminal === 'failed' ? 'task.failed' : 'task.cancelled', 'executor', String(detail ?? '').slice(0, 200));
        settleNotification(null, { id: t.id, status: terminal });
        log(`结算：${t.id} → ${terminal}`);
      });
      if (typeof off === 'function') disposers.push(off);
      log('结算订阅已挂（onSettled）');
    } else {
      log('ctx.jobs.onSettled 不存在——结算回收走 task_describe 的 readOutput 兜底，签名待实测');
    }
  } catch (e) {
    log(`结算订阅挂载失败（不阻塞）：${String(e).slice(0, 160)}`);
  }

  // -------------------------------------------------------------------------
  // 超时清账（任务书表 6「任务超时」/ A12 邻近项）：deadlineAt 过点的活动任务，
  // 先请求取消原生执行器，落 cancel_requested；原生确认（或下次扫描仍无响应）落终态。
  // 5 分钟一扫，不做高精度定时——任务书要的是「超时先请求取消，等待确认后落终态」。
  // -------------------------------------------------------------------------
  const LIMITS_READ = () => {
    let lim = { timeoutMinutes: 120, sweepSeconds: 300 };
    try {
      const raw = process.env.DSH_COORD_LIMITS;
      if (raw) lim = { ...lim, ...JSON.parse(raw) };
    } catch { /* 用默认 */ }
    return lim;
  };
  const sweepTimer = setInterval(() => {
    try {
      const d = db();
      const now = Date.now();
      let changed = 0;
      for (const t of d.listTasks({ limit: 500 })) {
        if (!ACTIVE.has(t.status)) continue;
        // deadline 落在 labels.deadlineAt（建任务时写入）
        const dl = Number(t.labels?.deadlineAt ?? 0);
        if (!dl || now <= dl) continue;
        // 迟到的任务在跑（比如 24 小时没停的构建）：请求取消，不直接标失败——
        // 事实还没核实（执行器可能正好在收尾），等原生结算来落终态。
        try {
          if (t.type === 'job' && t.nativeId && ctx.jobs?.kill) {
            ctx.jobs.kill(t.nativeId, t.ownerSessionId ?? undefined, 'deadline 超时，协调器请求取消');
          }
        } catch { /* 原生已死也无妨，结算/对账会收 */ }

        // subagent 没有可调的 kill：请求取消之后要等 subagent/end，
        // 而那个 agent 可能早就没了 —— 那样会永远卡在 cancel_requested（issue #1 A4）。
        // 所以这里对 subagent 追一次探活：原生已不在就直接落 lost，别等一个不会来的事件。
        if (t.type === 'subagent' && t.nativeSessionId) {
          let gone = false;
          try {
            gone = !getAgentHandle(ctx, t);
          } catch { gone = false; /* 探不动就别下结论 */ }
          if (gone) {
            d.updateTaskFields(t.id, {
              status: 'lost',
              currentStage: 'deadline-exceeded',
              errorSummary: `已超 deadline（${LIMITS_READ().timeoutMinutes} 分钟），且原生 subagent 已不在`,
              updatedAt: Date.now(),
              completedAt: Date.now(),
            });
            emitEvent(null, t.id, 'task.lost', 'coordinator', 'deadline 超时 + 原生已回收');
            settleNotification(null, { id: t.id, status: 'lost' });
            changed += 1;
            continue;
          }
        }

        if (t.status !== 'cancel_requested') {
          d.updateTaskFields(t.id, {
            status: 'cancel_requested',
            currentStage: 'deadline-exceeded',
            errorSummary: `已超 deadline（${LIMITS_READ().timeoutMinutes} 分钟），已请求取消，等执行器确认`,
            updatedAt: Date.now(),
          });
          emitEvent(null, t.id, 'task.cancel_requested', 'coordinator', 'deadline 超时');
          changed += 1;
        }
      }
      if (changed) {
        log(`超时清账：${changed} 条任务过 deadline，已请求取消`);
      }
    } catch (e) {
      log(`超时清账失败（不阻塞）：${String(e).slice(0, 120)}`);
    }
  }, Math.max(1, LIMITS_READ().sweepSeconds) * 1000);
  if (typeof sweepTimer?.unref === 'function') sweepTimer.unref();
  disposers.push(() => clearInterval(sweepTimer));

  return () => {
    try { offPrompt?.(); } catch { /* 提示词摘不掉也不影响卸载 */ }
    for (const d of disposers) {
      try {
        d?.();
      } catch { /* 清理失败不影响卸载 */ }
    }
  };
}

function textOut() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        taskId: { type: 'string' },
        nativeId: { type: 'string' },
        ok: { type: 'boolean' }
      },
      required: ['text', 'ok']
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }]
  };
}

export default { apply, inject };
