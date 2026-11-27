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
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  resolveSubagentSessionId,
  resolveSubagentBinding,
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

/**
 * 台账库路径（0.2.0 按 profile 隔离；0.2.4 防同名 profile 路径碰撞）。
 *
 * 以前所有 profile 写同一个 `~/.dsh/background-task-coordinator/tasks.db`（审计 P2-7）；
 * 0.2.0–0.2.3 仅取 `DSH_PROFILE_DIR` 的 basename，若两套不同根目录/不同 world 下存在
 * 同名 profile（例如两个不同目录的 `default`），仍会共用同一个 tasks.db 并互相标 lost。
 *
 * 0.2.4 规则（Gemini 版）：非默认根目录 / 名字需清洗时加 8 位路径指纹，避免同名串库。
 *
 * 0.2.5 融合（本机必需）：把 `config.profile` 重新接成**第一来源**。
 *   Gemini 版只认环境变量，因为他的 Linux 部署里环境变量能传进插件进程；
 *   本机实测传不进来（日志原文：数据目录 ...\background-task-coordinator\default），
 *   只靠环境变量会落回 default\，和真数据（desktop\）再次分家。
 *   现在：config.profile → env.DSH_PROFILE_DIR → env.DSH_PROFILE → default，
 *   且 config 来的名字**同样**参与指纹计算（两个不同 profile 同名时也不会撞）。
 */
function dataDir(configHint) {
  const home = os.homedir();
  const baseRoot = path.join(home, '.dsh', 'background-task-coordinator');
  const sanitize = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 48) || 'default';
  const shortHash = (p) => {
    const norm = process.platform === 'win32' ? p.toLowerCase() : p;
    return createHash('sha256').update(norm).digest('hex').slice(0, 8);
  };
  const samePath = (a, b) => (process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b);

  // ① config.profile（0.2.5 融合）：宿主通过 patch 配置传进来的 profile 名。
  // 它可能是完整路径，也可能只是一个名字 —— 两种都处理。
  const fromConfig = String(
    (configHint && typeof configHint === 'object'
      ? (configHint.profile ?? configHint.profileName)
      : '') ?? '',
  ).trim();
  if (fromConfig) {
    // 看起来像路径（含分隔符）就按路径走，否则当纯名字。
    const looksLikePath = /[\\/]/.test(fromConfig);
    if (looksLikePath) {
      const resolved = path.resolve(fromConfig.replace(/[\\/]+$/, ''));
      const base = path.basename(resolved);
      const name = sanitize(base);
      const stdProfilesRoot = path.resolve(home, '.dsh', 'profiles');
      if (samePath(path.dirname(resolved), stdProfilesRoot) && base === name) {
        return path.join(baseRoot, name);
      }
      return path.join(baseRoot, `${name}-${shortHash(resolved)}`);
    }
    const name = sanitize(fromConfig);
    // 名字被清洗/截断过 → 加指纹，避免两个不同名字映射到同一个目录
    if (name !== fromConfig) {
      return path.join(baseRoot, `${name}-${shortHash(fromConfig)}`);
    }
    return path.join(baseRoot, name);
  }

  const raw = String(process.env.DSH_PROFILE_DIR ?? '').trim();
  if (raw) {
    const cleaned = raw.replace(/[\\/]+$/, '');
    const resolved = path.resolve(cleaned);
    const base = path.basename(resolved);
    const name = sanitize(base);
    const stdProfilesRoot = path.resolve(home, '.dsh', 'profiles');
    if (samePath(path.dirname(resolved), stdProfilesRoot) && base === name) {
      return path.join(baseRoot, name);
    }
    return path.join(baseRoot, `${name}-${shortHash(resolved)}`);
  }

  const envName = String(process.env.DSH_PROFILE ?? process.env.DSH_PROFILE_NAME ?? '').trim();
  const tag = sanitize(envName);
  const dshHome = String(process.env.DSH_HOME ?? '').trim();
  if (dshHome) {
    const resolvedHome = path.resolve(dshHome);
    const stdHome = path.resolve(home, '.dsh');
    if (!samePath(resolvedHome, stdHome) || (envName && envName !== tag)) {
      return path.join(baseRoot, `${tag}-${shortHash(`${resolvedHome}\0${envName}`)}`);
    }
  } else if (envName && envName !== tag) {
    return path.join(baseRoot, `${tag}-${shortHash(envName)}`);
  }
  return path.join(baseRoot, tag);
}

function dbPath(configHint) {
  return path.join(dataDir(configHint), 'tasks.db');
}

// ---------------------------------------------------------------------------
// 0.2.4：子进程环境过滤（对齐 DSH packages/subprocess/subprocess/src/index.ts#L73-L80）
// ---------------------------------------------------------------------------
// 子进程绝不继承完整 process.env（哪怕是 sandbox.confine 透传了部分 env，也不能把未覆盖的
// 宿主 API KEY / TOKEN / PASSWORD / SECRET / CREDENTIAL 或 DSH_* 内部变量带进后台命令）。
const SENSITIVE_ENV_RE = /(?:KEY|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL)/i;
function scrubbedParentEnv(baseEnv = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV_RE.test(k)) continue;
    if (k.toUpperCase().startsWith('DSH_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 0.2.4：落盘脱敏 —— 将命令、追加指令、上下文与事件流水中明显的内联凭据替换为 [REDACTED]。
 * 只用于写 SQLite 与日志留痕，绝不改写实际传给 spawn 或 ag.followup/steer 的运行时内容。
 */
function redactSecrets(input) {
  let s = String(input ?? '');
  if (!s) return s;
  s = s.replace(/\b(Authorization\s*:\s*)(?:Bearer|Basic|Token)\s+[^\s'",;]+/gi, '$1[REDACTED]');
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [REDACTED]');
  s = s.replace(
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g,
    '[REDACTED]',
  );
  s = s.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASS(?:WORD|WD)?|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;|]+)/gi,
    '$1=[REDACTED]',
  );
  s = s.replace(
    /(--(?:api-?key|access-?token|auth-?token|token|secret|password|passwd))(\s+|=)(?:"[^"]*"|'[^']*'|[^\s&;|]+)/gi,
    '$1$2[REDACTED]',
  );
  s = s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/g, '$1[REDACTED]$3');
  return s;
}

// 子进程在中文 Windows 上默认吐 GBK。0.2.0 之前是「首个 chunk 试解一次就永久锁定编码」，
// 而 Windows 命令的第一个 chunk 常常是纯 ASCII（比如 `echo` 之前什么都没打），
// UTF-8 严格解码当然通过 → 锁成 utf8 → 之后所有 GBK 中文全成乱码（审计 P2-6）。
//
// 现在改成：
//   - 每个编码用**单一持久 TextDecoder + { stream:true }**，多字节字符跨 chunk 也不会被劈成两半；
//   - 纯 ASCII 的 chunk 直接按 UTF-8 吐（ASCII 在两种编码里字节一致，无损），
//     但**不因此锁定**编码；
//   - 只有第一次出现非 ASCII 字节时才判定：整段累积缓冲严格试 UTF-8，
//     通过就 utf8，不通过就是 gbk。判定后把累积缓冲一次吐出去，之后直通。
//   - end() 收尾，把解码器里可能残留的不完整序列冲出来（否则最后一行会缺字）。
function makeChunkDecoder() {
  let enc = null;                                  // null = 还没判定
  let dec = null;                                  // 判定后常驻的 TextDecoder
  let pending = [];                                // 判定前的累积缓冲
  let pendingLen = 0;

  const openDecoder = (e) => (e === 'utf8'
    ? new TextDecoder('utf-8')
    : new TextDecoder('gbk'));

  // 判定用：严格解一次累积缓冲。
  // 返回 'utf8' | 'gbk' | null(null = 只是尾部被截了半个字符，等更多数据)。
  const sniff = (buf) => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return 'utf8';
    } catch {
      // 可能是 UTF-8 多字节字符正好跨在 chunk 边界上：掐掉尾巴 1~3 字节再试。
      for (let cut = 1; cut <= 3; cut++) {
        if (buf.length <= cut) return null;
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - cut));
          return null;
        } catch { /* 继续掐 */ }
      }
      return 'gbk';
    }
  };

  const takeAll = () => {
    if (!pending.length) return '';
    const all = Buffer.concat(pending, pendingLen);
    pending = [];
    pendingLen = 0;
    return all;
  };

  const decoder = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (dec) return dec.decode(b, { stream: true });

    // 未判定且**当前没有积压字节**时，纯 ASCII 段可直接吐出而不锁定编码。
    //
    // 为什么必须加 `pendingLen === 0`（0.2.3，Gemini 补丁采纳）：
    // 有积压时旁路会犯两个错 ——
    //   ① 乱序：积压的字节该先吐，ASCII 段抢在前面出去了；
    //   ② 拆字：GBK 次字节可以落在 ASCII 区（0x40–0x7E），
    //      比如「丂」= 81 40 跨两个 chunk，前一个 chunk 是 81（进 pending），
    //      后一个 chunk 是 40（纯 ASCII？不，40 低于 0x80 所以被当成纯 ASCII 直接吐）
    //      → 一个字被劈成两半，前面是个悬挂的前导字节。
    if (pendingLen === 0) {
      let hasHigh = false;
      for (const byte of b) { if (byte >= 0x80) { hasHigh = true; break; } }
      if (!hasHigh) return b.toString('utf8');
    }

    pending.push(b);
    pendingLen += b.length;
    const verdict = sniff(Buffer.concat(pending, pendingLen));
    if (!verdict) return '';                       // 半截字符，等下一个 chunk
    enc = verdict;
    dec = openDecoder(enc);
    return dec.decode(takeAll(), { stream: true });
  };

  // 收尾：把解码器内部缓冲冲干净。挂成属性而不是改签名，调用点可以少改一处。
  decoder.end = () => {
    if (dec) {
      const tail = dec.decode();
      return tail || '';
    }
    const rest = takeAll();
    if (!rest.length) return '';
    // 流结束时若 pending 只剩 1~3 字节的短 GBK（比如 "A中" = 41 D6 D0），
    // sniff 因「尾部截断保护」返回过 null，走到这里已无后续字节可等。
    // 直接 toString('utf8') 会吐乱码（0.2.2 及以前的 bug，0.2.3 修）——
    // 必须严格试一次：过了就是 utf8，过不了就是 gbk。
    try {
      enc = 'utf8';
      return new TextDecoder('utf-8', { fatal: true }).decode(rest);
    } catch {
      enc = 'gbk';
      return new TextDecoder('gbk').decode(rest);
    }
  };
  decoder.encoding = () => enc;
  return decoder;
}

// ---------------------------------------------------------------------------
// 台账存储：SQLite（node:sqlite，宿主 Node v24.21.0 内置稳定）。
// schema/存储层来自 src/storage 编译产物 lib/storage/database.js——23/23 单测全绿那套。
// 状态真源是 DSH 原生 Agent/Job，SQLite 只是更耐用的投影载体（坏了删 tasks.db 重建）。
// 旧 tasks.json 首次启动时一次性迁移进来，迁完改名 .migrated 保留。
// ---------------------------------------------------------------------------
import { CoordinatorDatabase } from './lib/storage/database.js';

let _sqlite = null; // CoordinatorDatabase 单例
// 模块级日志钩子：apply() 时注入，供 migrate 等模块级函数使用
let _log = () => {};
// 模块级 ctx 引用：settleNotification 这类模块级函数要给发起会话投消息，
// 需要 agents 服务。apply() 时注入，dispose 时清掉（不留悬挂引用）。
let ACTIVE_CTX = null;
// 模块级 profile 提示（0.2.5 融合）：apply(config) 时从宿主配置取，db()/dataDir() 要用。
// 为什么必须留：本机插件进程读不到 DSH_PROFILE_DIR（宿主没传给 host 子进程），
// 只靠环境变量会一直落到 default/。Gemini 版删掉了这条，他的 Linux 环境用不上，
// 但这台机器必需。
let _profileHint = '';

function db() {
  if (!_sqlite) {
    _sqlite = new CoordinatorDatabase(dbPath({ profile: _profileHint }));
    migrateJsonFileIfNeeded();
  }
  return _sqlite;
}

/** 旧 tasks.json → SQLite 一次性迁移（0.2.4：脱敏迁入、落盘后删除源明文副本并清理历史 .migrated）。 */
function migrateJsonFileIfNeeded() {
  const dir = dataDir({ profile: _profileHint });
  // 0.2.4：如果此前旧版本（0.1.x–0.2.3）迁移后留下了 tasks.json.migrated 明文副本，
  // 既然 SQLite 已成功打开，就清掉这份不受 retentionDays 管理的明文残留。
  const legacyCopy = path.join(dir, 'tasks.json.migrated');
  try {
    if (fs.existsSync(legacyCopy)) {
      fs.unlinkSync(legacyCopy);
      _log('旧台账清理：已删除历史遗留的 tasks.json.migrated 明文副本');
    }
  } catch { /* 删除失败不阻塞启动 */ }

  const f = path.join(dir, 'tasks.json');
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
      const safeObj = redactSecrets(t.objective ?? '');
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
          title: redactSecrets(t.title ?? '未命名任务'),
          objective: safeObj,
          status: TERMINAL.has(status) || ACTIVE.has(status) ? status : 'lost',
          currentStage: t.stage ?? undefined,
          progressSummary: undefined,
          resultSummary: t.resultSummary ? redactSecrets(t.resultSummary) : undefined,
          errorSummary: t.errorSummary ? redactSecrets(t.errorSummary) : undefined,
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
          content: redactSecrets(m.content ?? ''),
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
            objective: safeObj,
            currentStage: t.context.stage ? redactSecrets(t.context.stage) : undefined,
            done: [],
            decisions: Array.isArray(t.context.decisions) ? t.context.decisions.map(redactSecrets) : [],
            changedFiles: Array.isArray(t.context.changedFiles) ? t.context.changedFiles.map(redactSecrets) : [],
            pendingIssues: Array.isArray(t.context.pending) ? t.context.pending.map(redactSecrets) : [],
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
          payload: e.payload ? { note: redactSecrets(String(e.payload)).slice(0, 300) } : undefined,
          createdAt: e.at ?? Date.now(),
        });
      } catch { /* 外键缺失等：单条跳过 */ }
    }
    // 0.2.4：确认 SQLite 落盘后直接删除旧 tasks.json，不再改名 .migrated 永久留一份明文副本。
    _sqlite.checkpoint?.();
    fs.unlinkSync(f);
    _log(`旧台账迁移：${n} 条任务从 tasks.json 迁入 SQLite${skip ? `（跳过已存在的 ${skip} 条）` : ''}，已删除原 JSON 文件`);
  } catch (e) {
    _log(`tasks.json 迁移失败（SQLite 照常使用）：${String(e).slice(0, 160)}`);
  }
}

// ---- 台账读取统一走 db() 直查 ----
// 0.1.x 时代有 loadTasks/saveTasks/withTask 三个入口（内存字典 + 整体落盘）。
// 转 SQLite 之后它们全成了死代码：工具路径直接 d.getTask / d.listActive / d.updateTaskFields。
// 0.2.2 删掉 —— 留着会让后来人以为「先 loadTasks 再改再 save」是当前写法。

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

/**
 * 调用者身份（从工具 execute 的第二参拿）。
 *
 * 不能信台账里的 ownerSessionId —— 那是「谁创建的」，不是「现在谁在调」。
 * 0.1.7 之前把 row.ownerSessionId 当 caller 传给 ctx.jobs，
 * 等于替别人的任务冒充 owner，能偷看输出、能杀别人的 job（审计 P0-3）。
 */
function callerSessionId(exec) {
  const ag = exec?.agent ?? null;
  if (!ag) return null;
  // exec.agent 的会话 id 可能在 .id 或 .session.id 上，两处都认。
  const sid = ag.id ?? ag.session?.id ?? null;
  return sid ? String(sid) : null;
}

/**
 * 归属校验：这条任务是不是当前调用者的。
 *
 * 规则（审计 P0-3）：
 *   - 台账里 ownerSessionId 为空（历史数据）→ 放行，避免老任务变成谁都动不了；
 *   - 拿不到调用者身份（某些宿主/某些工具上下文没有 exec.agent）→ 放行但**不冒充** caller；
 *   - 两者都有且不等 → 拒绝。
 */
function ownedBy(row, exec) {
  const owner = row?.ownerSessionId ? String(row.ownerSessionId) : null;
  if (!owner) return { ok: true, owner: null, caller: callerSessionId(exec) };
  const caller = callerSessionId(exec);
  if (!caller) return { ok: true, owner, caller: null };
  if (caller === owner) return { ok: true, owner, caller };
  return { ok: false, owner, caller };
}

/** FNV-1a 32 位短哈希（幂等键用，非安全用途）。 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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
      payload: payload === undefined || payload === null || payload === '' ? undefined : { note: redactSecrets(String(payload)).slice(0, 300) },
      createdAt: Date.now(),
    });
  } catch { /* 任务还没落库时先发事件会外键失败：静默 */ }
}

// ---------------------------------------------------------------------------
// 终态通知（任务书 6.4 / A10）。
//
// 0.2.1 及以前的措辞是「已记账（仅台账；本插件不主动投递消息）」——
// 那句话不假，但等于承认：lost 这类**协调器自产的终态没有任何原生事件**，
// 前台实际收不到东西（审计 P2-9）。
//
// 0.2.2 起真投一次：
//   宿主没有通用的「发通知」服务（inspect 全表查过，只有账户/语音那些被叫
//   Notification 的无关项），但 `agents.get(sessionId)` 能拿到发起会话的活 agent，
//   它上面有 followup/steer —— 和 task_append_message 用的是同一条通道。
//   所以通知 = 向 owner 会话投一条 user 消息，内容是终态摘要。
//
// 三条约束：
//   · 只投**协调器自产**的终态（lost / 超时取消这类没有原生事件可依的）；
//     原生 job/subagent 结束本来就会回到前台，再投一条就是噪音。
//   · 幂等：同 taskId+status 只投一次（idempotency 表 scope=notice）。
//   · 投不出去就如实记下来，措辞不许退回到「已送达」。
// ---------------------------------------------------------------------------
function settleNotification(_dbRef, t, opts = {}) {
  const key = `notice:${t.id}:${t.status}`;
  const claimed = db().claimIdempotency('notice', key, Date.now());
  if (!claimed) return; // 已入过账

  // 只有「协调器自产、前台收不到」的终态才主动投。
  // 原生结算（subagent/end、jobs settled）已经在各自路径上回到前台了。
  const selfProduced = opts.selfProduced === true;

  if (!selfProduced) {
    emitEvent(null, t.id, 'task.notified', 'notifier',
      `终态 ${t.status} 已记账（由原生通道回前台，本插件不重复投递）`);
    return;
  }

  // 真投：拿 owner 会话的活 agent，投一条摘要。
  let delivered = false;
  let why = '';
  try {
    const owner = String(t.ownerSessionId ?? '');
    const agents = (() => {
      try { return typeof ACTIVE_CTX?.get === 'function' ? ACTIVE_CTX.get('agents') : undefined; } catch { return undefined; }
    })();
    const ag = owner && agents ? agents.get(owner) : undefined;
    if (!ag) {
      why = '发起会话当前没有活的 agent';
    } else if (typeof ag.followup !== 'function' && typeof ag.steer !== 'function') {
      why = '发起会话的 agent 没有 followup/steer';
    } else {
      const msg = {
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: `[后台任务终态] ${t.id}「${t.title ?? ''}」→ ${t.status}`
            + `${t.errorSummary ? `（${String(t.errorSummary).slice(0, 120)}）` : ''}`,
        }],
        source: { kind: 'user' },
      };
      if (typeof ag.followup === 'function') ag.followup(msg);
      else ag.steer(msg);
      delivered = true;
    }
  } catch (e) {
    why = String(e?.message ?? e).slice(0, 120);
  }

  emitEvent(null, t.id, 'task.notified', 'notifier',
    delivered
      ? `终态 ${t.status} 已投递到发起会话`
      : `终态 ${t.status} 未能投递（${why || '未知原因'}），仅记账`);
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

export function apply(ctx, config) {
  // 插件配置（cordis.patch.yml 里 insert 的 config）。
  // 0.2.0 之前 apply 根本不收第二个参数，所以 yml 里写什么都进不来 ——
  // 那时候 config 是空对象所以看不出来，一旦往里加东西就成了假配置。
  const PLUGIN_CFG = (config && typeof config === 'object') ? config : {};
  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : null;
  const log = (msg) => logger?.info?.(`[task-coordinator] ${msg}`);
  _log = log; // 模块级函数（migrate 等）也要能打日志
  ACTIVE_CTX = ctx;   // settleNotification 要给发起会话投消息，需要 agents 服务
  // profile 提示（0.2.5 融合）：宿主在启动参数里给了 {"profile":"desktop"}，
  // 但没通过环境变量传给插件进程 —— 所以必须从 config 取。
  _profileHint = String(
    (PLUGIN_CFG.profile ?? PLUGIN_CFG.profileName ?? '') || '',
  ).trim();
  // 打出实际用到的目录与来源：这一行是排查「数据落到 default/」的唯一线索。
  // 上一轮我改错了文件（改的是仓库里那份 cordis.patch.yml，运行时读的是 profile 里那份），
  // 就是靠这行 `来源：fallback(default)` 当场暴露的。
  {
    const resolved = dataDir({ profile: _profileHint });
    const src = _profileHint ? 'config.profile'
      : (process.env.DSH_PROFILE_DIR ? 'env.DSH_PROFILE_DIR'
        : (process.env.DSH_PROFILE ? 'env.DSH_PROFILE' : 'fallback(default)'));
    log(`台账目录：${resolved}（来源：${src}）`);
  }

  // -------------------------------------------------------------------------
  // 统一配置读取（0.2.1）：task_create 的限额、维护循环、保留天数都走这一份。
  //
  // 0.2.0 的错：task_create 里另写了一套只读环境变量的 LIMITS，
  // 和下面那套 LIMITS_READ() 各算各的 —— 于是 cordis.patch.yml 里的 config
  // 对建任务完全不生效（实测传 {global:1} 仍能建第 2 个，deadlineMinutes 仍落 120）。
  //
  // 三层来源，后者盖前者：内置默认 → yml config → DSH_COORD_LIMITS 环境变量。
  // 环境变量放最后是为了「临时调大试试」不用改 yml 重启。
  // -------------------------------------------------------------------------
  const LIMITS_READ = () => {
    let lim = {
      global: 5,
      perOwner: 4,
      timeoutMinutes: 120,
      sweepSeconds: 300,
      retentionDays: 30,
      ...(PLUGIN_CFG && typeof PLUGIN_CFG === 'object' ? PLUGIN_CFG : {}),
    };
    try {
      const raw = process.env.DSH_COORD_LIMITS;
      if (raw) lim = { ...lim, ...JSON.parse(raw) };
    } catch { /* 环境变量坏了用上一层 */ }
    // 数值必须落地成有限数（审计 P2-8）：yml 里写了 "300" 或字段名写错，
    // Math.max(1, NaN) 还是 NaN，setInterval(NaN) 会退化成 1ms 死循环。
    const num = (v, def, min) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : def;
    };
    return {
      global: num(lim.global, 5, 1),
      perOwner: num(lim.perOwner, 4, 1),
      timeoutMinutes: num(lim.timeoutMinutes, 120, 1),
      sweepSeconds: num(lim.sweepSeconds, 300, 1),
      retentionDays: num(lim.retentionDays, 30, 0),
    };
  };

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
   * 只对带 nativeSessionId 的行动手（有 id 才探得动）；解析不出 id 的走宽限期，
   * 超时未绑定才收 —— 那是「不知道」，不是「死了」，不能立刻判死。
   * 返回本轮补落的条数。
   *
   * **只有 `task_list` 调它**。`task_describe` 在 0.1.7 之后不再调
   * （当时它会让只读工具写终态，审计 A1 已改回只读）。
   * 别照旧注释把 describe 那条接回来。
   */
  /**
   * 探活 miss 的连续计数（0.2.2，审计 P2-1）。
   *
   * 为什么要它：`ctx.agents.get` 有瞬时查不到活 agent 的时候（注册表切换、宿主忙）。
   * 0.2.1 及以前是「这一轮查不到就判死」—— 而 `lost` 在 TERMINAL 里、不可逆，
   * 一次抖动就能把正在跑的任务打死。
   *
   * 现在的规则：同一个任务连续 MISS_THRESHOLD 轮都查不到才落 lost。
   * 中间只要有一轮查回来就清零。key 用任务 id，值存「连续 miss 次数 + 最后 miss 时间」。
   * 内存态、进程重启就清空 —— 那是刻意的：重启后由「启动对账」统一裁决，
   * 不该带着上一个进程的怀疑继续算。
   */
  const MISS_THRESHOLD = 2;
  const missStreak = new Map();
  // 早到的 subagent/end（0.2.2，审计 P2-3）：key 是会话 id，值 { at, info }。
  // 子代理可能在前台调 task_register_delegation 之前就跑完，事件比绑定先到。
  const earlyEnds = new Map();
  const bumpMiss = (id, now) => {
    const cur = missStreak.get(id);
    const n = (cur?.n ?? 0) + 1;
    missStreak.set(id, { n, last: now });
    return n;
  };
  const clearMiss = (id) => { if (missStreak.has(id)) missStreak.delete(id); };

  function sweepOnce(d, caller = null) {
    let swept = 0;
    let suspects = 0;
    const now = Date.now();
    // 只扫活动 subagent（走 idx_tasks_status_created），不再拉全表前 500 条
    // —— 任务累积到 500 条以上时，活动任务会掉出窗口，永远扫不到（审计 P1-4）。
    for (const t of d.listActive([...ACTIVE])) {
      if (t.type !== 'subagent' || !ACTIVE.has(t.status)) continue;
      // 归属隔离（0.2.3，Gemini 补丁采纳；对应我 0.2.1 文档里记的那条残留）：
      // 有明确 caller 时只探活**自己的**任务。以前 task_list 会跨所有会话扫并写终态，
      // 等于 A 会话调一下 task_list 就可能把 B 会话的任务标成 lost —— 写别人台账。
      // 拿不到 caller（历史/无 exec 的宿主）时才退回全扫，保持兼容。
      if (caller && t.ownerSessionId && String(t.ownerSessionId) !== String(caller)) continue;

      // 有 session id：按 id 探活。
      // 没 session id：这个 agent 从来没被接上过，探不了。但不能就这么放过 ——
      // 那会变成永生僵尸占配额（审计 P0-2）。给它一个宽限期（默认同 deadline），
      // 超了还没绑定，就当失联收掉：既不会误杀刚登记的，也不会永远占着。
      let gone = false;
      if (t.nativeSessionId) {
        // 必须接住 getAgentHandle 的异常（0.2.1，审计 #1）：
        // 0.1.10 起它不再把 agents.get 的异常吞成 undefined，而是让它冒出来 ——
        // 目的是让调用方区分「查不到」和「查询失败」。但这里没接，结果是一条子代理
        // 的瞬时查询异常会把整个 task_list 打崩。
        // 探活失败的正确处理是「这轮不下结论」：既不算死（不误杀），也不算活（下轮再试）。
        let handle;
        try {
          handle = getAgentHandle(ctx, t);
        } catch (e) {
          log(`探活失败，本轮跳过 ${t.id}：${String(e?.message ?? e).slice(0, 120)}`);
          continue;
        }
        if (handle) {
          clearMiss(t.id);           // 查到了：之前的怀疑全部作废
          continue;
        }
        // 查不到不等于死了（审计 P2-1）：要连续 N 轮都查不到才认。
        const n = bumpMiss(t.id, now);
        if (n < MISS_THRESHOLD) {
          log(`探活 miss ${n}/${MISS_THRESHOLD}：${t.id}，本轮先不动`);
          suspects += 1;   // 告诉调用方「有条在怀疑中，再查一次才落终态」
          continue;
        }
        gone = true;
      } else {
        const born = Number(t.createdAt) || 0;
        const graceMs = LIMITS_READ().timeoutMinutes * 60_000;
        const aged = born > 0 && (now - born) > graceMs;
        // 还在等 delegation 的正常流程内（minutes 级）不碰；过了宽限期才收。
        gone = aged;
      }
      if (!gone) continue;

      d.updateTaskFields(t.id, {
        status: 'lost',
        currentStage: 'reconciled',
        errorSummary: t.nativeSessionId
          ? `探活兜底：连续 ${MISS_THRESHOLD} 轮查不到原生 subagent，且没收到 subagent/end`
          : '从未绑定到会话（无反查 id），超过宽限期仍未登记，按失联收掉',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      emitEvent(null, t.id, 'task.lost', 'reconciler', '探活兜底');
      settleNotification(null, { id: t.id, status: 'lost', ownerSessionId: t.ownerSessionId, title: t.title }, { selfProduced: true });
      clearMiss(t.id);            // 已经落终态，清掉计数
      swept += 1;
    }
    // 顺手清掉已经不在活动集里的陈旧计数（任务被取消/结算/删掉的情况）
    const liveIds = new Set(d.listActive([...ACTIVE]).map((x) => x.id));
    for (const id of missStreak.keys()) {
      if (!liveIds.has(id)) missStreak.delete(id);
    }
    // 返回对象而不是数字（0.2.3）：suspects 让 task_list 能告诉用户
    // 「有条第一次没命中、再查一次才落 lost」——不然两条上限像一个不透明的延迟。
    return { swept, suspects };
  }

  /**
   * job 的探活收尾（0.2.2，审计 P2-8）。
   *
   * 为什么需要：`sweepOnce` 只管 subagent。job 的终态本来靠 `ctx.jobs.events.subscribe`
   * 的 settled 事件，但那个订阅在某些宿主/版本上不存在（上面那句日志就是这种情况），
   * 或者事件漏了 —— 那样 job 会永远停在 running，永不超时、永不计入结算。
   *
   * 这里做的是：对活动中的 job，主动问一次原生 `ctx.jobs.get`。
   *   - 拿到了且已是终态 → 就地落账（与 settled 事件走同一套映射）
   *   - 拿到了还在跑 → 清计数
   *   - 查不到（undefined）→ 连击计数，同 subagent 的规则：连续 N 轮才判 lost
   *   - 查询抛错 → 记录日志本轮跳过，不计 miss（避免瞬时异常误杀）
   *
   * 归属隔离：从 task_list 调用时传 caller（只探活自己的 job）；维护循环传 null（全量核对）。
   *
   * @returns {number} 本轮补落的条数
   */
  function sweepJobsOnce(d, caller = null) {
    let swept = 0;
    // 原生 job 状态 → 台账状态。未知状态返回 null（不猜，交给下一轮）。
    const stMap = (s) => {
      const v = String(s ?? '');
      if (v === 'completed') return 'succeeded';
      if (v === 'failed') return 'failed';
      if (v === 'killed' || v === 'cancelled') return 'cancelled';
      return null;
    };
    for (const t of d.listActive([...ACTIVE])) {
      if (t.type !== 'job' || !t.nativeId) continue;
      // 归属隔离（0.2.4）：从 task_list 调用时传 caller，只探活自己的 job，不跨会话动别人台账；
      // 维护循环（caller=null）仍全量核对。
      if (caller && t.ownerSessionId && String(t.ownerSessionId) !== String(caller)) continue;
      let view;
      let err = null;
      try {
        view = ctx.jobs?.get?.(t.nativeId, t.ownerSessionId ?? undefined);
      } catch (e) {
        err = e;
      }
      if (err) {
        // 0.2.4 对齐 sweepOnce 语义：查询本身抛异常 ≠ job 已消失，
        // 本轮跳过不计 miss，防止瞬时注册表异常把活 job 误杀成不可逆 lost。
        log(`job 探活异常，本轮跳过 ${t.id}：${String(err?.message ?? err).slice(0, 120)}`);
        continue;
      }
      if (!view) {
        const n = bumpMiss(t.id, Date.now());
        if (n >= MISS_THRESHOLD) {
          d.updateTaskFields(t.id, {
            status: 'lost',
            currentStage: 'reconciled',
            errorSummary: `连续 ${MISS_THRESHOLD} 轮查不到原生 job（注册表无此 id）`,
            updatedAt: Date.now(),
            completedAt: Date.now(),
          });
          emitEvent(null, t.id, 'task.lost', 'reconciler', 'job 探活兜底');
          settleNotification(null, { id: t.id, status: 'lost', ownerSessionId: t.ownerSessionId, title: t.title }, { selfProduced: true });
          clearMiss(t.id);
          swept += 1;
        }
        continue;
      }
      const terminal = stMap(view.status);
      if (!terminal) {
        clearMiss(t.id);          // 还在跑
        continue;
      }
      // 原生已终态但台账还在活动态 → 事件漏了，就地补账
      d.updateTaskFields(t.id, {
        status: terminal,
        currentStage: 'settled',
        resultSummary: terminal === 'succeeded' ? String(view.detail ?? '作业正常结束').slice(0, 300) : undefined,
        errorSummary: terminal !== 'succeeded' ? String(view.detail ?? terminal).slice(0, 300) : undefined,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      emitEvent(null, t.id, terminal === 'succeeded' ? 'task.succeeded' : terminal === 'failed' ? 'task.failed' : 'task.cancelled',
        'reconciler', `探活补账：原生已是 ${view.status}`);
      settleNotification(null, { id: t.id, status: terminal, ownerSessionId: t.ownerSessionId, title: t.title }, { selfProduced: true });
      clearMiss(t.id);
      swept += 1;
      log(`job 探活补账：${t.id} → ${terminal}（原生 ${view.status}）`);
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
        // 0.2.4：复用 callerSessionId，同时识别 exec.agent.id 与 exec.agent.session.id。
        const ownerSessionId = callerSessionId(exec) || conversationId;

        // ---- 资源治理（任务书表 6 / A11）：创建执行器前原子占位 ----
        const d = db();
        // 默认值取中间档 5/4（2026-11-27 下游补丁反馈 §1）：
        // 原来的 3/2 对「几个目录同时扫 + 构建和测试分头跑」这种天然并行的活偏紧，
        // 撞限之后只能串行，等于回到没用插件之前。重度用户可以用 DSH_COORD_LIMITS 调更大。
        //
        // 0.2.1（审计 #4）：这里原来另写了一套只读环境变量的 LIMITS，
        // 和 LIMITS_READ() 各算各的 —— 于是 cordis.patch.yml 里的 config
        // 对建任务完全不生效（实测传 {global:1} 仍能建第 2 个，deadlineMinutes 仍落 120）。
        // 现在统一走 LIMITS_READ()：内置默认 → yml config → DSH_COORD_LIMITS，只有一条路。
        const LIMITS = LIMITS_READ();
        // 活动任务只取活动态（走 idx_tasks_status，不再拉全表 500 条内存过滤 —— 审计 P1-4）
        const activeAll = d.listActive([...ACTIVE]);
        if (activeAll.length >= LIMITS.global) {
          return { ok: false, text: `已达全局活动任务上限（${activeAll.length}/${LIMITS.global}，DSH_COORD_LIMITS 可调）。等一个结束再建。（A11：不绕过限额启动）` };
        }
        // perOwner 按**真实会话**统计，不是按模型可控的 conversationId（审计 P1-1）：
        // 用 conversationId 会让所有会话挤同一份额度（全局上限形同虚设），
        // 而单会话传不同 conversationId 又能直接绕过 perOwner。
        const mine = activeAll.filter((x) => String(x.ownerSessionId ?? '') === ownerSessionId);
        if (mine.length >= LIMITS.perOwner) {
          return { ok: false, text: `本会话活动任务已达上限（${mine.length}/${LIMITS.perOwner}，DSH_COORD_LIMITS 可调）：${mine.map((x) => x.id).join('、')}。先 task_list 看看哪些该收尾。` };
        }

        const id = newTaskId();
        const deadlineAt = Date.now() + LIMITS.timeoutMinutes * 60_000;
        // 0.2.4：落入 SQLite 的标题与目标做内联凭据脱敏；实际执行命令行仍取原始 objective 第一行。
        const safeTitle = redactSecrets(title);
        const safeObjective = redactSecrets(objective);
        // 先落库（queued），再推进状态——SQLite 同步事务，启动失败也留痕。
        // deadline 落 labels JSON 列（schema 不加列），sweep 从读回的 labels.deadlineAt 取。
        d.insertTask({
          id,
          conversationId,
          ownerSessionId,
          type: realType,
          title: safeTitle,
          objective: safeObjective,
          status: 'queued',
          currentStage: 'created',
          priority: 5,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          labels: { deadlineAt: String(deadlineAt), deadlineMinutes: String(LIMITS.timeoutMinutes) },
        });
        emitEvent(null, id, 'task.created', 'model', `type=${realType} title=${safeTitle} deadline=${LIMITS.timeoutMinutes}min`);
        const t = { id, conversationId, type: realType, title: safeTitle, objective: safeObjective, status: 'queued', nativeId: null, stage: 'created', deadlineAt };

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
          // cwd：会话工作目录（workingDirectory 是宿主的每会话目录真源）。
          // 取不到就如实拒绝——绝不落 DSH 进程目录。
          //
          // 必须用 ctx.get() 查询，不能用 ctx.workingDirectory 直取：
          // cordis 4.x 的 Proxy get trap 在属性不在 inject 白名单里时**直接抛错**
          // （`cannot get property "x" without inject`），抛在「取属性」这一步，
          // 光加 ?. 救不了 —— 而这句 catch 会把错吞掉，cwd 恒为 null，
          // 于是 job 在 0.2.2 上 100% 建不起来（2026-11-27 cwd 缺陷报告）。
          // 也不能往 inject 里加：加了 workingDirectory 会让整个插件不启动（报告 3.4 实测）。
          // 命令行 = objective 的第一行。
          // 首行为空必须先拦（0.2.2，审计 P1-2 残留）：objective 写成 "\nnpm test"
          // （前面带个换行）时 firstLine 是空串，spawn 一条空命令，
          // 子进程立刻退出、台账落 failed，而模型以为命令在跑。
          const firstLine = String(objective ?? '').split('\n', 1)[0].trim();
          if (!firstLine) {
            d.updateTaskFields(id, {
              status: 'failed',
              errorSummary: 'objective 第一行为空（job 类型要求第一行是可执行命令）',
              updatedAt: Date.now(),
              completedAt: Date.now(),
            });
            emitEvent(null, id, 'task.failed', 'coordinator', 'objective 第一行为空');
            return {
              ok: false,
              text: `建任务失败：objective 的第一行是空的。type=job 要求第一行必须是可执行命令`
                + `（比如 \`npm run build\`），注意别在命令前留空行或换行。（taskId=${id}）`,
            };
          }
          // 可选服务查询：取不到返回 undefined，不抛。
          const svc = (name) => {
            try {
              return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
            } catch { return undefined; }
          };
          let cwd = null;
          let cwdErr = null;
          let cwdFallback = false;
          try {
            // 四级兜底（2026-11-27 下游补丁反馈 §2）：
            // 在 0.2.2-rc.3 上 exec.agent 经常为空（同一条会话里时有时无），
            // 只试 exec.agent 会让同一句「帮我跑个构建」有时能建、有时拒建 ——
            // 对使用者就是随机失败。所以退到「能拿到就用，拿不到就标记着用进程目录」。
            const wd = svc('workingDirectory');
            // 第一级：调用上下文里的 agent
            // 第二级：按台账 ownerSessionId 从 agents 注册表捞
            const ag = exec?.agent ?? (ownerSessionId ? svc('agents')?.get?.(ownerSessionId) : null) ?? null;
            if (ag && wd && typeof wd.ensure === 'function') {
              cwd = await wd.ensure(ag, undefined) ?? null;
            }
            // 第三级：会话头里的 cwd（可能没有 sessions 服务，取不到就算了）
            if (!cwd && ownerSessionId) {
              const sessions = svc('sessions');
              const h = sessions?.get?.(ownerSessionId)?.header;
              if (typeof h?.cwd === 'string' && h.cwd) cwd = h.cwd;
            }
          } catch (e) { cwdErr = e; }
          if (!cwd) {
            // 第四级：退回宿主进程目录，但**打标记**，不假装拿到了会话目录。
            // 宁可跑在进程目录并标注，也不要随机拒建（反馈原话）。
            cwd = process.cwd();
            cwdFallback = true;
            log(`建任务 ${id}：拿不到会话 cwd${cwdErr ? `（${String(cwdErr.message).slice(0, 120)}）` : ''}，退回宿主进程目录 ${cwd}（cwdFallback=true）`);
          }
          // 落账：cwd 与是否退回过进程目录都要记下来，事后能分辨「这条任务跑在哪儿」。
          {
            const cur = d.getTask(id);
            d.updateTaskFields(id, {
              labels: {
                ...(cur?.labels ?? {}),
                cwd: String(cwd),
                ...(cwdFallback ? { cwdFallback: 'true' } : {}),
              },
              updatedAt: Date.now(),
            });
          }
          const wrapped = process.platform === 'win32'
            ? ['cmd.exe', '/d', '/s', '/c', firstLine]
            : ['bash', '-c', firstLine];
          // sandbox 对齐必须是 fail-closed：拿不到策略、confine 不可用、返回空 —— 一律拒绝，
          // 绝不放行裸执行（深度审计 P0-1）。
          // 取服务同样必须走 ctx.get()（同一原因：直取会抛 `without inject`）。
          let argv = null;
          // 是否让 Node 跳过参数引号转义。只有「我们自己拼的 cmd /d /s /c」那条分支该开；
          // 沙箱包装器给的 argv 绝不能开（见两处赋值处的注释）。
          let verbatim = false;
          // 沙箱要求的环境变量（sandbox.confine 的 env，可选）。
          // 0.2.3 起透传：只吃 argv 不吃 env 是半套隔离。
          let sandboxedEnv = null;
          try {
            // agent 兜底与 cwd 段一致：exec.agent 常为空，退到台账 ownerSessionId 捞。
            const ag = exec?.agent
              ?? (ownerSessionId ? svc('agents')?.get?.(ownerSessionId) : null)
              ?? null;
            const sbp = svc('sandboxPolicy');
            const sb = svc('sandbox');
            // sandboxPolicy.resolve(request = {}) 的 session 是**可选**的：
            // 宿主实现里「没有 session 就退回部署默认模式」
            // （原文注释：the configured root is the fallback for agentless calls
            //   and sessions without a cwd）。
            // 所以这里不能因为拿不到 agent 就拒建 —— 那正是「同一句话有时能建、
            // 有时拒建」的随机失败来源（2026-11-27 下游补丁反馈 §2）。
            const policy = (sbp && typeof sbp.resolve === 'function')
              ? await sbp.resolve(ag ? { session: ag.session } : {})
              : null;
            if (!policy) {
              const why = !sbp
                ? 'sandboxPolicy 服务不可用'
                : 'sandboxPolicy.resolve 无返回';
              d.updateTaskFields(id, { status: 'failed', errorSummary: `sandbox 策略不可解析: ${why}`, updatedAt: Date.now(), completedAt: Date.now() });
              return { ok: false, text: `建任务失败：拿不到本会话的沙箱策略（${why}），拒绝无沙箱执行。（taskId=${id}）` };
            }
            if (policy.mode === 'danger-full-access') {
              // 显式放行：直接用原始 argv，这是宿主明确允许的
              argv = wrapped;
              // 只有这条分支才需要 verbatim（见 spawn 处的解释）：
              // 这是我们自己拼的 `cmd.exe /d /s /c <原文>`，后面那一段必须原样交过去。
              verbatim = true;
            } else {
              if (typeof sb?.confine !== 'function') {
                d.updateTaskFields(id, { status: 'failed', errorSummary: 'sandbox.confine 不可用', updatedAt: Date.now(), completedAt: Date.now() });
                return { ok: false, text: `建任务失败：会话策略是 ${policy.mode} 但宿主没有 sandbox.confine，拒绝无沙箱执行。（taskId=${id}）` };
              }
              const sandboxed = await sb.confine(wrapped, policy);
              if (!Array.isArray(sandboxed?.argv) || !sandboxed.argv.length) {
                d.updateTaskFields(id, { status: 'failed', errorSummary: 'sandbox.confine 返回空 argv', updatedAt: Date.now(), completedAt: Date.now() });
                return { ok: false, text: `建任务失败：sandbox.confine 没有返回可用 argv，拒绝无沙箱执行。（taskId=${id}）` };
              }
              argv = sandboxed.argv.map(String);
              // 沙箱包装器的 argv 里常见 `C:\Program Files\...` 这种带空格的绝对路径，
              // 它**必须**走 Node 的正常引号转义，否则会被劈成多个参数（0.2.1 修）。
              verbatim = false;
              // 透传沙箱要求的环境变量（0.2.3，Gemini 补丁采纳）。
              // sandbox.confine() 的契约里可以带 env —— 那通常是沙箱自己设的隔离变量
              // （HOME/TMPDIR/PATH 重定向之类的）。只吃 argv 不吃 env 等于半套隔离：
              // 命令在沙箱里跑，但环境看着还是宿主那一套。
              // 注意合并方向：宿主环境作底、沙箱覆盖在上 —— 沙箱说的算。
              if (sandboxed.env && typeof sandboxed.env === 'object') {
                sandboxedEnv = sandboxed.env;
                log(`沙箱 env 透传 ${Object.keys(sandboxedEnv).length} 项`);
              }
            }
          } catch (e) {
            // 区分两类错误（2026-11-27 下游补丁反馈 §3）：
            //   「插件拿不到服务」和「宿主不许这个会话跑」对用户意义完全不同，
            //   混成一句「沙箱拒绝」会让人以为是自己的会话有问题。
            const msg = String(e?.message ?? e);
            const unavailable = /without inject|not registered|unknown service|is not a function/i.test(msg);
            const label = unavailable ? 'sandbox 服务不可用' : 'sandbox 拒绝';
            d.updateTaskFields(id, { status: 'failed', errorSummary: `${label}: ${msg.slice(0, 160)}`, updatedAt: Date.now(), completedAt: Date.now() });
            const hint = unavailable
              ? '插件侧拿不到 sandbox 服务（不是你的会话有问题）'
              : '当前会话沙箱策略不允许自由 shell';
            return { ok: false, text: `建任务失败：${label}（${msg.slice(0, 160)}）——${hint}。（taskId=${id}）` };
          }
          try {
          const jobId = registry.start({
              kind: 'bash',
              label: title,
              owner: ownerSessionId,
              run(job) {
                // 关键：用 argv（confine 后的结果），不是 parts。
                // 0.1.4–0.1.7 一直 spawn(parts...) —— confine 白算了，沙箱 100% 绕过（审计 P0-1）。
                // argv 里已经是完整命令行（如 ['cmd.exe','/d','/s','/c', 原文] 或 confine 给的形式），
                // 所以 shell 不能再开一层，否则会二次解析、把引号搞坏。
                const child = spawn(argv[0], argv.slice(1), {
                  shell: false,
                  windowsHide: true,
                  cwd,
                  // Windows 上 cmd.exe /d /s /c 后面那一段必须原样交过去（0.2.0）。
                  // 默认 Node 会按 CreateProcess 规则给每个参数加引号并转义内部引号，
                  // 而 cmd 在 /s 下又会剥一层 —— 两头一夹，objective 里本来正常的
                  // `node "C:\某目录\脚本.js"` 会被拼成字面引号：
                  //   Cannot find module 'C:\...\"C:\某目录\脚本.js"'
                  //
                  // **但只对 danger-full-access 那条分支生效**（0.2.1 修，审计 #6）：
                  // sandbox.confine 返回的 argv 里常有 `C:\Program Files\...` 这类带空格路径，
                  // 跳过转义会把它们劈成多个错误参数。所以按 argv 的来源决定，不无条件开。
                  windowsVerbatimArguments: process.platform === 'win32' && verbatim,
                  // 0.2.4：对齐 DSH 原生 scrubbedParentEnv()，过滤宿主凭据类环境变量（KEY/PASSWORD/SECRET/TOKEN/CREDENTIAL）
                  // 与 DSH_* 内部变量；不再把未过滤的完整 process.env 继承或铺底到子进程中。
                  // 若 sandbox.confine 返回了显式 env，则叠加在已过滤的父环境之上。
                  env: sandboxedEnv ? { ...scrubbedParentEnv(), ...sandboxedEnv } : scrubbedParentEnv(),
                  // 非 Windows 上让子进程自成一个进程组，cancel 时才能整组杀干净；
                  // Windows 用 taskkill /T 走进程树，不需要这个。
                  detached: process.platform !== 'win32',
                });
                // 异步 error 不接住会把整个宿主进程打崩（audit P1-2）：cwd 被删、权限不足、
                // 进程数上限都会走这条。接住并当成失败结算，别让它冒到 EventEmitter。
                child.on('error', (e) => {
                  try { job.append(`\n[coordinator] spawn 失败：${String(e).slice(0, 200)}\n`, { channel: 'stderr' }); } catch { /* 推不进也不影响结算 */ }
                  try { job.updateProgress('启动失败'); } catch { /* 注册表无此方法 */ }
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
                    const s = decodeOut(d2);
                    if (s) { job.append(s, { channel: 'stdout' }); bump(); }
                  });
                }
                if (child.stderr) {
                  child.stderr.on('data', (d2) => {
                    const s = decodeErr(d2);
                    if (s) { job.append(s, { channel: 'stderr' }); bump(); }
                  });
                }
                return {
                  cancel() {
                    // 必须连子孙一起杀：只杀父 shell 的话，它下面的真进程会变孤儿继续跑，
                    // 台账标了 cancelled、进程还在（审计 P1-2 ③）。
                    //
                    // 用异步 spawn 而不是 execSync（0.2.2，审计 P1-2 残留）：
                    // execSync 会**阻塞宿主事件循环**，杀一棵大进程树能卡住几百毫秒，
                    // 期间整个 DSH 都不响应 —— 这是在一个「取消」动作上阻塞前台。
                    // 换成 spawn + 不管它，杀进程本来也不需要在当前栈上等结果。
                    try {
                      if (!child.pid) return;
                      if (process.platform === 'win32') {
                        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
                          windowsHide: true,
                          stdio: 'ignore',
                          env: scrubbedParentEnv(),
                          // 这里是独立调用，没有引号拼接，让 Node 正常转义即可
                          windowsVerbatimArguments: false,
                        });
                        // 杀进程助手自己失败也不影响：子进程可能已经退出。
                        killer.on('error', () => { /* 忽略 */ });
                        if (typeof killer.unref === 'function') killer.unref();
                      } else {
                        // 非 Windows：spawn 时用了 detached，子进程自成进程组，
                        // 负 pid 就是整组（包括孙进程）。
                        try { process.kill(-child.pid, 'SIGKILL'); }
                        catch { child.kill('SIGKILL'); }  // 没有独立进程组就退化为杀单个
                      }
                    } catch { /* 已退出 */ }
                  },
                  done: new Promise((resolve) => {
                    // spawn 失败时 close 不一定触发（进程根本没起来），done 会永久悬空。
                    // 监听 error 单独收口，避免任务永远卡在 running（审计 P1-2）。
                    child.on('error', (e) => {
                      resolve({ status: 'failed', detail: `spawn error: ${String(e).slice(0, 180)}` });
                    });
                    // close 第二参是 signal：被信号杀掉时 code 为 null，光看 code 会误报
                    // 「exit null」。把 signal 一起写进 detail（审计 P1-2 ②）。
                    child.on('close', (code, signal) => {
                      // 先冲解码器尾巴（不完整的多字节序列 / 判定前残留的缓冲），
                      // 否则最后一行会缺字（审计 P2-6 的一部分）。
                      for (const [dec, ch] of [[decodeOut, 'stdout'], [decodeErr, 'stderr']]) {
                        try {
                          const tail = dec.end?.();
                          if (tail) job.append(tail, { channel: ch });
                        } catch { /* 尾巴冲不出来就丢，不影响结算 */ }
                      }
                      if (signal) {
                        resolve({ status: 'failed', detail: `killed by ${signal}` });
                        return;
                      }
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
            // currentStage 必须一起推进（0.2.1，审计 P3 项）：
            // 0.2.0 只写了 status='running'，阶段还停在 'creating-executor' ——
            // task_describe 里那句「阶段：xxx」会一直报一个早就过去的阶段。
            d.updateTaskFields(id, { status: 'running', currentStage: 'running', nativeId: t.nativeId, updatedAt: Date.now() });
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
      async execute(args, exec) {
        const d = db();
        // 只列自己的（审计 P0-3）：拿不到调用者身份时按原样全列（历史兼容）。
        const caller = callerSessionId(exec);
        // 兜底探活：**只有 task_list 会写台账**（2026-11-27 issue #1 A1 ——
        // describe 曾也调它，但那是只读工具写终态，会把瞬时查不到的活任务打死）。
        // 0.2.2 起 subagent 和 job 两侧都扫：job 的结算事件在部分宿主上根本不存在，
        // 不主动问一次就会永远停在 running（审计 P2-8）。
        // 0.2.3：传 caller 做归属隔离，只探活自己的任务，不改别人的状态（Gemini 补丁采纳）。
        const { swept, suspects } = sweepOnce(d, caller);
        if (swept) log(`探活兜底：${swept} 条 subagent 任务原生已回收，补落 lost`);
        const sweptJobs = sweepJobsOnce(d, caller);
        if (sweptJobs) log(`job 探活：${sweptJobs} 条已按原生状态补账`);
        const visible = (t) => {
          if (!caller) return true;
          const owner = t.ownerSessionId ? String(t.ownerSessionId) : null;
          return !owner || owner === caller;
        };
        // 活动任务走 listActive（索引），终态按「最近 50 条」直接取窗口。
        // 0.2.0 之前是 listTasks({limit:500}) + 内存过滤排序：任务超过 500 条后
        // 活跃任务会掉出窗口，`task_list` 反而看不见在跑的东西（审计 P1-4）。
        // 0.2.3：listRecent 传 caller —— 以前不传，别的会话新建 50 条就会把
        // 当前会话的历史视图挤空（我自己在 0.2.1 文档里记的那条残留）。
        const wantAll = Boolean(args?.all);
        const pool = wantAll
          ? d.listActive([...ACTIVE]).concat(d.listRecent(50, caller ?? undefined))
          : d.listActive([...ACTIVE]);
        const seen = new Set();
        const rows = [];
        for (const t of pool) {
          if (seen.has(t.id)) continue;
          if (!visible(t)) continue;
          if (!wantAll && !ACTIVE.has(t.status)) continue;
          seen.add(t.id);
          rows.push(t);
          if (rows.length >= 50) break;
        }
        // suspects 要如实报（0.2.3）：探活阈值是两轮，用户得知道
        // 「有条第一次没命中、再查一次才落终态」，而不是看到一个不透明的延迟。
        const suspectNote = suspects
          ? `（另有 ${suspects} 条 subagent 首次探活未命中；再 task_list 一次仍不命中将落 lost）`
          : '';
        if (!rows.length) {
          const prefix = [];
          if (swept) prefix.push(`（本轮探活补落 ${swept} 条 lost）`);
          if (suspectNote) prefix.push(suspectNote);
          return { ok: true, text: prefix.length ? `${prefix.join('\n')}\n（无任务）` : '（无任务）' };
        }
        const lines = rows.map((t) =>
          `${t.id}  [${t.status}]  ${t.title}  (${t.type}${t.nativeId ? `/${t.nativeId}` : ''})  ${new Date(t.createdAt).toLocaleString()}`,
        );
        // 0.2.4 修：有 suspect 时该任务仍在 ACTIVE，必然走 rows.length > 0 分支，
        // 之前漏了把 suspectNote 插进输出，导致提示文案永远不可达。
        if (suspectNote) lines.unshift(suspectNote);
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
      async execute(args, exec) {
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
        // 归属校验（审计 P0-3）：别人的任务不给看。返回同一句话，不泄露它存在与否。
        const own = ownedBy(row, exec);
        if (!own.ok) return { ok: false, text: `任务不存在：${args?.taskId}` };
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
          if (!t.nativeSessionId) {
            // 0.2.4：未解析出真 session id 时不拿 agent 名查 ctx.agents，避免误报「可能已回收」。
            lines.push('原生 agent：未解析出会话 id（无法按 session id 探活）');
          } else {
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
        // 0.2.4 彻底落齐 ownedBy 契约：只传真实调用者 own.caller，拿不到身份时传 undefined，
        // 绝不再回退用 row.ownerSessionId 冒充 owner 穿透 0.2.2 围栏。
        const caller = own.caller ?? undefined;
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
        // 终态不可逆（2026-11-27 审计 P1-5 ②）：以前对已 succeeded/failed/cancelled/lost
        // 的任务再调一次，会把它直接改回 running，同时留着旧的 completed_at ——
        // 台账从此自相矛盾（状态 running 但有完成时间），还会重新占住配额。
        if (TERMINAL.has(row.status)) {
          return { ok: false, text: `任务已终态（${row.status}），不能再登记委派。要续跑请新建任务。` };
        }
        // 归属校验（0.2.1，审计 P0-3 回归项）：0.2.0 漏了这一条。
        // 后果比看起来严重：任何会话只要知道 taskId，就能把**别人的**任务绑到自己的
        // 子代理上，而绑定后的 pending 补投会把别人排队的指令原样投进我的 agent
        // —— 等于跨会话窃取指令。所有读写台账的工具都必须过这一关。
        const own = ownedBy(row, exec);
        if (!own.ok) return { ok: false, text: `任务不存在：${args?.taskId}` };
        const agentName = String(args?.agentId ?? '').trim();
        if (!agentName) return { ok: false, text: 'agentId 不能为空（原生 subagent 工具返回的 agent 名）' };
        // 禁止对已绑定的活动任务二次覆盖登记（0.2.3，Gemini 补丁采纳）。
        // 后果不只是台账被改：换一个 agent 就等于把这个任务绑到别处，
        // 之后的 followup / 结算 / 取消全落到新目标上，原来那个还在跑。
        // 例外：同一个 agent 名、但上次没解析出 session id —— 那是「补全」，允许。
        if (row.nativeId && (row.status === 'running' || row.status === 'cancel_requested')) {
          const canBackfill = row.nativeId === agentName && !row.nativeSessionId;
          if (!canBackfill) {
            return {
              ok: false,
              text: `任务已绑定到 agent ${row.nativeId}`
                + `${row.nativeSessionId ? `（会话 ${row.nativeSessionId}）` : ''}，不能重复覆盖登记。`
                + `要换目标请新建任务。`,
            };
          }
        }
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
        // 0.2.4：首次绑定强校验子代理归属（父子关系），阻止共享 profile 下把别人的子代理 sessionId 绑到自己的任务上。
        const binding = await resolveSubagentBinding(
          ctx,
          agentName,
          caller,
          String(args?.sessionId ?? ''),
        );
        if (binding.rejected) {
          return { ok: false, text: `拒绝绑定：${binding.reason}。` };
        }
        const realSid = binding.sid;
        if (realSid) {
          // 额外防线：即便宿主没有 subagents 枚举服务，也不允许把已归属其他会话的 nativeSessionId 绑到当前任务。
          const conflict = d.findTaskByNativeSessionOtherOwner(realSid, row.ownerSessionId);
          if (conflict) {
            return {
              ok: false,
              text: `拒绝绑定：会话 ${realSid} 已归属其他会话的任务，禁止跨会话绑定。`,
            };
          }
        }
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

        // ---- 回放「早到的结算」（0.2.2，审计 P2-3）----
        // 子代理可能在登记之前就跑完了：那一刻 task_register_delegation 还没写 nativeSessionId，
        // subagent/end 匹配不上、被缓存起来。现在绑定好了，把那条补上。
        //
        // 这是 Mode B 的固有竞态，不是异常路径：短任务（"回两个字"这种）几乎必中。
        // 不回放的话任务会一直 running，等一个已经发生过的事件。
        let replayText = '';
        if (realSid) {
          const early = earlyEnds.get(String(realSid));
          if (early) {
            earlyEnds.delete(String(realSid));
            // 重读一次拿最新行（上面的 updateTaskFields 刚写过）
            const fresh = d.getTask(tid);
            const rawReason = String(
              early.info?.stopReason ?? early.info?.status ?? early.info?.reason ?? early.info?.outcome ?? '',
            );
            const st = settleFromSubagentEnd(d, toTaskHandle(fresh), rawReason);
            replayText = `\n注意：这个子代理在登记之前就已经结束了（subagent/end 早到），`
              + `已按早到的结束事件直接落 ${st}。`;
            log(`早到结算回放：${tid} → ${st}`);
          }
        }

        // ---- 绑定后补投 pending 指令（0.2.0，审计 P1-5 ①）----
        // 以前 task_append_message 在没绑定时落一条 pending 并承诺「绑定后补投」，
        // 但这里根本没有 flush 逻辑 —— 消息永久卡在 pending，而且内容哈希幂等键
        // 还会让用户重发同样的指令时被「已是 pending，未重复投递」挡回去。
        // 现在绑定成功后立刻把 pending 全投一遍，投不出去的如实改成 undeliverable。
        //
        // 0.2.4：如果上面的早到结算回放已经把任务落了终态，绝不能再对已结束的子代理调
        // followup/steer（那会把已结束的 session 重新唤醒）；改为把绑定前排队的 pending
        // 统一标为 cancelled 并说明。
        const flushLines = [];
        let flushed = 0;
        try {
          const pend = d.listPendingMessages(tid);
          if (pend.length) {
            if (replayText) {
              for (const m of pend) {
                d.updateMessage(m.messageId, {
                  status: 'cancelled',
                  content: redactSecrets(m.content).slice(0, 500),
                  reason: '任务在绑定前已结束（subagent/end 早到），取消待补投指令',
                });
                emitEvent(null, tid, 'task.message_cancelled', 'coordinator', `早到结算取消补投 ${m.messageId}`);
              }
              flushLines.push(`  任务绑定前已结束，已取消 ${pend.length} 条绑定前排队的待补投指令（未唤醒已结束的子代理）。`);
            } else {
              // 0.2.4：只有拿到真 sessionId 才查句柄，不再拿 agentName 去碰按 sessionId 索引的注册表
              const ag = realSid ? getAgentHandle(ctx, { nativeId: agentName, nativeSessionId: realSid }) : undefined;
              for (const m of pend) {
                if (!ag) {
                  // 绑定成功但 agent 还拿不到句柄（未解析出 sessionId / 宿主注册表滞后 / 没有 agents 服务）：
                  // 别把 pending 改成失败，留着下一轮；但不假装投出去了。
                  flushLines.push(`  补投未完成：${m.messageId}（${realSid ? '拿不到 agent 句柄' : '未解析出会话 id'}，仍记为 pending）`);
                  continue;
                }
                try {
                  const message = {
                    id: randomUUID(),
                    role: 'user',
                    content: [{ type: 'text', text: m.content }],
                    source: { kind: 'user' },
                  };
                  if (typeof ag.followup === 'function') ag.followup(message);
                  else if (typeof ag.steer === 'function') ag.steer(message);
                  else throw new Error('这个 agent 没有 followup/steer');
                  // 0.2.4：补投完成后对库内留痕脱敏，避免长期保存明文凭据。
                  d.updateMessage(m.messageId, {
                    status: 'delivered',
                    channel: 'agent-inbox-flush',
                    content: redactSecrets(m.content).slice(0, 500),
                    deliveredAt: Date.now(),
                  });
                  emitEvent(null, tid, 'task.message_flushed', 'coordinator', `补投 ${m.messageId}`);
                  flushed += 1;
                } catch (e) {
                  d.updateMessage(m.messageId, {
                    status: 'undeliverable',
                    content: redactSecrets(m.content).slice(0, 500),
                    reason: `补投失败: ${String(e).slice(0, 120)}`,
                  });
                  emitEvent(null, tid, 'task.message_failed', 'coordinator', `补投失败 ${m.messageId}`);
                  flushLines.push(`  补投失败：${m.messageId}（${String(e).slice(0, 80)}）`);
                }
              }
              if (flushed) flushLines.unshift(`  已补投 ${flushed} 条绑定前排队的指令。`);
            }
          }
        } catch (e) {
          flushLines.push(`  补投过程出错（pending 保留）：${String(e).slice(0, 100)}`);
        }

        const tail = realSid
          ? `已解析到会话 ${realSid}，结算会由 subagent/end 自动落账。`
          : '没能解析出会话 id（原生工具不返回、按名字反查也落空）：结算不靠事件，'
            + '会在 task_list 时按探活兜底落 lost；要确定状态请显式 task_cancel。';
        const flushText = flushLines.length ? `\n${flushLines.join('\n')}` : '';
        // 早到结算回放过的话，状态已经不是 running 了 —— 返回文案必须跟着改口，
        // 不能嘴上说「任务进入 running」而库里已经是 succeeded（那是最典型的假汇报）。
        const head = replayText
          ? `已绑定：task ${tid} ↔ agent ${agentName}。`
          : `已绑定：task ${tid} ↔ agent ${agentName}，任务进入 running。`;
        return { ok: true, text: `${head}\n${tail}${flushText}${replayText}` };
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
      async execute(args, exec) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        // 归属校验（审计 P0-3）：不能往别人的子代理里注入指令。
        const own = ownedBy(row, exec);
        if (!own.ok) return { ok: false, text: `任务不存在：${args?.taskId}` };
        // 终态任务不投递（审计 P2-4）：可续聊子代理可能还驻留内存，
        // followup 会把它唤醒跑新一轮，而台账停在 succeeded，两边对不上。
        if (TERMINAL.has(row.status)) {
          return { ok: false, text: `任务已终态（${row.status}），不再投递指令。要续跑请新建任务。` };
        }
        const content = String(args?.content ?? '');
        if (!content.trim()) return { ok: false, text: '指令内容为空' };
        // 0.2.4：落库与事件留痕走脱敏副本；实际投递到 ag.followup / ag.steer 仍用原始 content。
        const safeContent = redactSecrets(content);
        const mode = args?.mode === 'next-step' ? 'next-step' : 'next-turn';
        const idem = String(args?.idempotencyKey ?? '').slice(0, 128);
        const mid = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const t = toTaskHandle(row);

        // 幂等键去重（任务书表 7 / 11.1）：显式键或自动键（内容哈希）命中即不再投。
        //
        // 0.2.0 的判据变了（审计 P1-5 ① / P1-7）：
        //   以前只要命中就挡，包括 pending 和 undeliverable ——
        //   于是「绑定时排队的那条」和「上次没投出去的那条」会把后续重试永久锁死：
        //   用户重发同样的指令、或绑定好之后再发一次，永远被回「已是 pending，未重复投递」。
        //   只有 delivered / cancelled 才算真正发生过、不该再投；
        //   pending / undeliverable 是「还没成」的状态，应该允许重试。
        const autoKey = `msg:${tid}:user:${fnv1a(content)}`;
        const checkKey = idem || autoKey;
        const prior = d.listMessages(tid).filter((m) => m.idempotencyKey === checkKey);
        const settled = prior.find((m) => m.status === 'delivered' || m.status === 'cancelled');
        if (settled) {
          return { ok: settled.status === 'delivered', text: `幂等命中：指令 ${settled.messageId} 已是 ${settled.status}，本次未重复投递。（idempotencyKey=${checkKey}）` };
        }
        // 没成的那条：这次要真投，就得先腾出同一个 (task_id, key) 的位置。
        // 为什么是删而不是改成 cancelled：幂等键在库里是联合唯一，同一 key 只允许一行 ——
        // 留着旧的（哪怕状态已改）照样会撞索引，结果是 INSERT 静默失败、消息投出去了但库里没记录。
        //
        // **但删的时机很关键**（0.2.1，审计 #1 的连带问题）：
        // 0.2.0 是「进门就删」，然后才去探活。一旦探活抛异常或后续任何一步失败，
        // 那条旧记录已经没了、新的也没写进去 —— 消息凭空消失。
        // 改成把删除封装成 mustPurge()，只在**确定要写新行之前**调用，
        // 探活这类可能失败的动作全部排在它前面。
        let purged = false;
        const mustPurge = () => {
          if (purged) return;
          purged = true;
          for (const m of prior) {
            try { d.deleteMessage(m.messageId); } catch { /* 单条失败不阻塞本次投递 */ }
          }
        };

        if (t.type === 'job') {
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: safeContent.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: 'job 无 stdin（原生契约）',
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `undeliverable: ${safeContent.slice(0, 80)}`);
          return { ok: false, text: `未投递：background job 不支持 stdin 追加（原生契约如此，不伪装）。指令已记录（${mid}），可排队为任务后续步骤或转交所属 subagent。` };
        }
        if (!t.nativeId) {
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            // pending 的正文必须**完整**存（0.2.1，审计 P1-5）：
            // 这条是要在绑定后补投给 agent 的，截到 500 字就等于把指令砍半投出去。
            // 上限放宽到 16000（远超任何正常指令），只是防超大 payload 撑爆库。
            // 绑定补投完成或取消后会立即覆写为脱敏副本（见 task_register_delegation / task_cancel）。
            content: content.slice(0, 16000),
            idempotencyKey: checkKey,
            status: 'pending',
            channel: 'none',
            reason: '任务尚未绑定 subagent',
            createdAt: Date.now(),
          });
          return { ok: false, text: '任务尚未绑定 subagent（先 task_register_delegation）。指令已登记为 pending，绑定后补投。' };
        }
        // 真实投递：ctx.agents.get(sessionId) 拿活着的 agent，调 followup / steer。
        // ctx.agents 只按 session id 索引 —— 0.2.4：nativeSessionId 为空时直接如实记 undeliverable，
        // 不拿 agent 名字去碰按 session id 索引的注册表（避免把「未解析出会话 id」误报成「agent 已结束」）。
        if (!t.nativeSessionId) {
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: safeContent.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: '未解析到子代理会话 id（nativeSessionId 为空），无法按 session id 投递',
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `undeliverable(no-session-id): ${safeContent.slice(0, 80)}`);
          return { ok: false, text: `未投递：agent ${t.nativeId} 未解析出会话 id，无法按 session id 投递。指令已记录（${mid}）。` };
        }
        // 必须接住异常（0.2.1，审计 #1）：0.1.10 起 getAgentHandle 会让 agents.get 的异常
        // 冒出来。这里不接的话工具直接崩，而且崩在上一步「删掉旧 pending 行」之后 ——
        // 那条消息就既没投出去也没留记录，凭空消失。
        let ag = null;
        let probeErr = null;
        try {
          ag = getAgentHandle(ctx, t);
        } catch (e) {
          probeErr = e;
        }
        if (probeErr) {
          // 探活本身失败 ≠ agent 不在。如实记成「这次没探成」，状态留 pending 让下次可重试，
          // 不能标 undeliverable（那会把一条可能投得出去的消息判死）。
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: content.slice(0, 16000),
            idempotencyKey: checkKey,
            status: 'pending',
            channel: 'none',
            reason: `探活失败: ${String(probeErr?.message ?? probeErr).slice(0, 140)}`,
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `probe-failed: ${safeContent.slice(0, 60)}`);
          return { ok: false, text: `未投递：查询 agent ${t.nativeId} 时出错（${String(probeErr?.message ?? probeErr).slice(0, 140)}）。指令已留为 pending，稍后重试或再调一次。` };
        }
        if (!ag) {
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: safeContent.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: 'agent 已结束或不可达（原生 agents.get 查不到）',
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `undeliverable: ${safeContent.slice(0, 80)}`);
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
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: safeContent.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'delivered',
            channel: mode === 'next-step' ? 'agent-inbox-next-step' : 'agent-inbox-next-turn',
            createdAt: Date.now(),
            deliveredAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `delivered(${mode}): ${safeContent.slice(0, 80)}`);
          const sid = t.nativeSessionId || t.nativeId;
          return { ok: true, text: `已投递到 agent ${t.nativeId}${t.nativeSessionId ? `（会话 ${sid}）` : ''}（${mid}，mode=${mode}）。busy 时进收件箱，下一可接收时机处理，不打断当前工具调用。` };
        } catch (e) {
          mustPurge();
          d.insertMessage({
            messageId: mid,
            taskId: tid,
            sender: 'user',
            content: safeContent.slice(0, 500),
            idempotencyKey: checkKey,
            status: 'undeliverable',
            channel: 'none',
            reason: String(e).slice(0, 160),
            createdAt: Date.now(),
          });
          emitEvent(null, tid, 'task.message_appended', 'model', `failed: ${safeContent.slice(0, 80)}`);
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
      async execute(args, exec) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        // 归属校验（审计 P0-3）：不能杀别人的任务。
        const own = ownedBy(row, exec);
        if (!own.ok) return { ok: false, text: `任务不存在：${args?.taskId}` };
        if (TERMINAL.has(row.status)) return { ok: false, text: `任务已终态（${row.status}），无需取消` };
        if (row.status === 'cancel_requested') {
          return { ok: true, text: `取消已请求过（task ${tid}），等执行器确认，别重复发。` };
        }
        const t = toTaskHandle(row);
        const reason = redactSecrets(String(args?.reason ?? '用户取消')).slice(0, 200);
        // 0.2.4：任务终态取消时顺带把库内残留的 pending 消息标为 cancelled 并脱敏，避免留明文。
        const scrubPendingOnCancel = () => {
          try {
            for (const m of d.listPendingMessages(tid)) {
              d.updateMessage(m.messageId, {
                status: 'cancelled',
                content: redactSecrets(m.content).slice(0, 500),
                reason: '任务已取消，清理待补投指令',
              });
            }
          } catch { /* 清理失败不阻塞取消 */ }
        };
        let nativeOk = null;
        let jobKillCaller = undefined;
        let jobKillReceipt = undefined;
        let jobKillCalled = false;
        try {
          if (t.type === 'job' && ctx.jobs?.kill) {
            // caller 必须是**真实的调用者**，不能用台账里的 ownerSessionId 冒充 ——
            // 0.2.4：与 ownedBy「拿不到 caller 放行但不冒充」以及 task_describe 一致，
            // 绝不再回退 own.owner 穿透 0.2.2 assertAccess 围栏。
            jobKillCaller = own.caller ?? undefined;
            // 0.2.4：读取 DSH 原生 jobs.kill 的回执（'requested' | 'already-finished' | ...），
            // 不再忽略回执直接把还在 stopping 的后台作业写成「已取消」。
            jobKillReceipt = ctx.jobs.kill(t.nativeId, jobKillCaller, reason);
            jobKillCalled = true;
            const rLabel = typeof jobKillReceipt === 'string'
              ? jobKillReceipt
              : (jobKillReceipt && typeof jobKillReceipt === 'object' && jobKillReceipt.status ? String(jobKillReceipt.status) : '');
            nativeOk = rLabel ? `jobs.kill (${rLabel})` : 'jobs.kill';
          } else if (t.type === 'subagent') {
            // 真的去中断它，不是只写一句字符串（审计 P1-3）。
            //
            // 判据必须是「有真 session id 才探活」（2026-11-27 下游补丁反馈 §4 的坑）：
            // getAgentHandle 内部是 `nativeSessionId || nativeId`，nativeSessionId 为 null 时
            // 会拿 **agent 名字**去查按 session id 索引的注册表 → 恒空 →
            // 把还活着的 subagent 判成已回收、直接落 cancelled。那是误杀。
            const hasRealId = !!t.nativeSessionId;
            // 探活异常要接住（0.2.1，审计 #1）：getAgentHandle 会抛，
            // 这里不接就整个工具崩，取消动作一个都没做。
            let ag;
            let probeErr = null;
            if (hasRealId) {
              try {
                ag = getAgentHandle(ctx, t);
              } catch (e) {
                probeErr = e;
              }
            }
            if (probeErr) {
              // 探活失败 = 不知道死活。不能落 cancelled（那是编造），也不是「没绑定」。
              // 记 cancel_requested，交给重启对账 / 超时清账收尾，并如实说明。
              nativeOk = `探活失败（${String(probeErr?.message ?? probeErr).slice(0, 80)}），未能确认原生状态`;
            } else if (ag && typeof ag.cancel === 'function') {
              // keepInbox: false（0.2.3，Gemini 补丁采纳）。
              // 0.2.2 传的是 true —— 那是「暂停」语义：队列留着，之后还能继续。
              // 而 task_cancel 是**取消**：用户说不干了，就不该把排队中的指令留着。
              // 这个区别在真机上不一定看得出（多数 agent 取消后不会再消费队列），
              // 但语义必须对：留队列 = 未来可能被 followup 唤醒继续跑。
              ag.cancel({ kind: 'user' }, { keepInbox: false });
              nativeOk = 'agent.cancel';
            } else if (ag) {
              // agent 句柄没暴露 cancel → 退到 subagents.interruptByParent（0.2.3 补）。
              // 这个方法是 cordis inspect 实测存在的，签名：
              //   interruptByParent(childSessionId, parentSessionId, mode: 'continuable')
              // 本机 0.2.1-rc.4 上 mode 只有 'continuable' 一个取值，所以照传。
              // 注意它是同步返回 receipt 的，不是 async —— 但 await 一个非 Promise 也无害，
              // 而另一版要是改成 async 也照样能用，所以这里统一 await。
              const subSvc = (() => {
                try { return typeof ctx.get === 'function' ? ctx.get('subagents') : undefined; } catch { return undefined; }
              })();
              if (typeof subSvc?.interruptByParent === 'function') {
                try {
                  await subSvc.interruptByParent(
                    t.nativeSessionId,
                    // 0.2.4：toTaskHandle(row) 不含 ownerSessionId，之前 t.ownerSessionId 恒为 undefined；
                    // 改用 row.ownerSessionId（父会话 id）作为回退。
                    own.caller ?? row.ownerSessionId ?? undefined,
                    'continuable',
                  );
                  nativeOk = 'subagents.interruptByParent';
                } catch (e) {
                  nativeOk = `interruptByParent 失败: ${String(e?.message ?? e).slice(0, 100)}`;
                }
              } else {
                nativeOk = 'agent 无 cancel 方法，等 subagent/end 确认';
              }
            } else if (!hasRealId && !t.nativeId) {
              // **从未绑定**（连 agent 名都没有）：没有任何原生执行单元可中断，
              // 也没有会到来的 subagent/end —— 以前这里被 `!hasRealId` 抢走，
              // 结果一个从没登记过的 queued 子代理点取消反而被锁进 cancel_requested
              // 永不落地（0.2.1，审计 #2）。这种直接收尾，事实清楚：它从来没跑起来过。
              scrubPendingOnCancel();
              d.updateTaskFields(tid, {
                status: 'cancelled',
                currentStage: 'cancelled',
                errorSummary: `${reason}（从未绑定原生执行单元，直接收尾）`,
                updatedAt: Date.now(),
                completedAt: Date.now(),
              });
              emitEvent(null, tid, 'task.cancelled', 'user', reason);
              settleNotification(null, { id: tid, status: 'cancelled' });
              return { ok: true, text: `task ${tid} 已取消（从未绑定子代理，无需中断）。` };
            } else if (!hasRealId) {
              // 有 agent 名字但反查不出会话 id：探不了死活的**已绑定**任务。
              // 记 cancel_requested，交给重启对账 / 超时清账收尾，
              // 并在文案里说清楚「没探活，别以为已经停了」。
              nativeOk = '未解析出会话 id，未探活（无法确认原生状态）';
            } else {
              // 已绑定 + 有真 id + 探活成功但查不到 = 原生已回收。
              // 没有可中断的对象，直接落终态，别留僵尸（审计 P0-2）。
              scrubPendingOnCancel();
              d.updateTaskFields(tid, {
                status: 'cancelled',
                currentStage: 'cancelled',
                errorSummary: `${reason}（原生 agent 已不在，直接收尾）`,
                updatedAt: Date.now(),
                completedAt: Date.now(),
              });
              emitEvent(null, tid, 'task.cancelled', 'user', reason);
              settleNotification(null, { id: tid, status: 'cancelled' });
              return { ok: true, text: `task ${tid} 已取消（原生 agent 已不在，无需中断）。` };
            }
          } else {
            // job 但宿主没有 kill：没有能中断的执行器，直接收尾。
            d.updateTaskFields(tid, {
              status: 'cancelled',
              currentStage: 'cancelled',
              errorSummary: `${reason}（宿主无 jobs.kill，直接收尾）`,
              updatedAt: Date.now(),
              completedAt: Date.now(),
            });
            emitEvent(null, tid, 'task.cancelled', 'user', reason);
            settleNotification(null, { id: tid, status: 'cancelled' });
            return { ok: true, text: `task ${tid} 已取消（宿主无 jobs.kill）。` };
          }
        } catch (e) {
          nativeOk = `cancel 调用失败: ${String(e).slice(0, 160)}`;
        }
        // 0.2.4：DSH 的 jobs.kill(id, caller, reason) 返回 'requested' | 'already-finished'：
        //   - 'requested' / 'stopping' 表示已下发停止请求，进程可能仍在退出中 → 必须落 cancel_requested，
        //     等原生 jobs.events settled（或探活）确认终态，绝不提前告诉用户「已取消」；
        //   - 若 kill 在同调用栈内已同步触发 settled 回调，重读台账已是终态则直接沿用，不重复写；
        //   - 'already-finished' 或无回执且 jobs.get 确认已终态/不存在，才直接落对应终态。
        if (t.type === 'job' && jobKillCalled) {
          const cur = d.getTask(tid);
          if (cur && TERMINAL.has(cur.status)) {
            t.status = cur.status;
          } else {
            const rNorm = (typeof jobKillReceipt === 'string'
              ? jobKillReceipt
              : String(jobKillReceipt?.status ?? '')).trim().toLowerCase();
            const mapJobTerm = (s) => {
              const v = String(s ?? '').toLowerCase();
              if (v === 'completed') return 'succeeded';
              if (v === 'failed') return 'failed';
              if (v === 'killed' || v === 'cancelled') return 'cancelled';
              return null;
            };
            let settledTerminal = null;
            let settledDetail = null;
            if (rNorm === 'requested' || rNorm === 'stopping') {
              // 明确只是「已请求停止」：保持 cancel_requested，等原生 settled 确认
              settledTerminal = null;
            } else {
              // 'already-finished' / 'killed' / 'not-found' 或无回执：再查一次 jobs.get 核实真实状态
              let view = undefined;
              let probed = false;
              if (typeof ctx.jobs?.get === 'function') {
                try {
                  view = ctx.jobs.get(t.nativeId, jobKillCaller);
                  probed = true;
                } catch { /* 查不动则保守按 cancel_requested 处理 */ }
              }
              if (probed && view) {
                const vt = mapJobTerm(view.status);
                if (vt) {
                  settledTerminal = vt;
                  settledDetail = view.detail;
                } else {
                  // 原生仍明确报 running / stopping：不能谎报已取消
                  nativeOk = `${nativeOk}（原生仍为 ${view.status}）`;
                  settledTerminal = null;
                }
              } else if (probed && !view) {
                // 注册表里已不存在该作业：确认终态
                settledTerminal = 'cancelled';
              } else if (rNorm === 'already-finished' || rNorm === 'finished' || rNorm === 'not-found' || rNorm === 'killed' || rNorm === 'cancelled') {
                settledTerminal = 'cancelled';
              }
            }
            if (settledTerminal) {
              d.updateTaskFields(tid, {
                status: settledTerminal,
                currentStage: settledTerminal === 'cancelled' ? 'cancelled' : 'settled',
                resultSummary: settledTerminal === 'succeeded' ? String(settledDetail ?? '作业已结束').slice(0, 300) : undefined,
                errorSummary: settledTerminal !== 'succeeded' ? String(settledDetail ?? reason).slice(0, 300) : undefined,
                updatedAt: Date.now(),
                completedAt: Date.now(),
              });
              emitEvent(
                null,
                tid,
                settledTerminal === 'succeeded' ? 'task.succeeded' : settledTerminal === 'failed' ? 'task.failed' : 'task.cancelled',
                'user',
                settledTerminal === 'cancelled' ? reason : String(settledDetail ?? settledTerminal).slice(0, 200),
              );
              settleNotification(null, { id: tid, status: settledTerminal });
              t.status = settledTerminal;
            } else {
              d.updateTaskFields(tid, { status: 'cancel_requested', currentStage: 'cancelling', errorSummary: reason, updatedAt: Date.now() });
              emitEvent(null, tid, 'task.cancel_requested', 'user', `${reason}（native: ${nativeOk ?? 'jobs.kill'}）`);
              t.status = 'cancel_requested';
            }
          }
        } else {
          d.updateTaskFields(tid, { status: 'cancel_requested', currentStage: 'cancelling', errorSummary: reason, updatedAt: Date.now() });
          emitEvent(null, tid, 'task.cancel_requested', 'user', `${reason}（native: ${nativeOk ?? '未绑定执行单元'}）`);
          t.status = 'cancel_requested';
        }
        log(`取消：${tid}（${nativeOk} → ${t.status}）`);
        const stateWord = t.status === 'cancelled'
          ? '已取消'
          : TERMINAL.has(t.status)
            ? `已结束（${t.status}）`
            : '已请求取消（cancel_requested），等原生确认后落终态';
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
          // 并发安全（0.2.2，审计 P2-5）：写之前先读一遍拿到版本号，写的时候带上它。
          // 别人在你读之后改过 → 版本对不上 → 拒绝，而不是把对方的改动覆盖掉。
          // 不传就沿用旧行为（读出当前版本再写），但那种情况下并发写会互相覆盖。
          expectedVersion: {
            type: 'number',
            description: '期望的上下文版本号（读时返回的那个）。带上它，版本不符会被拒绝而不是覆盖别人的改动。',
          },
        },
        required: ['taskId'],
      },
      output: textOut(),
      async execute(args, exec) {
        const d = db();
        const tid = String(args?.taskId ?? '');
        const row = d.getTask(tid);
        if (!row) return { ok: false, text: `任务不存在：${args?.taskId}` };
        // 归属校验（审计 P0-3）：不能读写别人的任务上下文。
        const own = ownedBy(row, exec);
        if (!own.ok) return { ok: false, text: `任务不存在：${args?.taskId}` };

        const clean = (v) => (Array.isArray(v) ? v : [])
          .map((x) => redactSecrets(String(x)).slice(0, 200))
          .slice(0, 20);

        const writing =
          args?.stage !== undefined ||
          args?.decisions !== undefined ||
          args?.changedFiles !== undefined ||
          args?.pending !== undefined;

        if (writing) {
          const ctxNow = d.getContext(tid) || { version: 0, done: [], decisions: [], changedFiles: [], pendingIssues: [] };
          // 调用方带了 expectedVersion 就按它校验（0.2.2，审计 P2-5）。
          // 不带则用「刚读到的版本」——那仍然是乐观锁，但只能防住「读到写之间被人改」的
          // 极小窗口；两个代理各自读、各自写的情况必须靠显式传版本才能拦住。
          const wantVersion = args?.expectedVersion !== undefined ? Number(args.expectedVersion) : null;
          if (wantVersion !== null && (!Number.isInteger(wantVersion) || wantVersion < 0)) {
            return { ok: false, text: `expectedVersion 必须是非负整数（收到 ${JSON.stringify(args.expectedVersion)}）。` };
          }
          const baseVersion = wantVersion !== null ? wantVersion : (ctxNow.version || 0);
          if (wantVersion !== null && wantVersion !== (ctxNow.version || 0)) {
            return {
              ok: false,
              text: `上下文版本冲突：你要基于 v${wantVersion} 写，但库里已是 v${ctxNow.version || 0}。`
                + `先用 task_context 读一遍（不带内容字段）拿最新版本，再带上它重写。`,
            };
          }
          // 落地版上下文语义保持：stage/decisions/changedFiles/pending 四字段，乐观锁版本号
          const next = {
            taskId: tid,
            version: baseVersion + 1,
            objective: row.objective,
            currentStage: args?.stage !== undefined ? redactSecrets(String(args.stage)).slice(0, 200) : (ctxNow.currentStage ?? ctxNow.stage),
            done: ctxNow.done ?? [],
            decisions: args?.decisions !== undefined ? clean(args.decisions) : (ctxNow.decisions ?? []),
            changedFiles: args?.changedFiles !== undefined ? clean(args.changedFiles) : (ctxNow.changedFiles ?? []),
            pendingIssues: args?.pending !== undefined ? clean(args.pending) : (ctxNow.pendingIssues ?? ctxNow.pending ?? []),
            updatedAt: Date.now(),
          };
          // 8 KB 上限只量**本工具管的字段**，不量 objective（审计 P2-5）：
          // objective 是任务目标，可能本身就 8 KB 以上；把它算进来会让
          // task_context 对这个任务永久不可写（哪怕只写一个 stage）。
          const sized = {
            currentStage: next.currentStage,
            decisions: next.decisions,
            changedFiles: next.changedFiles,
            pendingIssues: next.pendingIssues,
          };
          const bytes = Buffer.byteLength(JSON.stringify(sized), 'utf8');
          if (bytes > 8192) {
            return { ok: false, text: `上下文太大（${bytes} 字节 > 8192，只算 stage/decisions/changedFiles/pending），缩一缩再写。` };
          }
          // 乐观锁写：版本冲突拒绝
          // 乐观锁写：用 baseVersion（调用方指定的或刚读到的），版本不符就拒。
          const wrote = d.updateContextOptimistic(baseVersion, next);
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
        // 服务一律走 ctx.get() 查（0.2.1，审计 P3 项）。
        // 0.2.0 这里是 `ctx[k]` 直取：cordis 4.x 对不在 inject 白名单里的服务
        // （subagents / workingDirectory / sandbox*）**取属性就抛**
        // `cannot get property "x" without inject`，于是这个诊断工具对自己最该探的
        // 那几个服务永远只回一行 error —— 探不到任何真实方法面。
        const probe = {};
        const svcOf = (k) => {
          // inject 过的（jobs/agents/tools）直取没问题，也允许直取；
          // 其余走 get()。两条都试，取到就用，取不到记原因。
          try {
            if (typeof ctx.get === 'function') {
              const viaGet = ctx.get(k);
              if (viaGet) return { v: viaGet, via: 'ctx.get' };
            }
          } catch { /* 落到直取 */ }
          try {
            const direct = ctx[k];
            if (direct) return { v: direct, via: 'direct' };
            return { v: null, via: 'undefined' };
          } catch (e) {
            return { v: null, via: `unavailable (${String(e?.message ?? e).slice(0, 60)})` };
          }
        };
        for (const k of ['jobs', 'agents', 'tools', 'subagents', 'workingDirectory', 'sandbox', 'sandboxPolicy']) {
          const { v, via } = svcOf(k);
          if (!v) {
            probe[k] = { via, methods: null };
            continue;
          }
          try {
            const proto = Object.getPrototypeOf(v);
            const names = proto ? Object.getOwnPropertyNames(proto) : [];
            probe[k] = {
              via,
              methods: names.filter((n) => n !== 'constructor').slice(0, 24),
            };
          } catch (e) {
            probe[k] = { via, methods: `error: ${String(e).slice(0, 80)}` };
          }
        }
        return {
          ok: true,
          text: [
            `jobs 候选：${JSON.stringify(jobsProbe)}`,
            `服务探测：${JSON.stringify(probe, null, 1)}`,
          ].join('\n'),
        };
      },
    }),
  ];

  log(`已注册 8 个工具（7 任务 + task_probe 诊断）；数据目录 ${dataDir({ profile: _profileHint })}`);

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
      // 这三项必须走 ctx.get()：直取会在 cordis 4.x 抛 `without inject`，
      // has() 的 try/catch 会把错吞掉，于是自检恒报 unsupported——
      // 等于这行字本身就是那个 bug 的另一面（cwd 缺陷报告 §3.3）。
      'sandbox.confine': { status: has(() => typeof ctx.get?.('sandbox')?.confine === 'function'), required: false },
      'sandbox.policy': { status: has(() => typeof ctx.get?.('sandboxPolicy')?.resolve === 'function'), required: false },
      'working_directory': { status: has(() => typeof ctx.get?.('workingDirectory')?.ensure === 'function'), required: true },
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
    for (const t of d0.listActive([...ACTIVE])) {
      if (!ACTIVE.has(t.status)) continue;
      let alive = false;
      try {
        if (t.type === 'job' && t.nativeId) {
          // caller 用台账 owner_session_id（assertAccess 围栏：查别人的有主 job 会抛错）。
          const v = ctx.jobs?.get?.(t.nativeId, t.ownerSessionId ?? undefined);
          alive = !!v && (v.status === 'running' || v.status === 'stopping');
        } else if (t.type === 'subagent' && (t.nativeSessionId || t.nativeId)) {
          // 只认 session id：反查出 id 的按 id 探活。
          //
          // 没解析出 id 的（nativeSessionId=null）以前恒判 alive=true —— 那是「不知道」，
          // 但后果是永生僵尸：重启之后原生 agent 早没了，这条任务永远停在 ACTIVE，
          // 永久占住 perOwner/global 配额，只能删库解锁（审计 P0-2）。
          //
          // 正确判据：重启（本函数只在 apply() 里跑）意味着上一个进程内的 agent 全没了。
          // 没有 session id 就无法重新接上它 —— 所以这里应当落 lost，而不是假装活着。
          // 想在重启后继续跑的，只能在运行时用 task_cancel 收尾，或重新建任务。
          //
          // 探活**抛异常**时不许判 lost（0.2.3，Gemini 补丁采纳）：
          // 那是「没问成」，不是「问到了没人」。外面那层 `catch { alive = false }`
          // 会把异常直接当死，于是重启一次全标 lost —— 和我 0.2.1 修的三处崩溃点
          // 是同一类错误：把「查询失败」当成「对象不存在」。这里单独接，
          // 按「暂不判断」处理（保持原状态，下轮维护循环再核）。
          if (!t.nativeSessionId) {
            alive = false;
          } else {
            try {
              alive = !!getAgentHandle(ctx, t);
            } catch (err) {
              log(`启动对账跳过 ${t.id}（查询 agent 异常，暂不判 lost）：${String(err).slice(0, 120)}`);
              alive = true;
            }
          }
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
        settleNotification(null, { id: t.id, status: 'lost', ownerSessionId: t.ownerSessionId, title: t.title }, { selfProduced: true });
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
  // subagent/end 的结算（0.2.2）：抽成函数，事件路径与「早到回放」共用同一套。
  //
  // 为什么必须共用：如果回放单独写一份，两份的 stopReason 映射迟早会漂开，
  // 而这条映射是「假成功/假失败」的分界线。
  // -------------------------------------------------------------------------
  function settleFromSubagentEnd(d, t, raw) {
    // A07 会合规则：cancel_requested 状态下收到原生结束事件，无论 stopReason 是什么
    // （常见 aborted/aborted:true，不含 cancel 字样），都落 cancelled——
    // 协调器自己请求过取消，结束就是确认，事实链完整。
    //
    // 其余情况按宿主**真实枚举**映射（0.2.0）。
    // 本机 0.2.1-rc.4 的 asar 里 SubagentStopReasonMap 原文：
    //   { completed:'completed', aborted:'aborted', error:'error',
    //     'max-tokens':'max-tokens', refusal:'refusal' }
    // 只有 completed 算正常收尾；aborted 是取消；error / max-tokens / refusal 都是失败。
    //
    // 0.1.7 的白名单只认 completed/end_turn/stop/success 那几个词，
    // 而宿主实际不发那些词 —— 结果是 completed 被当成 unknown 落 failed（假失败）。
    // 0.2.0 反过来：空 stopReason 也当「宿主没给原因」而不是失败，
    // 只有明确在失败集合里的才落 failed，并且把原始词写进 errorSummary。
    const cancelled = t.status === 'cancel_requested' || /^(aborted|cancel|canceled|cancelled)$/i.test(raw.trim());
    // 明确「正常收尾」：completed（宿主枚举）+ 若干历史/其他版本用词
    const OK_REASONS = /^(completed|end_turn|stop|stop_sequence|success|succeeded|done)$/i;
    // 明确「失败」：宿主枚举里的非正常终止词。
    // 连字符与下划线两种写法都收（审计提醒过 budget-exceeded / context-length），
    // 外加 interrupted —— 它不是正常收尾。
    const FAIL_REASONS = /^(error|max-tokens|max_tokens|max-turns|max_turns|timeout|refusal|interrupted|budget[-_]exceeded|context[-_]length)$/i;
    const trimmed = raw.trim();
    // 空串 / 未知词 = 「宿主没给出可判定的原因」。这种不能算失败（那是编造事实），
    // 也不能算成功（那也是编造）——落 succeeded 但把「未给出原因」写进 resultSummary，
    // 让读的人知道这条结算的依据是「事件到了且没有报错」，不是「确认成功」。
    const looksOk = OK_REASONS.test(trimmed);
    const looksBad = FAIL_REASONS.test(trimmed);
    const failed = !cancelled && looksBad;
    const status = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
    const unknownReason = !cancelled && !looksOk && !looksBad;
    d.updateTaskFields(t.id, {
      status,
      currentStage: 'settled',
      // 失败的把原始 stopReason 留下来，别只说「失败了」
      errorSummary: failed ? `end: ${raw || '(空 stopReason)'}`.slice(0, 200) : (cancelled ? (t.errorSummary ?? '执行器确认停止') : undefined),
      resultSummary: cancelled ? undefined
        : failed ? undefined
          : unknownReason
            ? `子代理已结束（原生 subagent/end；stopReason=${trimmed || '未给出'}，非失败词）`
            : '子代理已结束（原生 subagent/end）',
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    emitEvent(null, t.id, failed ? 'task.failed' : cancelled ? 'task.cancelled' : 'task.succeeded', 'executor', raw.slice(0, 200));
    settleNotification(null, { id: t.id, status });
    log(`结算：${t.id} → ${status}（subagent/end）`);
    return status;
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
      //
      // 0.2.0：改成走 idx_tasks_native_session 的定向查询（findActiveByNative），
      // 不再拉全表前 500 条内存 .find()。原因有两层：
      //   1. 任务累积超 500 条后，活动任务掉出窗口 → 事件到了也匹配不上，结算永久丢失（审计 P1-4）；
      //   2. 旧写法会命中已终态的历史记录然后提前 return，漏掉真正活跃的那条。
      const t = d.findActiveByNative(sid, [...ACTIVE], 'subagent');
      if (!t) {
        // Mode B 秒结竞态（0.2.2，审计 P2-3）：
        // 子代理可能在前台还没来得及调 task_register_delegation 之前就跑完了 ——
        // 事件先到、绑定后到。以前这里直接 return，事件被丢掉，
        // 那条任务就永远停在 running，等一个已经发生过的结束事件。
        //
        // 现在记进「早到结算」缓冲区，绑定那一刻回放。
        // 只留一段短时间（10 分钟）的东西，不做持久化：这是竞态窗口，
        // 不是长期状态；过期就丢，由探活兜底处理。
        // 0.2.4：保留与实时路径一致的四个兜底字段（stopReason/status/reason/outcome），并做容量封顶防无限增长。
        earlyEnds.set(sid, {
          at: Date.now(),
          info: {
            stopReason: info?.stopReason,
            status: info?.status,
            reason: info?.reason,
            outcome: info?.outcome,
          },
        });
        // 顺手清掉过期项，并限制最大缓存量（200 条），避免短时间内高频非台账子代理撑大内存
        const nowTs = Date.now();
        for (const [k, v] of earlyEnds) {
          if (nowTs - v.at > 10 * 60_000) earlyEnds.delete(k);
        }
        while (earlyEnds.size > 200) {
          const oldest = earlyEnds.keys().next().value;
          if (oldest === undefined) break;
          earlyEnds.delete(oldest);
        }
        log(`subagent/end 早于绑定到达（${sid}），已缓存，等 register_delegation 回放`);
        return;
      }
      // 结束原因：宿主只给 stopReason；其余几个兜底是历史/其他版本的字段名。
      const raw = String(info?.stopReason ?? info?.status ?? info?.reason ?? info?.outcome ?? '');
      settleFromSubagentEnd(d, t, raw);
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
        // 同样走索引定向查询（0.2.0）：只按 nativeId 找活动 job，
        // 不再拉全表 500 条 —— 超窗口后结算事件会被永久丢弃（审计 P1-4）。
        const t = d.findActiveByNative(String(jobId), [...ACTIVE], 'job');
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
        // 0.2.4：原生 jobs settled 事件本身就会回到前台，与 subagent/end 保持一致，不再传 selfProduced: true 重复投递 followup。
        settleNotification(null, { id: t.id, status: terminal, ownerSessionId: t.ownerSessionId, title: t.title });
        log(`结算：${t.id} → ${terminal}`);
      });
      if (typeof off === 'function') disposers.push(off);
      log('结算订阅已挂（onSettled）');
    } else {
      log('ctx.jobs.events.subscribe 不存在——收不到结算事件；'
        + 'job 的终态只能靠 task_list / task_describe 读时探活（见 sweepJobsOnce），不会自动落账');
    }
  } catch (e) {
    log(`结算订阅挂载失败（不阻塞）：${String(e).slice(0, 160)}`);
  }

  // -------------------------------------------------------------------------
  // 维护循环（0.2.0）：超时清账 + 历史清理。
  //
  // 以前这里只做过期取消，`purgeHistoryOlderThan()` 定义了却**从没被调用**（审计 P1-4）：
  // 台账与幂等表只增不减，跑到 500 条之后结算就开始丢。
  // 现在同一个定时器里两件事都做：先清超时，再清历史。
  //
  // 保留天数用 DSH_COORD_LIMITS.retentionDays 调（默认 30 天），到 0 表示不清。
  // 配置读取统一走上面那个 LIMITS_READ（0.2.1 起只有一份）。
  // -------------------------------------------------------------------------
  const sweepTimer = setInterval(() => {
    try {
      const d = db();
      const now = Date.now();
      let changed = 0;
      for (const t of d.listActive([...ACTIVE])) {
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
            const errMsg = `已超 deadline（${LIMITS_READ().timeoutMinutes} 分钟），且原生 subagent 已不在`;
            d.updateTaskFields(t.id, {
              status: 'lost',
              currentStage: 'deadline-exceeded',
              errorSummary: errMsg,
              updatedAt: Date.now(),
              completedAt: Date.now(),
            });
            emitEvent(null, t.id, 'task.lost', 'coordinator', 'deadline 超时 + 原生已回收');
            settleNotification(null, { id: t.id, status: 'lost', ownerSessionId: t.ownerSessionId, title: t.title, errorSummary: errMsg }, { selfProduced: true });
            changed += 1;
            continue;
          }
        } else if (t.type === 'subagent' && !t.nativeSessionId && (!t.nativeId || t.status === 'cancel_requested')) {
          // 0.2.4：未绑定（!nativeId）或「已绑定但未解析出会话 id 且已进入 cancel_requested」的超时 subagent，
          // 既无法按 session id 探活、也收不到能匹配的 subagent/end；超时清账直接落 lost 并通知发起会话，
          // 兑现 task_cancel 注释里「交给重启对账 / 超时清账收尾」的契约，不让任务永久卡死占配额。
          const errMsg = !t.nativeId
            ? `已超 deadline（${LIMITS_READ().timeoutMinutes} 分钟），且从未绑定原生 subagent`
            : `已超 deadline（${LIMITS_READ().timeoutMinutes} 分钟），未解析出会话 id 且取消未获原生确认`;
          d.updateTaskFields(t.id, {
            status: 'lost',
            currentStage: 'deadline-exceeded',
            errorSummary: errMsg,
            updatedAt: Date.now(),
            completedAt: Date.now(),
          });
          emitEvent(null, t.id, 'task.lost', 'coordinator', !t.nativeId ? 'deadline 超时 + 从未绑定' : 'deadline 超时 + 无会话 id 无法确认');
          settleNotification(null, { id: t.id, status: 'lost', ownerSessionId: t.ownerSessionId, title: t.title, errorSummary: errMsg }, { selfProduced: true });
          changed += 1;
          continue;
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

      // ---- job 探活（0.2.2，审计 P2-8）----
      // 放在超时扫描之后、历史清理之前：先让漏了结算事件的 job 落账，
      // 免得它们被当成「还在跑」一直占着配额。
      try {
        const sj = sweepJobsOnce(d);
        if (sj) log(`维护循环：job 探活补账 ${sj} 条`);
      } catch (e) {
        log(`job 探活失败（不阻塞）：${String(e).slice(0, 120)}`);
      }

      // ---- 历史清理（0.2.0，审计 P1-4）----
      // 只清「终态 + 完成超过 retentionDays」的：活动任务一条不动。
      // retentionDays <= 0 视为关掉清理（有人要长期留证据）。
      // 清理失败只记日志，绝不能因此跳过下一轮超时扫描。
      try {
        const days = Number(LIMITS_READ().retentionDays);
        if (Number.isFinite(days) && days > 0) {
          const cutoff = now - days * 24 * 60 * 60 * 1000;
          const purged = d.purgeHistoryOlderThan(cutoff);
          if (purged.tasks || purged.events || purged.idempotency) {
            log(`历史清理：删任务 ${purged.tasks} 条、事件 ${purged.events} 条、幂等账 ${purged.idempotency} 条（早于 ${days} 天）`);
          }
        }
      } catch (e) {
        log(`历史清理失败（不阻塞）：${String(e).slice(0, 120)}`);
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
    // 0.2.0：卸载时把库关掉（审计 P2-7）。
    // 以前 dispose() 只摘订阅和定时器，_sqlite 一直攥着句柄：
    // 插件重载会累积连接、-wal 永不 checkpoint、Windows 上库文件还被锁住。
    // 0.2.4：卸载时兑现模块顶部注释，清掉 ACTIVE_CTX 与内存态缓存，不留悬挂引用。
    if (ACTIVE_CTX === ctx) ACTIVE_CTX = null;
    missStreak.clear();
    earlyEnds.clear();
    try {
      if (_sqlite) {
        _sqlite.close();
        log('台账已关闭（dispose）');
      }
    } catch (e) {
      log(`关库失败（不阻塞卸载）：${String(e).slice(0, 120)}`);
    } finally {
      _sqlite = null;
      if (_log === log) _log = () => {};
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
