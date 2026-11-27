// 0.2.0 专项回归：收尾七条（审计 P1-4 / P1-5 / P1-7 / P2-6 / P2-7）。
//
// 每条都做成「能反驳自己」的断言：不是「代码里有这个词」，而是真跑一遍看库里/输出里变了什么。
import { mkCtx } from './mockctx.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// 相对导入：仓库 clone 到哪都能跑，不写死某台机器的绝对路径
const ROOT = new URL('..', import.meta.url).href.slice(0, -1);
const P = [];
const ok = (n, c, d = '') => P.push(`${c ? '✅' : '❌'} ${n}${d ? `  (${d})` : ''}`);
// 临时目录清理必须容错：GBK 用例会留一个刚起的子进程，句柄没放时 rmSync 会 EPERM。
// 那是测试环境卫生问题，不该把整份报告打断。
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch { /* 留给人手清 */ } };

// ---------------------------------------------------------------------------
// 0. 老库迁移：造一份带**全表 UNIQUE** 的 task_messages，验证迁移后约束松开
//    （这是真实 0.1.x 库的形态，从本机 tasks.db 抄出来的原始 DDL）
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-mig-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'mig');
  const oldDir = path.join(home, '.dsh', 'background-task-coordinator', 'mig');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldDb = path.join(oldDir, 'tasks.db');
  {
    const w = new DatabaseSync(oldDb);
    w.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_session_id TEXT NOT NULL,
        type TEXT NOT NULL, native_id TEXT, native_session_id TEXT, title TEXT NOT NULL,
        objective TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT, progress_summary TEXT,
        result_summary TEXT, error_summary TEXT, priority INTEGER NOT NULL DEFAULT 5,
        retry_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER, children TEXT, labels TEXT);
      CREATE TABLE task_messages (
        message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        sender TEXT NOT NULL, content TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,   -- ← 老库的全表 UNIQUE，就是要松掉的那个
        status TEXT NOT NULL CHECK (status IN ('pending','delivered','undeliverable','cancelled')),
        channel TEXT, reason TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);
      CREATE INDEX idx_messages_task ON task_messages(task_id, created_at);
    `);
    w.prepare("INSERT INTO tasks (id,conversation_id,owner_session_id,type,title,objective,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run('tA', 'c', 's', 'job', 'a', 'echo a', 'succeeded', 5, 1, 1);
    w.prepare("INSERT INTO tasks (id,conversation_id,owner_session_id,type,title,objective,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run('tB', 'c', 's', 'job', 'b', 'echo b', 'succeeded', 5, 2, 2);
    // 老库既有数据：任务 A 用 `step-2` 这个 key 投过一条
    w.prepare("INSERT INTO task_messages (message_id,task_id,sender,content,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('m1', 'tA', 'user', '继续', 'step-2', 'delivered', 10);
    w.close();
  }
  const { CoordinatorDatabase } = await import(`${ROOT}/lib/storage/database.js`);
  const db = new CoordinatorDatabase(oldDb);

  const sql = db.db.prepare("SELECT sql FROM sqlite_master WHERE name='task_messages'").get().sql;
  ok('0.1 迁移后不再有列级 UNIQUE', !/idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql), sql.replace(/\s+/g, ' ').slice(0, 60) + '…');
  const idx = db.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='task_messages'").all();
  ok('0.2 迁移补了 (task_id,key) 联合唯一索引', idx.some((r) => /task_id,\s*idempotency_key/i.test(String(r.sql ?? ''))), idx.map((r) => r.name).join(','));
  ok('0.3 老数据一条没丢', db.listMessages('tA').length === 1, `${db.listMessages('tA').length} 条`);

  // 迁移后的关键收益：任务 B 可以用同一个 key 投递（老库这里会静默失败）
  const wrote = db.insertMessage({
    messageId: 'm2', taskId: 'tB', sender: 'user', content: '继续',
    idempotencyKey: 'step-2', status: 'delivered', createdAt: 20, deliveredAt: 20,
  });
  ok('0.4 不同任务可复用同一 idempotencyKey', wrote === true && db.listMessages('tB').length === 1);

  // 同任务同 key 仍然只能有一条（约束没被松过头）
  const dupWrote = db.insertMessage({
    messageId: 'm3', taskId: 'tB', sender: 'user', content: '继续',
    idempotencyKey: 'step-2', status: 'pending', createdAt: 30,
  });
  ok('0.5 同任务同 key 仍然唯一', dupWrote === false, `insertMessage 返回 ${dupWrote}`);

  // 版本机制：重复打开不该再迁一次（数据不重复、版本已记）
  db.close();
  const db2 = new CoordinatorDatabase(oldDb);
  const meta = db2.db.prepare("SELECT value FROM meta WHERE key='schema.task_messages.unique'").get();
  // 目标版本 3（0.2.1 起）：2 是 0.2.0 那个「联合唯一有了但外键/CHECK 丢了」的残缺状态。
  ok('0.6 迁移版本落 meta 且不重复迁移', Number(meta?.value) === 3 && db2.listMessages('tA').length === 1, `v=${meta?.value}`);
  db2.close();
  rm(home);
}

// ---------------------------------------------------------------------------
// 1. native_session_id 索引存在
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-idx-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'idx');
  const { CoordinatorDatabase } = await import(`${ROOT}/lib/storage/database.js`);
  const db = new CoordinatorDatabase(path.join(home, 'x', 'tasks.db'));
  const idx = db.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks'").all();
  ok('1.1 native_session_id 有索引', idx.some((r) => /native_session_id/.test(String(r.sql ?? ''))), idx.map((r) => String(r.name)).join(','));
  ok('1.2 有 status+created_at 复合索引', idx.some((r) => /status,\s*created_at/i.test(String(r.sql ?? ''))));

  // busy_timeout 真的设上了（不是只写在注释里）
  const t = db.db.prepare("PRAGMA busy_timeout").get();
  ok('1.3 busy_timeout=5000', Number(t?.timeout) === 5000, JSON.stringify(t));
  db.close();
  rm(home);
}

// ---------------------------------------------------------------------------
// 2. LIMIT 500 全清 + 定向查询：造 600 条历史，验证活动任务仍能被结算匹配上
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-lim-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'lim');
  delete process.env.DSH_PROFILE;
  const { CoordinatorDatabase } = await import(`${ROOT}/lib/storage/database.js`);
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'lim', 'tasks.db');
  const db = new CoordinatorDatabase(dbp);

  // 600 条终态历史（priority 更小 = 在旧 ORDER BY 里排更前，专治「被挤出去」）
  for (let i = 0; i < 600; i++) {
    db.insertTask({
      id: `old-${i}`, conversationId: 'c', ownerSessionId: 's', type: 'job',
      title: `历史 ${i}`, objective: 'x', status: 'succeeded', priority: 1,
      createdAt: 1000 + i, updatedAt: 1000 + i, completedAt: 1000 + i,
    });
  }
  // 一条真正在跑的活动任务，创建时间最晚
  db.insertTask({
    id: 'live-1', conversationId: 'c', ownerSessionId: 's', type: 'job',
    title: '在跑的', objective: 'x', status: 'running', priority: 5,
    nativeId: 'job-live', createdAt: 999999, updatedAt: 999999,
  });

  ok('2.1 总数确实超过 500', db.stats().tasks === 601, `${db.stats().tasks} 条`);

  // 这是 subagent/end 与 jobs.settled 现在走的查询
  const hit = db.findActiveByNative('job-live', ['queued', 'starting', 'running', 'waiting_input', 'cancel_requested'], 'job');
  ok('2.2 定向查询能在 601 条里命中活动任务', hit?.id === 'live-1', hit?.id ?? 'miss');

  // 旧写法等价物：前 500 条里根本没有它
  const legacy = db.listTasks({ limit: 500 }).find((x) => x.nativeId === 'job-live');
  ok('2.3 旧 limit:500 写法确实会漏（这就是被修掉的 bug）', legacy === undefined, legacy ? '居然命中了' : 'miss（符合预期）');

  const active = db.listActive(['running']);
  ok('2.4 listActive 不受总量影响', active.length === 1 && active[0].id === 'live-1', `${active.length} 条`);
  db.close();
  rm(home);
}

// ---------------------------------------------------------------------------
// 3. purge 真的被调用（维护循环里）+ 幂等表一起清
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-purge-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'purge');
  delete process.env.DSH_PROFILE;
  const { CoordinatorDatabase } = await import(`${ROOT}/lib/storage/database.js`);
  const db = new CoordinatorDatabase(path.join(home, 'x', 'tasks.db'));
  const longAgo = Date.now() - 100 * 24 * 3600 * 1000;
  db.insertTask({
    id: 'ancient', conversationId: 'c', ownerSessionId: 's', type: 'job',
    title: '很老的一条', objective: 'x', status: 'succeeded', priority: 5,
    createdAt: longAgo, updatedAt: longAgo, completedAt: longAgo,
  });
  db.claimIdempotency('notice', 'notice:ancient:succeeded', longAgo);
  const r = db.purgeHistoryOlderThan(Date.now() - 30 * 24 * 3600 * 1000);
  ok('3.1 purge 删掉过期任务', r.tasks === 1, JSON.stringify(r));
  ok('3.2 purge 同时清幂等表', r.idempotency >= 1, `idempotency=${r.idempotency}`);
  ok('3.3 幂等表真的空了', db.stats().idempotency === 0);

  // 代码层面：维护循环里确实调了（这是静态核对，但配合上面 3.1 才是完整证据）
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  ok('3.4 维护循环调用 purgeHistoryOlderThan', /d\.purgeHistoryOlderThan\(cutoff\)/.test(src));
  db.close();
  rm(home);
}

// ---------------------------------------------------------------------------
// 4. GBK 解码：先纯 ASCII 再中文（跨 chunk 劈开一个汉字），不许乱码
// ---------------------------------------------------------------------------
{
  // 直接 import 模块拿不到内部函数，用「跑一个真子进程」验证更硬：
  // 让 cmd 先吐 ASCII，再吐 GBK 中文（跨两个 chunk）。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-gbk-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'gbk');
  delete process.env.DSH_PROFILE;
  process.env.DSH_COORD_LIMITS = JSON.stringify({ global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600 });

  const mod = await import(`${ROOT}/index.js?sec=gbk`);
  const R = {};
  const chunks = [];
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: {
      start(spec) {
        // run 里会 spawn 真进程；我们只要它把 stdout 解出来的文本给 job.append
        spec.run({ append: (s) => chunks.push(s), updateProgress() {} });
        return 'gbk-job';
      },
      get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } },
    },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } },
    on() { return () => {}; },
  });
  mod.default.apply(ctx, {});
  // 用可控脚本精确构造：先吐纯 ASCII（这一步以前会把编码锁成 utf8），
  // 再吐 GBK 字节，而且**故意把「中」的两个字节劈在两个 chunk 里**。
  // 命令只写命令本身 —— 插件会自己包 cmd.exe /d /s /c，写前缀会嵌套引号。
  const script = path.join(home, 'emit.cjs');
  fs.writeFileSync(script, [
    String.raw`process.stdout.write('ABC\n');`,
    // 中文「中」= D6 D0（GBK）；拆成 D6 | D0 两次写，制造跨 chunk 的半字
    String.raw`setTimeout(() => { process.stdout.write(Buffer.from([0xD6])); }, 120);`,
    String.raw`setTimeout(() => { process.stdout.write(Buffer.from([0xD0,0xCE,0xC4,0x0A])); }, 260);`,
  ].join('\n'), 'utf8');
  const r = await R.task_create.execute({
    type: 'job', title: 'gbk',
    // 路径里不能有空格：插件会包成 `cmd /d /s /c <命令>`，而 cmd 在 /s 下不会剥掉引号，
    // 带引号的路径会被当成字面量传给 node（这条是构造测试时踩到的，见文档「已知坑」）。
    objective: `node ${script}`,
  }, { agent: { id: 's-gbk', session: { id: 's-gbk' } } });
  ok('4.0 GBK 用例的任务建起来了', r.ok, r.text.split('\n')[0].slice(0, 40));
  // 等子进程把三个 chunk 都吐完
  await new Promise((res) => setTimeout(res, 1500));
  const all = chunks.join('');
  const hasAscii = all.includes('ABC');
  const hasChinese = all.includes('中文');
  const garbled = all.includes('�') || /[À-ÿ]{2,}/.test(all);
  ok('4.1 先 ASCII 后 GBK 中文仍能正确解出（无乱码）', hasAscii && hasChinese && !garbled,
    JSON.stringify(all.slice(0, 60)));
  ok('4.2 「中」跨 chunk 劈开也没被切成半个字', hasChinese, JSON.stringify(all.slice(0, 40)));

  // 4.3 路径带空格 + 显式引号：这是 0.2.0 顺手修掉的真 bug。
  //   插件用 cmd /d /s /c 执行，Node 默认会给参数加引号、cmd 在 /s 下不再剥掉，
  //   于是 `node "C:\my scripts\emit.cjs"` 被拼成字面引号 → Cannot find module。
  //   修法是 spawn 时 windowsVerbatimArguments: true。
  const dirWithSpace = path.join(home, 'my scripts');
  fs.mkdirSync(dirWithSpace, { recursive: true });
  const script2 = path.join(dirWithSpace, 'emit2.cjs');
  fs.writeFileSync(script2, String.raw`process.stdout.write('QUOTED-OK\n');`, 'utf8');
  chunks.length = 0;
  const r2 = await R.task_create.execute({
    type: 'job', title: 'quoted',
    objective: `node "${script2}"`,
  }, { agent: { id: 's-gbk2', session: { id: 's-gbk2' } } });
  ok('4.3 引号路径任务建起来了', r2.ok, r2.text.split('\n')[0].slice(0, 30));
  await new Promise((res) => setTimeout(res, 1500));
  const out2 = chunks.join('');
  ok('4.3 带空格+引号的命令不被拼坏（原样交给 cmd）', out2.includes('QUOTED-OK'), JSON.stringify(out2.slice(0, 60)));
  rm(home);
}

// ---------------------------------------------------------------------------
// 5. stopReason：按宿主真实枚举映射，空串不落 failed
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-stop-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'stop');
  delete process.env.DSH_PROFILE;
  process.env.DSH_COORD_LIMITS = JSON.stringify({ global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600 });

  const mod = await import(`${ROOT}/index.js?sec=stop`);
  const R = {}, log = [], alive = new Set(), listeners = {};
  const ctx = mkCtx({
    logger: { info: (m) => log.push(m) },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get(id) { return alive.has(id) ? { status: {}, followup() {}, steer() {}, cancel() {} } : undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } },
    on(ev, fn) { listeners[ev] = fn; return () => {}; },
  });
  mod.default.apply(ctx, {});
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'stop', 'tasks.db');
  const { DatabaseSync: DS } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DS(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DS(dbp); w.prepare(sql).run(...a); w.close(); };
  const exec = { agent: { id: 'sX', session: { id: 'sX' } } };

  const mk = async (name) => {
    const rr = await R.task_create.execute({ type: 'subagent', title: name, objective: 'x' }, exec);
    const tid = rr.text.match(/taskId=([\w-]+)/)?.[1];
    await R.task_register_delegation.execute({ taskId: tid, agentId: name }, exec);
    alive.add(`sess-${name}`);
    set("UPDATE tasks SET native_session_id=? WHERE id=?", `sess-${name}`, tid);
    return tid;
  };

  // 宿主枚举 completed → succeeded
  let tid = await mk('c1');
  listeners['subagent/end']({ id: 'sess-c1', stopReason: 'completed' });
  ok('5.1 completed → succeeded', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'succeeded');

  // 空 stopReason → 不能落 failed（那是编造失败）
  tid = await mk('c2');
  listeners['subagent/end']({ id: 'sess-c2', stopReason: '' });
  const r2 = get1("SELECT status,result_summary FROM tasks WHERE id=?", tid);
  ok('5.2 空 stopReason 不落 failed', r2.status === 'succeeded', `${r2.status} / ${r2.result_summary}`);

  // max-tokens（宿主真枚举，带连字符）→ failed
  tid = await mk('c3');
  listeners['subagent/end']({ id: 'sess-c3', stopReason: 'max-tokens' });
  const r3 = get1("SELECT status,error_summary FROM tasks WHERE id=?", tid);
  ok('5.3 max-tokens → failed', r3.status === 'failed', `${r3.status} / ${r3.error_summary}`);

  // refusal → failed
  tid = await mk('c4');
  listeners['subagent/end']({ id: 'sess-c4', stopReason: 'refusal' });
  ok('5.4 refusal → failed', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'failed');

  // error → failed
  tid = await mk('c5');
  listeners['subagent/end']({ id: 'sess-c5', stopReason: 'error' });
  ok('5.5 error → failed', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'failed');

  // aborted → cancelled
  tid = await mk('c6');
  listeners['subagent/end']({ id: 'sess-c6', stopReason: 'aborted' });
  ok('5.6 aborted → cancelled', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'cancelled');

  // 600 条历史时，结算事件仍然匹配得上（LIMIT 500 那条的真正后果）
  const { DatabaseSync: DS2 } = await import('node:sqlite');
  {
    const w = new DS2(dbp);
    for (let i = 0; i < 600; i++) {
      w.prepare("INSERT INTO tasks (id,conversation_id,owner_session_id,type,title,objective,status,priority,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(`h-${i}`, 'c', 'sX', 'job', `h${i}`, 'x', 'succeeded', 1, 1000 + i, 1000 + i, 1000 + i);
    }
    w.close();
  }
  tid = await mk('c7');
  listeners['subagent/end']({ id: 'sess-c7', stopReason: 'completed' });
  ok('5.7 601 条台账时结算仍然落账', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'succeeded',
    `总数 ${get1("SELECT COUNT(*) n FROM tasks").n}`);
  rm(home);
}

// ---------------------------------------------------------------------------
// 6. pending flush + 终态不可复活 + profile 隔离
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-flush-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'flush');
  delete process.env.DSH_PROFILE;
  process.env.DSH_COORD_LIMITS = JSON.stringify({ global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600 });

  const mod = await import(`${ROOT}/index.js?sec=flush`);
  const R = {}, alive = new Set(), got = [];
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) {
        return alive.has(id) ? {
          status: {},
          followup(m) { got.push({ id, text: m.content?.[0]?.text }); },
          steer(m) { got.push({ id, text: m.content?.[0]?.text, steer: true }); },
          cancel() {},
        } : undefined;
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } },
    on() { return () => {}; },
  });
  mod.default.apply(ctx, {});
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'flush', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };
  const exec = { agent: { id: 'sF', session: { id: 'sF' } } };

  // 6.1 绑定前排队 → 绑定后真补投
  let r = await R.task_create.execute({ type: 'subagent', title: 'flush1', objective: 'x' }, exec);
  const t1 = r.text.match(/taskId=([\w-]+)/)?.[1];
  r = await R.task_append_message.execute({ taskId: t1, content: '绑定前排队的话' }, exec);
  ok('6.1 未绑定时记为 pending', r.text.includes('pending'), r.text.slice(0, 30));
  ok('6.2 库里确实是 pending', get1("SELECT status FROM task_messages WHERE task_id=?", t1).status === 'pending');
  alive.add('sess-F1');
  r = await R.task_register_delegation.execute({ taskId: t1, agentId: 'agF1', sessionId: 'sess-F1' }, exec);
  ok('6.3 绑定时真的补投出去了', got.some((g) => g.text === '绑定前排队的话'), JSON.stringify(got));
  ok('6.4 补投后状态改成 delivered', get1("SELECT status FROM task_messages WHERE task_id=?", t1).status === 'delivered');
  ok('6.5 返回文本说明了补投', r.text.includes('补投'), r.text.split('\n').slice(-1)[0].slice(0, 40));

  // 6.6 已投递的同一 key 仍然挡重试
  r = await R.task_append_message.execute({ taskId: t1, content: '绑定前排队的话' }, exec);
  ok('6.6 delivered 的仍然幂等拦截', r.text.includes('幂等命中'), r.text.slice(0, 30));

  // 6.7 终态不许复活
  set("UPDATE tasks SET status='succeeded', completed_at=12345 WHERE id=?", t1);
  const before = get1("SELECT status,completed_at FROM tasks WHERE id=?", t1);
  r = await R.task_register_delegation.execute({ taskId: t1, agentId: 'agAgain', sessionId: 'sess-again' }, exec);
  const after = get1("SELECT status,completed_at FROM tasks WHERE id=?", t1);
  ok('6.7 终态任务拒绝重新登记', !r.ok && r.text.includes('终态'), r.text.slice(0, 40));
  ok('6.8 状态与 completed_at 都没被改', after.status === before.status && after.completed_at === before.completed_at, JSON.stringify(after));

  // 6.9 同一 key 在不同任务上都能投（联合唯一的效果，走真实工具路径）
  //   t1 在 6.7 已被置为终态（那是故意的），所以这里另建两条活任务。
  const mk2 = async (tag) => {
    const rr = await R.task_create.execute({ type: 'subagent', title: `flush-${tag}`, objective: 'x' }, exec);
    const tid = rr.text.match(/taskId=([\w-]+)/)?.[1];
    await R.task_register_delegation.execute({ taskId: tid, agentId: `ag-${tag}`, sessionId: `sess-${tag}` }, exec);
    alive.add(`sess-${tag}`);
    return tid;
  };
  const tA = await mk2('K1');
  const tB = await mk2('K2');
  const ra = await R.task_append_message.execute({ taskId: tA, content: '同一个键', idempotencyKey: 'shared-k' }, exec);
  const rb = await R.task_append_message.execute({ taskId: tB, content: '同一个键', idempotencyKey: 'shared-k' }, exec);
  const nShared = get1("SELECT COUNT(*) n FROM task_messages WHERE idempotency_key='shared-k'").n;
  ok('6.9 跨任务复用显式键不再静默丢记录',
    ra.ok && rb.ok && nShared === 2,
    `库里 ${nShared} 条；A=${ra.text.slice(0, 12)} B=${rb.text.slice(0, 12)}`);

  rm(home);
}

// ---------------------------------------------------------------------------
// 7. profile 隔离 + dispose 关库
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-prof-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_COORD_LIMITS = JSON.stringify({ global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600 });

  // 两个 profile 各自开一次，库应该落在两个不同目录
  const seen = [];
  for (const tag of ['alpha', 'beta']) {
    process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', tag);
    delete process.env.DSH_PROFILE;
    // 每次都得清模块缓存，否则单例 _sqlite 会复用上一个 profile 的库
    const url = `${ROOT}/index.js?v=${tag}`;
    const mod = await import(url);
    const ctx = mkCtx({
      logger: { info: () => {} },
      jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
      agents: { get() { return undefined; } },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
      sandbox: { confine: async (a) => ({ argv: a }) },
      tools: { register() {} }, on() { return () => {}; },
    });
    const dispose = mod.default.apply(ctx, {});
    const base = path.join(home, '.dsh', 'background-task-coordinator', tag, 'tasks.db');
    seen.push(fs.existsSync(base) ? base : null);
    // dispose 应该把库关掉：关掉之后同一路径还能被重新打开（没被句柄锁住）
    if (typeof dispose === 'function') dispose();
  }
  ok('7.1 alpha 的库在自己目录下', seen[0] !== null && seen[0].includes(`${path.sep}alpha${path.sep}`), seen[0] ?? 'missing');
  ok('7.2 beta 的库在自己目录下', seen[1] !== null && seen[1].includes(`${path.sep}beta${path.sep}`), seen[1] ?? 'missing');
  ok('7.3 两份库不是同一个文件', seen[0] !== seen[1]);

  // dispose 之后能删（Windows 上句柄没关是删不掉的）
  let deletable = true;
  try { fs.rmSync(path.join(home, '.dsh', 'background-task-coordinator', 'alpha', 'tasks.db'), { force: true }); }
  catch { deletable = false; }
  ok('7.4 dispose 后库文件可删（句柄已释放）', deletable);
  rm(home);
}

// ---------------------------------------------------------------------------
// 8. 插件配置真的被读取（0.1.x 的 apply 只收一个参数，yml 里写什么都进不来）
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v020-cfg-'));
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'cfg');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;      // 确保没有被环境变量盖掉

  const mod = await import(`${ROOT}/index.js?sec=cfg`);
  const log = [];
  const ctx = mkCtx({
    logger: { info: (m) => log.push(m) },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register() {} }, on() { return () => {}; },
  });
  // 把 sweepSeconds 设 1 秒、retentionDays 设 1 天，让维护循环很快跑一轮
  const dispose = mod.default.apply(ctx, { sweepSeconds: 1, retentionDays: 1, timeoutMinutes: 120 });

  // 库里放一条「两天前完成的终态任务」，配置生效的话第一轮就该被清掉
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'cfg', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const old = Date.now() - 2 * 24 * 3600 * 1000;
  {
    const w = new DatabaseSync(dbp);
    w.prepare("INSERT INTO tasks (id,conversation_id,owner_session_id,type,title,objective,status,priority,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run('cfg-old', 'c', 's', 'job', '老任务', 'x', 'succeeded', 5, old, old, old);
    w.close();
  }
  await new Promise((res) => setTimeout(res, 2200));
  const { DatabaseSync: DS } = await import('node:sqlite');
  const ro = new DS(dbp, { readOnly: true });
  const gone = ro.prepare("SELECT id FROM tasks WHERE id='cfg-old'").get();
  ro.close();
  ok('8.1 config.retentionDays 真的生效（2 天前终态任务被清）', gone === undefined, gone ? '还在' : '已清');

  const logText = log.join('\n');
  ok('8.2 清理结果写进日志', /历史清理/.test(logText), (logText.match(/历史清理.*/) ?? ['（无）'])[0].slice(0, 50));

  // 8.3 垃圾配置不许让定时器退化成 1ms 死循环
  const mod2 = await import(`${ROOT}/index.js?sec=cfg2`);
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'cfg2');
  const ctx2 = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register() {} }, on() { return () => {}; },
  });
  let crashed = false;
  let d2;
  try {
    d2 = mod2.default.apply(ctx2, { sweepSeconds: 'oops', retentionDays: null, timeoutMinutes: {} });
    await new Promise((res) => setTimeout(res, 300));
  } catch { crashed = true; }
  ok('8.3 垃圾配置不崩、不退化成 1ms 死循环', !crashed && typeof d2 === 'function');
  if (typeof d2 === 'function') d2();
  rm(home);
}

// ---------------------------------------------------------------------------
// 9. 审计 #4：yml 的 config 必须真的管住 task_create（0.2.0 里它只对维护循环生效）
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v021-cfg2-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'cfg2');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=cfg2limit`);
  const R = {};
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  // config 写死 global:1 / perOwner:1 / timeoutMinutes:5 —— 建任务必须照这个来
  const dispose = mod.default.apply(ctx, { global: 1, perOwner: 1, timeoutMinutes: 5, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-cfg', session: { id: 's-cfg' } } };

  const r1 = await R.task_create.execute({ type: 'job', title: 'first', objective: 'echo hi' }, ex);
  ok('9.1 config.global=1 时第一个能建', r1.ok, r1.text.split('\n')[0].slice(0, 30));

  const r2 = await R.task_create.execute({ type: 'job', title: 'second', objective: 'echo hi' }, ex);
  ok('9.2 config.global=1 时第二个被挡住（0.2.0 这里会放行）',
    !r2.ok && /\/1/.test(r2.text), r2.text.slice(0, 50));

  const tid = r1.text.match(/taskId=([\w-]+)/)?.[1];
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'cfg2', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(dbp, { readOnly: true });
  const lab = JSON.parse(ro.prepare("SELECT labels FROM tasks WHERE id=?").get(tid)?.labels ?? '{}');
  ro.close();
  ok('9.3 config.timeoutMinutes=5 时 deadlineMinutes 落 5（0.2.0 这里恒 120）',
    lab.deadlineMinutes === '5', `deadlineMinutes=${lab.deadlineMinutes}`);

  if (typeof dispose === 'function') dispose();
  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 10. 审计回归：0.2.0 引入的越权 / 崩溃 / 约束丢失（0.2.1 修）
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v021-reg-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'reg');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=reg`);
  const R = {}, alive = new Set(), got = [];
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) {
        if (id === 'sess-VICTIM') throw new Error('registry transient failure');  // 探活抛错
        return alive.has(id) ? {
          status: {}, followup(m) { got.push({ id, text: m.content?.[0]?.text }); }, steer() {}, cancel() {},
        } : undefined;
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 50, perOwner: 50, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'reg', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };

  const victimA = { agent: { id: 'owner-A', session: { id: 'owner-A' } } };
  const attackerB = { agent: { id: 'attacker-B', session: { id: 'attacker-B' } } };

  // 10.1 越权：别人的任务不许登记委派（0.2.0 漏 ownedBy，攻击者能劫持 + 刷走 pending）
  let r = await R.task_create.execute({ type: 'subagent', title: 'victim', objective: 'x' }, victimA);
  const tV = r.text.match(/taskId=([\w-]+)/)?.[1];
  // 受害者在排队一条私密指令
  await R.task_append_message.execute({ taskId: tV, content: 'SECRET_TOKEN=xyz123' }, victimA);
  r = await R.task_register_delegation.execute({ taskId: tV, agentId: 'ag-evil', sessionId: 'sess-EVIL' }, attackerB);
  ok('10.1 越权登记委派被拒', !r.ok && r.text.includes('任务不存在'), r.text.slice(0, 40));
  ok('10.2 受害者的 pending 没被刷给攻击者', !got.some((g) => String(g.text).includes('SECRET')), JSON.stringify(got));
  ok('10.3 任务仍归原主', get1("SELECT owner_session_id FROM tasks WHERE id=?", tV).owner_session_id === 'owner-A');

  // 10.4 从未绑定的 queued 子代理点取消 → 直接 cancelled（0.2.0 卡在 cancel_requested）
  r = await R.task_cancel.execute({ taskId: tV, reason: 'never bound' }, victimA);
  ok('10.4 从未绑定的 queued 子代理取消能落地', /已取消/.test(r.text), r.text.slice(0, 50));
  ok('10.5 状态是 cancelled 不是 cancel_requested',
    get1("SELECT status FROM tasks WHERE id=?", tV).status === 'cancelled',
    get1("SELECT status FROM tasks WHERE id=?", tV).status);

  // 10.6 探活抛异常时 task_list 不崩（0.2.0 会打崩整个工具）
  r = await R.task_create.execute({ type: 'subagent', title: 'throws', objective: 'x' }, victimA);
  const tX = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tX, agentId: 'agX', sessionId: 'sess-VICTIM' }, victimA);
  set("UPDATE tasks SET native_session_id='sess-VICTIM', status='running' WHERE id=?", tX);
  let threw = false;
  try { r = await R.task_list.execute({ all: true }, victimA); } catch { threw = true; }
  ok('10.6 探活异常时 task_list 不崩', !threw && r?.ok, threw ? '抛异常了' : (r?.text ?? '').split('\n')[0].slice(0, 40));
  ok('10.7 探活失败不误判成 lost',
    get1("SELECT status FROM tasks WHERE id=?", tX).status === 'running',
    get1("SELECT status FROM tasks WHERE id=?", tX).status);

  // 10.8 迁移后的表必须有外键和 CHECK（0.2.0 重建时把两个都丢了）
  const w = new DatabaseSync(dbp);
  let orphanBlocked = false;
  try {
    w.prepare("INSERT INTO task_messages (message_id,task_id,sender,content,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('orphan', 'no-such-task', 'user', 'x', 'k-orphan', 'pending', 1);
  } catch { orphanBlocked = true; }
  ok('10.8 外键在：孤儿消息插不进去', orphanBlocked);

  let badStatusBlocked = false;
  try {
    w.prepare("INSERT INTO task_messages (message_id,task_id,sender,content,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('bad', tX, 'user', 'x', 'k-bad', 'TOTALLY_BOGUS', 1);
  } catch { badStatusBlocked = true; }
  ok('10.9 CHECK 在：非法 status 插不进去', badStatusBlocked);
  w.close();

  // 10.10 崩在半路不丢消息：探活抛错时那条指令必须留下来（0.2.0 是先删旧行再崩）
  r = await R.task_create.execute({ type: 'subagent', title: 'keepmsg', objective: 'x' }, victimA);
  const tK = r.text.match(/taskId=([\w-]+)/)?.[1];
  // 先排一条 pending，再让探活抛错
  await R.task_append_message.execute({ taskId: tK, content: 'keep-me', idempotencyKey: 'KM' }, victimA);
  await R.task_register_delegation.execute({ taskId: tK, agentId: 'agK', sessionId: 'sess-VICTIM' }, victimA);
  set("UPDATE tasks SET native_session_id='sess-VICTIM', status='running' WHERE id=?", tK);
  let r2;
  try { r2 = await R.task_append_message.execute({ taskId: tK, content: 'keep-me', idempotencyKey: 'KM' }, victimA); }
  catch { r2 = { ok: false, text: '（抛异常）' }; }
  const kept = get1("SELECT COUNT(*) n FROM task_messages WHERE task_id=? AND idempotency_key='KM'", tK).n;
  ok('10.10 探活抛错时消息不凭空消失', kept >= 1, `库里 ${kept} 条；返回 ${r2.text.slice(0, 40)}`);

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 11. 审计 #6：windowsVerbatimArguments 只对 danger-full-access 生效
//     沙箱包装器给的 argv 必须走正常转义，否则带空格路径被劈开
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v021-vb-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'vb');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  // 带空格的目录 + 显式引号：verbatim 开对了才跑得通，开错就 Cannot find module
  const dirWithSpace = path.join(home, 'has space');
  fs.mkdirSync(dirWithSpace, { recursive: true });
  const script = path.join(dirWithSpace, 'ok.cjs');
  fs.writeFileSync(script, String.raw`process.stdout.write('SANDBOX_PATH_OK\n');`, 'utf8');

  const mk = async (secure) => {
    const mod = await import(`${ROOT}/index.js?sec=vb${secure ? 's' : 'd'}`);
    const R = {}, chunks = [];
    const ctx = mkCtx({
      logger: { info: () => {} },
      jobs: {
        start(spec) { spec.run({ append: (s) => chunks.push(s), updateProgress() {} }); return 'nj'; },
        get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } },
      },
      agents: { get() { return undefined; } },
      workingDirectory: { ensure: async () => process.cwd() },
      // secure=true → 走 sandbox.confine 分支（模拟带空格路径的包装器）
      sandboxPolicy: { resolve: async () => ({ mode: secure ? 'workspace-write' : 'danger-full-access' }) },
      sandbox: {
        confine: async (argv) => {
          // 真实包装器的形态：一个可执行文件 + 若干带空格的参数 + 原文
          return { argv: [process.execPath, script] };
        },
      },
      tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
    });
    mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
    const r = await R.task_create.execute({ type: 'job', title: 'vb', objective: `node "${script}"` },
      { agent: { id: 's-vb', session: { id: 's-vb' } } });
    await new Promise((res) => setTimeout(res, 1200));
    return { r, out: chunks.join('') };
  };

  const safe = await mk(true);
  ok('11.1 沙箱分支：带空格路径不被劈开', safe.r.ok && safe.out.includes('SANDBOX_PATH_OK'),
    JSON.stringify(safe.out.slice(0, 60)));

  const open = await mk(false);
  ok('11.2 danger-full-access 分支：引号路径仍正常', open.r.ok && open.out.includes('SANDBOX_PATH_OK'),
    JSON.stringify(open.out.slice(0, 60)));

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 12. 审计 P1-5 / P3：pending 正文不许截断；job 起来后阶段要推进
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v021-misc-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'misc');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=misc`);
  const R = {}, got = [];
  const alive = new Set(['sess-LONG']);
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) {
        return alive.has(id) ? { status: {}, followup(m) { got.push(m.content?.[0]?.text); }, steer() {}, cancel() {} } : undefined;
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-misc', session: { id: 's-misc' } } };
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'misc', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };

  // 12.1 长指令排队后补投，正文必须完整
  let r = await R.task_create.execute({ type: 'subagent', title: 'longmsg', objective: 'x' }, ex);
  const t1 = r.text.match(/taskId=([\w-]+)/)?.[1];
  const longBody = `${'A'.repeat(1200)}TAIL-MARKER`;
  await R.task_append_message.execute({ taskId: t1, content: longBody }, ex);
  const stored = get1("SELECT content FROM task_messages WHERE task_id=?", t1).content;
  ok('12.1 pending 正文完整入库（不再截 500）', stored.length === longBody.length && stored.endsWith('TAIL-MARKER'),
    `存了 ${stored.length}/${longBody.length} 字`);
  await R.task_register_delegation.execute({ taskId: t1, agentId: 'agL', sessionId: 'sess-LONG' }, ex);
  const delivered = got.find((g) => String(g).includes('TAIL-MARKER'));
  ok('12.2 补投出去的是完整正文', !!delivered && delivered.length === longBody.length,
    delivered ? `投了 ${delivered.length} 字` : '没投出去');

  // 12.3 job 起来后阶段要推进到 running
  r = await R.task_create.execute({ type: 'job', title: 'stage', objective: 'echo hi' }, ex);
  const t2 = r.text.match(/taskId=([\w-]+)/)?.[1];
  const st = get1("SELECT status,current_stage FROM tasks WHERE id=?", t2);
  ok('12.3 job 起来后阶段推进到 running', st.current_stage === 'running', `${st.status} / ${st.current_stage}`);

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 13. P2-1 探活二次确认：单次 miss 不许杀活任务
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v022-miss-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'miss');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=miss`);
  const R = {};
  // flaky：第一次查不到、第二次查得到 —— 模拟注册表瞬时抖动
  let calls = 0;
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) {
        if (id === 'sess-FLAKY') {
          calls += 1;
          return calls === 1 ? undefined : { status: {}, followup() {}, steer() {}, cancel() {} };
        }
        return undefined;
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-miss', session: { id: 's-miss' } } };
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'miss', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };

  const r = await R.task_create.execute({ type: 'subagent', title: 'flaky', objective: 'x' }, ex);
  const tid = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tid, agentId: 'agF', sessionId: 'sess-FLAKY' }, ex);
  set("UPDATE tasks SET native_session_id='sess-FLAKY', status='running' WHERE id=?", tid);

  // 第一轮 task_list：探活 miss 1 次 → 不许判死
  await R.task_list.execute({ all: true }, ex);
  ok('13.1 单次探活 miss 不判死', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'running',
    get1("SELECT status FROM tasks WHERE id=?", tid).status);

  // 第二轮：这次查到了 → 清计数，仍活着
  await R.task_list.execute({ all: true }, ex);
  ok('13.2 查到一次就清掉怀疑', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'running');

  // 另建一个持续查不到的：连续两轮才落 lost
  const r2 = await R.task_create.execute({ type: 'subagent', title: 'gone', objective: 'x' }, ex);
  const tid2 = r2.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tid2, agentId: 'agG', sessionId: 'sess-GONE' }, ex);
  set("UPDATE tasks SET native_session_id='sess-GONE', status='running' WHERE id=?", tid2);
  await R.task_list.execute({ all: true }, ex);
  const afterOne = get1("SELECT status FROM tasks WHERE id=?", tid2).status;
  await R.task_list.execute({ all: true }, ex);
  const afterTwo = get1("SELECT status FROM tasks WHERE id=?", tid2).status;
  ok('13.3 持续查不到：第一轮不动', afterOne === 'running', afterOne);
  ok('13.4 持续查不到：第二轮落 lost', afterTwo === 'lost', afterTwo);

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 14. P2-3 秒结竞态：绑定前到达的 subagent/end 必须回放
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v022-early-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'early');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=early`);
  const R = {}, listeners = {};
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } },
    on(ev, fn) { listeners[ev] = fn; return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-early', session: { id: 's-early' } } };
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'early', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };

  const r = await R.task_create.execute({ type: 'subagent', title: 'fast', objective: 'x' }, ex);
  const tid = r.text.match(/taskId=([\w-]+)/)?.[1];

  // 关键时序：事件先到（此时还没绑定，nativeSessionId 为空，匹配不上）
  listeners['subagent/end']({ id: 'sess-FAST', stopReason: 'completed' });
  ok('14.1 事件早到时任务还是 queued', get1("SELECT status FROM tasks WHERE id=?", tid).status === 'queued',
    get1("SELECT status FROM tasks WHERE id=?", tid).status);

  // 然后才绑定 —— 应该回放那条结算
  const rb = await R.task_register_delegation.execute(
    { taskId: tid, agentId: 'agFast', sessionId: 'sess-FAST' }, ex);
  const st = get1("SELECT status FROM tasks WHERE id=?", tid).status;
  ok('14.2 绑定后回放早到结算 → succeeded', st === 'succeeded', st);
  ok('14.3 返回文案如实说明（不再说「进入 running」）',
    rb.text.includes('已经结束') && !rb.text.includes('任务进入 running'), rb.text.split('\n')[0].slice(0, 50));

  // 14.4 早到的 aborted 也应该按取消落账
  const r2 = await R.task_create.execute({ type: 'subagent', title: 'fast2', objective: 'x' }, ex);
  const tid2 = r2.text.match(/taskId=([\w-]+)/)?.[1];
  listeners['subagent/end']({ id: 'sess-FAST2', stopReason: 'aborted' });
  await R.task_register_delegation.execute({ taskId: tid2, agentId: 'agFast2', sessionId: 'sess-FAST2' }, ex);
  ok('14.4 早到的 aborted 回放成 cancelled',
    get1("SELECT status FROM tasks WHERE id=?", tid2).status === 'cancelled',
    get1("SELECT status FROM tasks WHERE id=?", tid2).status);

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 15. P1-2 残留：首行空行必须拦、taskkill 不许同步阻塞
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v022-misc-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'm2');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=m2`);
  const R = {};
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-m2', session: { id: 's-m2' } } };

  const r = await R.task_create.execute({ type: 'job', title: 'empty', objective: '\nnpm test\n说明' }, ex);
  ok('15.1 首行为空被拦下（不再 spawn 空命令）', !r.ok && r.text.includes('第一行'), r.text.slice(0, 50));

  const r2 = await R.task_create.execute({ type: 'job', title: 'spaces', objective: '   \n echo hi' }, ex);
  ok('15.2 首行全是空白也拦', !r2.ok, r2.text.slice(0, 40));

  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  ok('15.3 已无 execSync（不再同步阻塞事件循环）', !/import\s*\{[^}]*execSync/.test(src) && !/execSync\(/.test(src),
    /execSync\(/.test(src) ? '仍有调用' : '已清除');

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 16. P2-8 job 探活补账：结算事件缺失时不再永远 running
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v022-jobscan-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'js');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=jobscan`);
  const R = {};
  // jobNative 控制 ctx.jobs.get 的返回：模拟「结算事件没送来，但原生其实已结束」
  const jobNative = { 'nj-done': { status: 'completed', detail: 'exit 0' }, 'nj-run': { status: 'running' } };
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: {
      start() { return 'nj-run'; },
      get(id) { return jobNative[id]; },
      readAt() { return { chunks: [] }; }, kill() {},
      // 故意不提供 events.subscribe —— 模拟结算事件通路不存在
    },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-js', session: { id: 's-js' } } };
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'js', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };

  const r = await R.task_create.execute({ type: 'job', title: 'lostsettle', objective: 'echo hi' }, ex);
  const tid = r.text.match(/taskId=([\w-]+)/)?.[1];
  // 台账记的 nativeId='nj-run'；把原生改成已完成，模拟「事件丢了但 job 早结束」
  set("UPDATE tasks SET native_id='nj-done' WHERE id=?", tid);
  await R.task_list.execute({ all: true }, ex);
  const st = get1("SELECT status,result_summary FROM tasks WHERE id=?", tid);
  ok('16.1 结算事件缺失时，job 探活补账为 succeeded', st.status === 'succeeded', `${st.status} / ${st.result_summary}`);

  // 还在跑的 job 不许被碰
  const r2 = await R.task_create.execute({ type: 'job', title: 'stillrun', objective: 'echo hi' }, ex);
  const tid2 = r2.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_list.execute({ all: true }, ex);
  ok('16.2 还在跑的 job 不动', get1("SELECT status FROM tasks WHERE id=?", tid2).status === 'running',
    get1("SELECT status FROM tasks WHERE id=?", tid2).status);

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 17. P2-5 task_context 暴露 expectedVersion：并发覆盖能被检测
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v022-ctx-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'cx');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=ctxver`);
  const R = {};
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: { get() { return undefined; } },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 's-cx', session: { id: 's-cx' } } };
  const r = await R.task_create.execute({ type: 'subagent', title: 'ctxrace', objective: 'x' }, ex);
  const tid = r.text.match(/taskId=([\w-]+)/)?.[1];

  // 代理 A 写第一版
  let w = await R.task_context.execute({ taskId: tid, stage: 'A写的' }, ex);
  ok('17.1 首写成功（v1）', w.ok && /v1/.test(w.text), w.text.slice(0, 30));

  // 代理 B 基于 v1 写 —— 应该成功，变成 v2
  w = await R.task_context.execute({ taskId: tid, stage: 'B写的', expectedVersion: 1 }, ex);
  ok('17.2 基于正确版本写成功（v2）', w.ok && /v2/.test(w.text), w.text.slice(0, 40));

  // 代理 A 还拿旧的 v1 写 —— 必须被拒，不能覆盖 B
  w = await R.task_context.execute({ taskId: tid, stage: 'A又写的', expectedVersion: 1 }, ex);
  ok('17.3 基于过期版本被拒（不覆盖别人）', !w.ok && w.text.includes('版本冲突'), w.text.slice(0, 50));

  // 读回来确认是 B 的内容，没被 A 覆盖
  const c = await R.task_context.execute({ taskId: tid }, ex);
  ok('17.4 内容仍是 B 写的', c.text.includes('B写的') && !c.text.includes('A又写的'), c.text.split('\n')[1]);

  // 不传 expectedVersion 时仍是旧行为（能写，但不保证并发安全）
  w = await R.task_context.execute({ taskId: tid, stage: 'C写的' }, ex);
  ok('17.5 不传 expectedVersion 仍可用（向后兼容）', w.ok, w.text.slice(0, 30));

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 18. P2-9 终态通知真投递：自产终态要投到发起会话，原生结算不重复投
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v022-notify-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'nt');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=notify`);
  const R = {}, listeners = {}, inbox = [];
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) {
        // 发起会话有活 agent，收通知
        return id === 'owner-N' ? {
          status: {},
          followup(m) { inbox.push({ to: id, text: m.content?.[0]?.text }); },
          steer() {}, cancel() {},
        } : undefined;
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } },
    on(ev, fn) { listeners[ev] = fn; return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const ex = { agent: { id: 'owner-N', session: { id: 'owner-N' } } };
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'nt', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };

  // 18.1 原生结算（subagent/end）不该再投一条 —— 前台本来就会收到
  let r = await R.task_create.execute({ type: 'subagent', title: 'native-end', objective: 'x' }, ex);
  const t1 = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: t1, agentId: 'agN', sessionId: 'sess-N1' }, ex);
  set("UPDATE tasks SET native_session_id='sess-N1', status='running' WHERE id=?", t1);
  inbox.length = 0;
  listeners['subagent/end']({ id: 'sess-N1', stopReason: 'completed' });
  ok('18.1 原生结算不重复投通知（避免噪音）', inbox.length === 0, `${inbox.length} 条`);

  // 18.2 协调器自产的 lost（探活兜底）必须真投
  const r2 = await R.task_create.execute({ type: 'subagent', title: 'will-lost', objective: 'x' }, ex);
  const t2 = r2.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: t2, agentId: 'agL', sessionId: 'sess-GONER' }, ex);
  set("UPDATE tasks SET native_session_id='sess-GONER', status='running' WHERE id=?", t2);
  inbox.length = 0;
  await R.task_list.execute({ all: true }, ex);   // 第 1 轮：miss 1
  await R.task_list.execute({ all: true }, ex);   // 第 2 轮：落 lost + 投通知
  ok('18.2 自产 lost 真投到发起会话', inbox.some((m) => String(m.text).includes(t2) && String(m.text).includes('lost')),
    JSON.stringify(inbox.map((m) => m.text)).slice(0, 120));

  // 18.3 事件流水如实写「已投递」
  const ev = get1("SELECT payload FROM task_events WHERE task_id=? AND event_type='task.notified'", t2);
  ok('18.3 事件流水写的是已投递', String(ev?.payload ?? '').includes('已投递'), ev?.payload);

  // 18.4 幂等：同一个终态不会投两遍
  const n1 = inbox.length;
  await R.task_list.execute({ all: true }, ex);
  ok('18.4 同一终态不重复投', inbox.length === n1, `${n1} → ${inbox.length}`);

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 19. 0.2.3（Gemini 补丁采纳）：GBK 两个边界 + 归属隔离 + cancel 语义
// ---------------------------------------------------------------------------
{
  // 19.1–19.2 解码器边界：直接拿 index.js 里的 makeChunkDecoder 做单元测试
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const s0 = src.indexOf('function makeChunkDecoder()');
  const s1 = src.indexOf('// ---------------------------------------------------------------------------\n// 台账存储');
  const mk = new Function(src.slice(s0, s1) + '; return makeChunkDecoder;')();

  // 「A中」= 41 D6 D0 一次给完：旧实现 end() 直接 toString('utf8') 会出 "A��"
  const d1 = mk();
  const o1 = d1(Buffer.from([0x41, 0xD6, 0xD0])) + d1.end();
  ok('19.1 短 GBK 单包（A中）正确解码', o1 === 'A中', JSON.stringify(o1));

  // 「丂」= 81 40 跨包：0x40 落在 ASCII 区，旧实现会旁路 pending 提前吐出 → 乱序乱码
  const d2 = mk();
  const o2 = d2(Buffer.from([0x81])) + d2(Buffer.from([0x40, 0x0A])) + d2.end();
  ok('19.2 次字节落在 ASCII 区的跨包汉字不乱码', o2.includes('丂'), JSON.stringify(o2));

  // 原有能力不许退化
  const d3 = mk();
  const o3 = d3(Buffer.from('ABC\n', 'utf8')) + d3(Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x0A])) + d3.end();
  ok('19.3 先 ASCII 后 GBK 仍然正确', o3.includes('中文'), JSON.stringify(o3));
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v023-iso-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'iso');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=iso`);
  const R = {}, cancelArgs = {};
  const alive = new Set();
  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) { return alive.has(id) ? { status: {}, followup() {}, steer() {}, cancel(a, b) { cancelArgs[id] = b; } } : undefined; },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } }, on() { return () => {}; },
  });
  mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'iso', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };

  const A = { agent: { id: 'owner-A', session: { id: 'owner-A' } } };
  const B = { agent: { id: 'owner-B', session: { id: 'owner-B' } } };

  // 19.4 归属隔离：B 调 task_list 不许把 A 的任务探活掉
  let r = await R.task_create.execute({ type: 'subagent', title: 'A的任务', objective: 'x' }, A);
  const tA = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tA, agentId: 'agA', sessionId: 'sess-GONE-A' }, A);
  set("UPDATE tasks SET native_session_id='sess-GONE-A', status='running' WHERE id=?", tA);
  // B 连查两轮
  await R.task_list.execute({ all: true }, B);
  await R.task_list.execute({ all: true }, B);
  ok('19.4 别人的会话扫描不会动我的任务', get1("SELECT status FROM tasks WHERE id=?", tA).status === 'running',
    get1("SELECT status FROM tasks WHERE id=?", tA).status);
  // A 自己查两轮才落 lost
  await R.task_list.execute({ all: true }, A);
  await R.task_list.execute({ all: true }, A);
  ok('19.5 自己的会话查两轮能收掉', get1("SELECT status FROM tasks WHERE id=?", tA).status === 'lost',
    get1("SELECT status FROM tasks WHERE id=?", tA).status);

  // 19.6 cancel 传 keepInbox:false（取消不是暂停）
  r = await R.task_create.execute({ type: 'subagent', title: 'to-cancel', objective: 'x' }, A);
  const tK = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tK, agentId: 'agK', sessionId: 'sess-K' }, A);
  set("UPDATE tasks SET native_session_id='sess-K', status='running' WHERE id=?", tK);
  alive.add('sess-K');
  await R.task_cancel.execute({ taskId: tK, reason: 'kill it' }, A);
  ok('19.6 cancel 传 keepInbox:false（不留队列）', cancelArgs['sess-K']?.keepInbox === false,
    JSON.stringify(cancelArgs['sess-K']));

  // 19.7 已绑定的活动任务不许被二次登记换目标
  const r2 = await R.task_register_delegation.execute({ taskId: tK, agentId: 'ag-OTHER', sessionId: 'sess-OTHER' }, A);
  ok('19.7 已绑定任务拒绝换目标重登记', !r2.ok && r2.text.includes('不能重复覆盖'), r2.text.slice(0, 40));

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 20. 0.2.4：复核闭环修复（重复通知 / job 探活隔离与异常 / 早到取消补投 /
//     interruptByParent / suspectNote / 空 exec 不冒充 / 超时清账 / dispose）
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v024-fixes-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'v024');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;

  const mod = await import(`${ROOT}/index.js?sec=v024`);
  const R = {}, listeners = {}, inbox = [], getCallers = [], killCallers = [], interruptCalls = [];
  let jobSub = null;
  let jobSeq = 0;
  const jobState = new Map(); // id -> { status } | Error
  const agentHandles = new Map();

  const ctx = mkCtx({
    logger: { info: () => {} },
    jobs: {
      start() {
        const id = `nj24-${++jobSeq}`;
        jobState.set(id, { status: 'running' });
        return id;
      },
      get(id, caller) {
        getCallers.push({ id, caller });
        const v = jobState.get(id);
        if (v instanceof Error) throw v;
        return v;
      },
      readAt() { return { chunks: [] }; },
      kill(id, caller, reason) {
        killCallers.push({ id, caller, reason });
      },
      events: {
        subscribe(_f, fn) { jobSub = fn; return () => { jobSub = null; }; },
      },
    },
    agents: {
      get(id) { return agentHandles.get(id); },
    },
    subagents: {
      interruptByParent(childSid, parentSid, mode) {
        interruptCalls.push({ childSid, parentSid, mode });
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R[t.name] = t; } },
    on(ev, fn) { listeners[ev] = fn; return () => {}; },
  });

  const dispose = mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
  const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'v024', 'tasks.db');
  const { DatabaseSync } = await import('node:sqlite');
  const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
  const set = (sql, ...a) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...a); w.close(); };

  const A = { agent: { id: 'owner-24A', session: { id: 'owner-24A' } } };
  const B = { agent: { id: 'owner-24B', session: { id: 'owner-24B' } } };
  agentHandles.set('owner-24A', {
    status: {},
    followup(m) { inbox.push({ to: 'owner-24A', text: m.content?.[0]?.text }); },
    steer() {}, cancel() {},
  });

  // 20.1 原生 jobs.events settled 不应重复投递 followup 通知
  let r = await R.task_create.execute({ type: 'job', title: 'j-native-settle', objective: 'echo ok' }, A);
  const tj1 = r.text.match(/taskId=([\w-]+)/)?.[1];
  const nj1 = get1("SELECT native_id FROM tasks WHERE id=?", tj1).native_id;
  inbox.length = 0;
  jobSub({ type: 'settled', job: { id: nj1, status: 'completed', detail: 'exit 0' } });
  const evJ1 = get1("SELECT payload FROM task_events WHERE task_id=? AND event_type='task.notified'", tj1);
  ok('20.1 原生 job settled 不重复投 followup 通知',
    get1("SELECT status FROM tasks WHERE id=?", tj1).status === 'succeeded'
      && inbox.length === 0
      && String(evJ1?.payload ?? '').includes('不重复投递'),
    `inbox=${inbox.length} payload=${evJ1?.payload}`);

  // 20.2 sweepJobsOnce 归属隔离 + 查询抛错不计 miss
  r = await R.task_create.execute({ type: 'job', title: 'j-iso', objective: 'echo iso' }, A);
  const tj2 = r.text.match(/taskId=([\w-]+)/)?.[1];
  const nj2 = get1("SELECT native_id FROM tasks WHERE id=?", tj2).native_id;
  jobState.set(nj2, { status: 'completed', detail: 'done' });
  // B 调 task_list 不许把 A 的 job 扫成 succeeded
  await R.task_list.execute({ all: true }, B);
  ok('20.2a task_list 的 job 探活归属隔离（B 不动 A 的 job）',
    get1("SELECT status FROM tasks WHERE id=?", tj2).status === 'running',
    get1("SELECT status FROM tasks WHERE id=?", tj2).status);
  // jobs.get 连续抛瞬时异常时，A 多次查也不许把 job 误杀成 lost
  jobState.set(nj2, new Error('E_TRANSIENT_REGISTRY'));
  await R.task_list.execute({ all: true }, A);
  await R.task_list.execute({ all: true }, A);
  await R.task_list.execute({ all: true }, A);
  ok('20.2b job 探活抛瞬时异常不计 miss（不误杀成 lost）',
    get1("SELECT status FROM tasks WHERE id=?", tj2).status === 'running',
    get1("SELECT status FROM tasks WHERE id=?", tj2).status);
  // 恢复终态后，A 自己查能补账
  jobState.set(nj2, { status: 'completed', detail: 'exit 0' });
  await R.task_list.execute({ all: true }, A);
  ok('20.2c 恢复正常后 A 自己查能补账',
    get1("SELECT status FROM tasks WHERE id=?", tj2).status === 'succeeded',
    get1("SELECT status FROM tasks WHERE id=?", tj2).status);

  // 20.3 earlyEnds 回放后取消绑定前 pending 消息，绝不唤醒已结束子代理；且保留 status 兜底字段
  r = await R.task_create.execute({ type: 'subagent', title: 'early-pend', objective: 'x' }, A);
  const tEP = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_append_message.execute({ taskId: tEP, content: '请先别提交' }, A);
  const woke = [];
  agentHandles.set('sess-EARLY-P', {
    status: {},
    followup(m) { woke.push(m); },
    steer(m) { woke.push(m); },
  });
  // 用 status:'error'（不传 stopReason）模拟早到事件，验证兜底字段也保留
  listeners['subagent/end']({ id: 'sess-EARLY-P', status: 'error' });
  const rbEP = await R.task_register_delegation.execute(
    { taskId: tEP, agentId: 'agEP', sessionId: 'sess-EARLY-P' }, A);
  const msgEP = get1("SELECT status FROM task_messages WHERE task_id=?", tEP);
  ok('20.3a 早到结算回放保留非 stopReason 兜底字段 → failed',
    get1("SELECT status FROM tasks WHERE id=?", tEP).status === 'failed',
    get1("SELECT status FROM tasks WHERE id=?", tEP).status);
  ok('20.3b 早到结算回放不唤醒已结束子代理，pending 改 cancelled',
    woke.length === 0 && msgEP?.status === 'cancelled' && rbEP.text.includes('未唤醒'),
    `woke=${woke.length} msg=${msgEP?.status}`);

  // 20.4 task_cancel 走 interruptByParent 时传真实 row.ownerSessionId（不再是 undefined）
  r = await R.task_create.execute({ type: 'subagent', title: 'no-cancel-ag', objective: 'x' }, A);
  const tIBP = r.text.match(/taskId=([\w-]+)/)?.[1];
  agentHandles.set('sess-IBP', { status: {}, followup() {}, steer() {} }); // 故意没有 cancel 方法
  await R.task_register_delegation.execute({ taskId: tIBP, agentId: 'agIBP', sessionId: 'sess-IBP' }, A);
  interruptCalls.length = 0;
  // 空 exec 调用，验证回退能拿到 row.ownerSessionId（'owner-24A'），而不是 undefined
  const rIBP = await R.task_cancel.execute({ taskId: tIBP, reason: 'stop-ibp' }, {});
  ok('20.4 task_cancel 调 interruptByParent 收到真实 parentSessionId',
    interruptCalls.length === 1
      && interruptCalls[0].childSid === 'sess-IBP'
      && interruptCalls[0].parentSid === 'owner-24A'
      && rIBP.text.includes('interruptByParent'),
    JSON.stringify(interruptCalls));

  // 20.5 task_list 在有活动行（rows.length > 0）时也能展示首次未命中的 suspectNote
  r = await R.task_create.execute({ type: 'subagent', title: 'suspect-row', objective: 'x' }, A);
  const tSus = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tSus, agentId: 'agSus', sessionId: 'sess-MISS1' }, A);
  // sess-MISS1 不在 agentHandles 中，第 1 轮 task_list 应保留 running 并带出「首次探活未命中」提示
  const list1 = await R.task_list.execute({ all: false }, A);
  ok('20.5 task_list 非空列表也能展示首次探活未命中提示',
    list1.text.includes('首次探活未命中') && list1.text.includes(tSus),
    list1.text.split('\n')[0]);

  // 20.6 空 exec.agent 在 task_describe / task_cancel 中不再冒充 own.owner
  r = await R.task_create.execute({ type: 'job', title: 'j-no-impersonate', objective: 'echo x' }, A);
  const tjNoImp = r.text.match(/taskId=([\w-]+)/)?.[1];
  const njNoImp = get1("SELECT native_id FROM tasks WHERE id=?", tjNoImp).native_id;
  getCallers.length = 0;
  killCallers.length = 0;
  await R.task_describe.execute({ taskId: tjNoImp }, {});
  await R.task_cancel.execute({ taskId: tjNoImp, reason: 'empty-exec' }, {});
  const descCall = getCallers.find((c) => c.id === njNoImp);
  const killCall = killCallers.find((c) => c.id === njNoImp);
  ok('20.6 空 exec.agent 不冒充 owner（describe/cancel 均传 undefined）',
    descCall && descCall.caller === undefined && killCall && killCall.caller === undefined,
    `desc=${JSON.stringify(descCall)} kill=${JSON.stringify(killCall)}`);

  // 20.7 task_context 拒绝浮点 expectedVersion；nativeSessionId 为空时 describe/append 如实提示
  const rFloat = await R.task_context.execute({ taskId: tSus, stage: 'x', expectedVersion: 1.5 }, A);
  ok('20.7a task_context 拒绝非整数 expectedVersion（1.5）',
    !rFloat.ok && rFloat.text.includes('非负整数'), rFloat.text.slice(0, 50));

  r = await R.task_create.execute({ type: 'subagent', title: 'no-sid', objective: 'x' }, A);
  const tNoSid = r.text.match(/taskId=([\w-]+)/)?.[1];
  await R.task_register_delegation.execute({ taskId: tNoSid, agentId: 'agNoSid' }, A);
  const descNoSid = await R.task_describe.execute({ taskId: tNoSid }, A);
  const appNoSid = await R.task_append_message.execute({ taskId: tNoSid, content: 'hello' }, A);
  ok('20.7b nativeSessionId 为空时 describe 不误报已不在，append 如实说明未解析出会话 id',
    descNoSid.text.includes('未解析出会话 id')
      && !descNoSid.text.includes('原生活体已不在')
      && !appNoSid.ok
      && appNoSid.text.includes('未解析出会话 id'),
    `desc=${descNoSid.text.includes('未解析出会话 id')} app=${appNoSid.text.slice(0, 40)}`);

  // 20.8 task_create 兼容仅有 exec.agent.session.id（无 exec.agent.id）的宿主
  const rSessOnly = await R.task_create.execute(
    { type: 'subagent', title: 'sess-only-owner', objective: 'x' },
    { agent: { session: { id: 'sess-only-99' } } },
  );
  const tSO = rSessOnly.text.match(/taskId=([\w-]+)/)?.[1];
  ok('20.8 task_create 识别 exec.agent.session.id 作为 ownerSessionId',
    get1("SELECT owner_session_id FROM tasks WHERE id=?", tSO)?.owner_session_id === 'sess-only-99',
    get1("SELECT owner_session_id FROM tasks WHERE id=?", tSO)?.owner_session_id);

  // 20.9 dispose() 后清掉 ACTIVE_CTX，不会再往旧 ctx 发通知；且超时清账能收掉无 sessionId 的 subagent
  dispose();

  // 新启一个 sweepSeconds=1 的实例专门验证超时清账收尾 + dispose 清理
  const R2 = {}, inbox2 = [];
  const ctx2 = mkCtx({
    logger: { info: () => {} },
    jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() {}, events: { subscribe() { return () => {}; } } },
    agents: {
      get(id) {
        return id === 'owner-24T' ? {
          status: {},
          followup(m) { inbox2.push({ to: id, text: m.content?.[0]?.text }); },
          steer() {}, cancel() {},
        } : undefined;
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
    sandbox: { confine: async (a) => ({ argv: a }) },
    tools: { register(t) { R2[t.name] = t; } },
    on() { return () => {}; },
  });
  const dispose2 = mod.default.apply(ctx2, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 1, retentionDays: 30 });
  const exT = { agent: { id: 'owner-24T', session: { id: 'owner-24T' } } };
  const rt1 = await R2.task_create.execute({ type: 'subagent', title: 'overdue-cancel-nosid', objective: 'x' }, exT);
  const tOT = rt1.text.match(/taskId=([\w-]+)/)?.[1];
  await R2.task_register_delegation.execute({ taskId: tOT, agentId: 'agOT' }, exT);
  await R2.task_cancel.execute({ taskId: tOT, reason: 'give up' }, exT); // 进入 cancel_requested（无 sessionId）
  // 把 deadline 拨到过去，等 1 轮 sweepTimer（1s）收尾
  set("UPDATE tasks SET labels=? WHERE id=?", JSON.stringify({ deadlineAt: String(Date.now() - 10_000) }), tOT);
  await new Promise((res) => setTimeout(res, 1300));
  const stOT = get1("SELECT status FROM tasks WHERE id=?", tOT)?.status;
  ok('20.9a sweepTimer 自动将超时且无 sessionId 的 cancel_requested subagent 落 lost 并通知',
    stOT === 'lost' && inbox2.some((m) => String(m.text).includes(tOT)),
    `status=${stOT} inbox=${inbox2.length}`);

  dispose2();
  // 静态核对 dispose 确实清掉了 ACTIVE_CTX（模块级变量不暴露给外部）
  const idxSrc = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  ok('20.9b dispose() 清理 ACTIVE_CTX / missStreak / earlyEnds',
    /ACTIVE_CTX\s*=\s*null/.test(idxSrc) && /missStreak\.clear\(\)/.test(idxSrc) && /earlyEnds\.clear\(\)/.test(idxSrc),
    'checked');

  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  rm(home);
}

// ---------------------------------------------------------------------------
// 21. 0.2.4 安全与状态加固：
//     ① 子进程 env 凭据过滤（对齐 DSH scrubbedParentEnv）
//     ② 首次绑定验证子代理父子归属（subagents + metadata + 台账防跨会话）
//     ③ jobs.kill 回执感知（requested 不提前谎报已取消）
//     ④ 同名 profile 路径防碰撞 + SQLite 落盘脱敏 + 迁移删源不留 .migrated + 权限收紧
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v024-sec-'));
  const saved = {
    U: process.env.USERPROFILE, H: process.env.HOME,
    P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS,
    K1: process.env.DEEPSEEK_API_KEY, K2: process.env.GITHUB_TOKEN,
    K3: process.env.DB_PASSWORD, K4: process.env.DSH_INTERNAL_SECRET_TEST,
    K5: process.env.SAFE_COORDINATOR_KEEP,
  };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'sec24');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_COORD_LIMITS;
  process.env.DEEPSEEK_API_KEY = 'sk-host-secret-1234567890abcdef';
  process.env.GITHUB_TOKEN = 'ghp_hosttoken1234567890abcdef';
  process.env.DB_PASSWORD = 'super-secret-password';
  process.env.DSH_INTERNAL_SECRET_TEST = 'internal-dsh-val';
  process.env.SAFE_COORDINATOR_KEEP = 'safe-keep-val';

  const mod = await import(`${ROOT}/index.js?sec=sec24`);

  // ---- 21.1 子进程 env 过滤（danger-full-access 与 sandbox.confine 两条分支均验证） ----
  for (const [tag, mode] of [['21.1a', 'danger-full-access'], ['21.1b', 'workspace-write']]) {
    const R = {};
    const outChunks = [];
    let jobDone = null;
    const ctx = mkCtx({
      logger: { info: () => {} },
      jobs: {
        start(spec) {
          const h = spec.run({
            append(s) { outChunks.push(s); },
            updateProgress() {},
          });
          jobDone = h.done;
          return `nj-${tag}`;
        },
        get() { return { status: 'running' }; },
        readAt() { return { chunks: [] }; },
        kill() { return 'requested'; },
        events: { subscribe() { return () => {}; } },
      },
      agents: { get() { return undefined; } },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode }) },
      sandbox: {
        confine: async (argv) => ({ argv, env: { SANDBOX_INJECTED: 'from-sandbox' } }),
      },
      tools: { register(t) { R[t.name] = t; } },
      on() { return () => {}; },
    });
    const dispose = mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
    const ex = { agent: { id: `owner-${tag}`, session: { id: `owner-${tag}` } } };
    const probeScript = 'console.log(JSON.stringify({k:process.env.DEEPSEEK_API_KEY||null,t:process.env.GITHUB_TOKEN||null,p:process.env.DB_PASSWORD||null,d:process.env.DSH_INTERNAL_SECRET_TEST||null,s:process.env.SAFE_COORDINATOR_KEEP||null,sb:process.env.SANDBOX_INJECTED||null}))';
    // 0.2.5：命令构造按平台分支。
    // 原写法 `"${execPath}" -e "${script}"` 在 Linux 上没问题（bash 会剥引号），
    // 但 Windows 走 cmd /d /s /c + windowsVerbatimArguments，引号会变成字面量
    // （正是 0.2.0 修过的坑）。
    //
    // 而 `process.execPath` 在这台机器上是 `C:\Program Files\DSH NEXT\...\node.exe`——
    // 不加引号会被空格劈开，加引号又变字面量。两头堵。
    // 解法：Windows 上改用 PATH 里的 node（无空格）+ 临时脚本文件。
    let cmd;
    if (process.platform === 'win32') {
      const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envprobe-'));
      const scriptFile = path.join(scriptDir, 'probe.cjs');
      fs.writeFileSync(scriptFile, `${probeScript}\n`, 'utf8');
      // 用裸 `node`（PATH 解析），路径也只有 tmpdir 一段，都不含空格
      cmd = `node ${scriptFile}`;
    } else {
      cmd = `"${process.execPath}" -e "${probeScript.replace(/"/g, '\\"')}"`;
    }
    await R.task_create.execute({ type: 'job', title: `env-${tag}`, objective: cmd }, ex);
    if (jobDone) await jobDone;
    dispose();
    const joined = outChunks.join('').trim();
    let parsed = null;
    try { parsed = JSON.parse(joined.split(/\r?\n/).pop()); } catch { /* ignore */ }
    const noLeaks = parsed && parsed.k === null && parsed.t === null && parsed.p === null && parsed.d === null && parsed.s === 'safe-keep-val';
    const sbOk = mode === 'workspace-write' ? parsed?.sb === 'from-sandbox' : true;
    ok(`${tag} 子进程过滤宿主凭据与 DSH_*（${mode}）`, !!(noLeaks && sbOk), joined.slice(0, 120));
  }

  // ---- 21.2 首次绑定验证子代理父子归属 ----
  {
    const R = {};
    const childInbox = [];
    const subTree = {
      'owner-A': [{ id: 'sess-A-child', label: 'workerA', createdAt: 100 }],
      'owner-B': [{ id: 'sess-B-child', label: 'workerB', createdAt: 100 }],
    };
    const ctx = mkCtx({
      logger: { info: () => {} },
      jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() { return 'requested'; }, events: { subscribe() { return () => {}; } } },
      agents: {
        get(id) {
          if (id === 'sess-A-child') return { status: {}, followup(m) { childInbox.push(m); }, steer() {}, cancel() {} };
          if (id === 'sess-B-child') return { status: {}, followup() {}, steer() {}, cancel() {} };
          return undefined;
        },
      },
      subagents: {
        async listChildren(parentSid) { return subTree[parentSid] ?? []; },
      },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
      sandbox: { confine: async (a) => ({ argv: a }) },
      tools: { register(t) { R[t.name] = t; } },
      on() { return () => {}; },
    });
    const dispose = mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
    const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'sec24', 'tasks.db');
    const { DatabaseSync } = await import('node:sqlite');
    const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };

    const A = { agent: { id: 'owner-A', session: { id: 'owner-A' } } };
    const B = { agent: { id: 'owner-B', session: { id: 'owner-B' } } };

    // B 建自己的任务，但企图首次绑定 A 的子代理 sess-A-child
    let r = await R.task_create.execute({ type: 'subagent', title: 'B-hijack', objective: 'x' }, B);
    const tB = r.text.match(/taskId=([\w-]+)/)?.[1];
    await R.task_append_message.execute({ taskId: tB, content: 'injected-by-B' }, B);
    const rHijack = await R.task_register_delegation.execute(
      { taskId: tB, agentId: 'workerA', sessionId: 'sess-A-child' }, B);
    ok('21.2a 首次绑定拒绝跨会话认领别人的子代理（listChildren 校验）',
      !rHijack.ok
        && rHijack.text.includes('拒绝绑定')
        && get1("SELECT status,native_session_id FROM tasks WHERE id=?", tB).status === 'queued'
        && childInbox.length === 0,
      `ok=${rHijack.ok} text=${rHijack.text.slice(0, 50)} inbox=${childInbox.length}`);

    // A 绑定自己的子代理 sess-A-child 正常通过
    r = await R.task_create.execute({ type: 'subagent', title: 'A-legit', objective: 'x' }, A);
    const tA = r.text.match(/taskId=([\w-]+)/)?.[1];
    const rLegit = await R.task_register_delegation.execute(
      { taskId: tA, agentId: 'workerA', sessionId: 'sess-A-child' }, A);
    ok('21.2b 合法父会话绑定自己的子代理成功',
      rLegit.ok && get1("SELECT native_session_id,status FROM tasks WHERE id=?", tA).native_session_id === 'sess-A-child',
      rLegit.text.split('\n')[0]);

    dispose();

    // 21.2c 无 subagents 服务时：agent 句柄 parentSessionId 不匹配 + SQLite 跨会话占用 均被拒绝
    const R2 = {};
    const ctxNoSub = mkCtx({
      logger: { info: () => {} },
      jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() { return 'requested'; }, events: { subscribe() { return () => {}; } } },
      agents: {
        get(id) {
          if (id === 'sess-META-A') return { status: {}, parentSessionId: 'owner-A', followup() {}, steer() {}, cancel() {} };
          return undefined;
        },
      },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
      sandbox: { confine: async (a) => ({ argv: a }) },
      tools: { register(t) { R2[t.name] = t; } },
      on() { return () => {}; },
    });
    const dispose2 = mod.default.apply(ctxNoSub, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
    const rB2 = await R2.task_create.execute({ type: 'subagent', title: 'B-hijack-2', objective: 'x' }, B);
    const tB2 = rB2.text.match(/taskId=([\w-]+)/)?.[1];
    const rMeta = await R2.task_register_delegation.execute(
      { taskId: tB2, agentId: 'metaA', sessionId: 'sess-META-A' }, B);
    ok('21.2c 无 subagents 服务时按 agent.parentSessionId 拒绝跨会话绑定',
      !rMeta.ok && rMeta.text.includes('拒绝绑定'), rMeta.text.slice(0, 50));

    // sess-A-child 已被 owner-A 的 tA 写入 SQLite，即便无 subagents 也拒绝 B 再绑它
    const rDbConflict = await R2.task_register_delegation.execute(
      { taskId: tB2, agentId: 'dupA', sessionId: 'sess-A-child' }, B);
    ok('21.2d SQLite 跨会话防冲突：已被其他会话绑定的 sessionId 拒绝再次绑定',
      !rDbConflict.ok && rDbConflict.text.includes('其他会话'), rDbConflict.text.slice(0, 50));
    dispose2();
  }

  // ---- 21.3 jobs.kill 回执感知（requested 不提前谎报已取消） ----
  {
    const R = {};
    let jobSub = null;
    let seq = 0;
    const jobViews = new Map();
    const killMode = new Map(); // nativeId -> 'requested' | 'sync-settle' | 'already-finished' | 'void-stopping'
    const ctx = mkCtx({
      logger: { info: () => {} },
      jobs: {
        start() {
          const id = `nj-k-${++seq}`;
          jobViews.set(id, { status: 'running' });
          return id;
        },
        get(id) { return jobViews.get(id); },
        readAt() { return { chunks: [] }; },
        kill(id) {
          const m = killMode.get(id) ?? 'requested';
          if (m === 'requested') {
            jobViews.set(id, { status: 'stopping' });
            return 'requested';
          }
          if (m === 'sync-settle') {
            jobViews.set(id, { status: 'killed', detail: 'sync killed' });
            jobSub?.({ type: 'settled', job: { id, status: 'killed', detail: 'sync killed' } });
            return 'requested';
          }
          if (m === 'already-finished') {
            jobViews.set(id, { status: 'completed', detail: 'exit 0' });
            return 'already-finished';
          }
          if (m === 'void-stopping') {
            jobViews.set(id, { status: 'stopping' });
            return undefined;
          }
          return 'requested';
        },
        events: { subscribe(_f, fn) { jobSub = fn; return () => { jobSub = null; }; } },
      },
      agents: { get() { return undefined; } },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
      sandbox: { confine: async (a) => ({ argv: a }) },
      tools: { register(t) { R[t.name] = t; } },
      on() { return () => {}; },
    });
    const dispose = mod.default.apply(ctx, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
    const dbp = path.join(home, '.dsh', 'background-task-coordinator', 'sec24', 'tasks.db');
    const { DatabaseSync } = await import('node:sqlite');
    const get1 = (sql, ...a) => { const ro = new DatabaseSync(dbp, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };
    const ex = { agent: { id: 'owner-K', session: { id: 'owner-K' } } };

    // 21.3a requested → 必须落 cancel_requested，不提前说「已取消」
    let r = await R.task_create.execute({ type: 'job', title: 'k-req', objective: 'echo 1' }, ex);
    const tReq = r.text.match(/taskId=([\w-]+)/)?.[1];
    const nReq = get1("SELECT native_id FROM tasks WHERE id=?", tReq).native_id;
    killMode.set(nReq, 'requested');
    const rK1 = await R.task_cancel.execute({ taskId: tReq, reason: 'stop-req' }, ex);
    ok('21.3a jobs.kill 返回 requested 时落 cancel_requested，不提前谎报已取消',
      get1("SELECT status FROM tasks WHERE id=?", tReq).status === 'cancel_requested'
        && rK1.text.includes('已请求取消')
        && !rK1.text.includes('已取消'),
      rK1.text.slice(0, 70));

    // 21.3b 随后原生 settled 到达 → 正常转成 cancelled
    jobSub({ type: 'settled', job: { id: nReq, status: 'killed', detail: 'killed by SIGKILL' } });
    ok('21.3b 后续原生 settled 事件到达后正确落 cancelled',
      get1("SELECT status FROM tasks WHERE id=?", tReq).status === 'cancelled',
      get1("SELECT status FROM tasks WHERE id=?", tReq).status);

    // 21.3c 同步触发 settled 时沿用终态不回退
    r = await R.task_create.execute({ type: 'job', title: 'k-sync', objective: 'echo 2' }, ex);
    const tSync = r.text.match(/taskId=([\w-]+)/)?.[1];
    const nSync = get1("SELECT native_id FROM tasks WHERE id=?", tSync).native_id;
    killMode.set(nSync, 'sync-settle');
    const rK2 = await R.task_cancel.execute({ taskId: tSync, reason: 'stop-sync' }, ex);
    ok('21.3c jobs.kill 同步触发 settled 时保持终态 cancelled 不覆盖',
      get1("SELECT status FROM tasks WHERE id=?", tSync).status === 'cancelled' && rK2.text.includes('已取消'),
      rK2.text.slice(0, 60));

    // 21.3d already-finished + 原生 completed → 诚实落 succeeded（不假装 cancelled）
    r = await R.task_create.execute({ type: 'job', title: 'k-fin', objective: 'echo 3' }, ex);
    const tFin = r.text.match(/taskId=([\w-]+)/)?.[1];
    const nFin = get1("SELECT native_id FROM tasks WHERE id=?", tFin).native_id;
    killMode.set(nFin, 'already-finished');
    const rK3 = await R.task_cancel.execute({ taskId: tFin, reason: 'too-late' }, ex);
    ok('21.3d jobs.kill 返回 already-finished 且原生已完成时如实落 succeeded',
      get1("SELECT status FROM tasks WHERE id=?", tFin).status === 'succeeded' && rK3.text.includes('succeeded'),
      rK3.text.slice(0, 60));

    // 21.3e 无回执（undefined）但 jobs.get 仍报 stopping → 保持 cancel_requested
    r = await R.task_create.execute({ type: 'job', title: 'k-void', objective: 'echo 4' }, ex);
    const tVoid = r.text.match(/taskId=([\w-]+)/)?.[1];
    const nVoid = get1("SELECT native_id FROM tasks WHERE id=?", tVoid).native_id;
    killMode.set(nVoid, 'void-stopping');
    const rK4 = await R.task_cancel.execute({ taskId: tVoid, reason: 'stop-void' }, ex);
    ok('21.3e jobs.kill 无回执但原生仍为 stopping 时不提前落 cancelled',
      get1("SELECT status FROM tasks WHERE id=?", tVoid).status === 'cancel_requested'
        && rK4.text.includes('已请求取消'),
      rK4.text.slice(0, 70));

    dispose();
  }

  // ---- 21.4 本地数据隔离与留存（同名 profile 隔离 + SQLite 脱敏 + 迁移删源不留 .migrated + 权限） ----
  {
    const dirA = path.join(home, 'worldA', 'profiles', 'default');
    const dirB = path.join(home, 'worldB', 'profiles', 'default');
    const dirStd = path.join(home, '.dsh', 'profiles', 'default');
    const seenDirs = [];
    const mkIsoCtx = (onLog) => mkCtx({
      logger: { info: onLog },
      jobs: { start() { return 'nj'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() { return 'requested'; }, events: { subscribe() { return () => {}; } } },
      agents: { get() { return undefined; } },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
      sandbox: { confine: async (a) => ({ argv: a }) },
      tools: { register() {} },
      on() { return () => {}; },
    });
    for (const pdir of [dirA, dirB, dirStd]) {
      process.env.DSH_PROFILE_DIR = pdir;
      let logged = '';
      const d0 = mod.default.apply(mkIsoCtx((m) => { if (m.includes('数据目录 ')) logged = m.split('数据目录 ')[1].trim(); }), { sweepSeconds: 600 });
      seenDirs.push(logged);
      d0();
    }
    const uniq = new Set(seenDirs);
    ok('21.4a 同名 profile（不同根目录的 default）隔离到不同数据目录，不串库',
      uniq.size === 3 && seenDirs[2].endsWith(path.join('background-task-coordinator', 'default')),
      seenDirs.map((x) => path.basename(x)).join(' | '));

    // 21.4b 落盘脱敏：objective / delivered message / event 不存明文凭据，而实时 followup 收到原文
    process.env.DSH_PROFILE_DIR = path.join(home, '.dsh', 'profiles', 'redact24');
    const Rr = {};
    const liveRecv = [];
    const ctxR = mkCtx({
      logger: { info: () => {} },
      jobs: { start() { return 'nj-r'; }, get() { return { status: 'running' }; }, readAt() { return { chunks: [] }; }, kill() { return 'requested'; }, events: { subscribe() { return () => {}; } } },
      agents: {
        get(id) {
          return id === 'sess-RED' ? { status: {}, followup(m) { liveRecv.push(m.content?.[0]?.text); }, steer() {}, cancel() {} } : undefined;
        },
      },
      workingDirectory: { ensure: async () => process.cwd() },
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access' }) },
      sandbox: { confine: async (a) => ({ argv: a }) },
      tools: { register(t) { Rr[t.name] = t; } },
      on() { return () => {}; },
    });
    // 预先放一份旧版 tasks.json 与历史遗留的 tasks.json.migrated 验证迁移删源与清理
    const redDir = path.join(home, '.dsh', 'background-task-coordinator', 'redact24');
    fs.mkdirSync(redDir, { recursive: true });
    fs.writeFileSync(path.join(redDir, 'tasks.json.migrated'), '{"stale":true}');
    fs.writeFileSync(path.join(redDir, 'tasks.json'), JSON.stringify({
      tasks: {
        'old-1': {
          id: 'old-1', type: 'job', title: 'legacy',
          objective: 'DEEPSEEK_API_KEY=sk-oldsecret1234567890 echo old',
          status: 'completed', createdAt: 1, updatedAt: 2,
        },
      },
      events: [],
    }));
    const disposeR = mod.default.apply(ctxR, { global: 20, perOwner: 20, timeoutMinutes: 120, sweepSeconds: 600, retentionDays: 30 });
    const dbpR = path.join(redDir, 'tasks.db');
    const { DatabaseSync } = await import('node:sqlite');
    const getR = (sql, ...a) => { const ro = new DatabaseSync(dbpR, { readOnly: true }); const v = ro.prepare(sql).get(...a); ro.close(); return v; };

    const exR = { agent: { id: 'owner-R', session: { id: 'owner-R' } } };
    const rJob = await Rr.task_create.execute({
      type: 'job',
      title: 'deploy',
      objective: 'DEEPSEEK_API_KEY=sk-livekey1234567890abcd curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://alice:mysecret@example.com',
    }, exR);
    const tidJob = rJob.text.match(/taskId=([\w-]+)/)?.[1];
    const rowJob = getR("SELECT objective FROM tasks WHERE id=?", tidJob);

    const rSub = await Rr.task_create.execute({ type: 'subagent', title: 'sub-r', objective: 'run --token ghp_1234567890abcdef1234567890' }, exR);
    const tidSub = rSub.text.match(/taskId=([\w-]+)/)?.[1];
    await Rr.task_register_delegation.execute({ taskId: tidSub, agentId: 'agR', sessionId: 'sess-RED' }, exR);
    const secretMsg = '请用 --api-key sk-msgsecret1234567890 和 Bearer tok_abcdefghijklm1234 测试';
    await Rr.task_append_message.execute({ taskId: tidSub, content: secretMsg }, exR);
    const rowMsg = getR("SELECT content FROM task_messages WHERE task_id=?", tidSub);
    const rowOld = getR("SELECT objective FROM tasks WHERE id='old-1'");

    ok('21.4b SQLite 落盘脱敏（objective / message / 迁移记录），同时实时投递保留原文',
      !rowJob.objective.includes('sk-livekey1234567890abcd')
        && !rowJob.objective.includes('eyJhbGciOiJIUzI1NiJ9')
        && !rowJob.objective.includes('mysecret')
        && rowJob.objective.includes('[REDACTED]')
        && !rowMsg.content.includes('sk-msgsecret1234567890')
        && !rowMsg.content.includes('tok_abcdefghijklm1234')
        && liveRecv[0] === secretMsg
        && rowOld && !rowOld.objective.includes('sk-oldsecret1234567890'),
      `job=${rowJob.objective.slice(0, 60)}`);

    ok('21.4c 旧 tasks.json 迁移后删除源文件，且清理遗留 tasks.json.migrated',
      !fs.existsSync(path.join(redDir, 'tasks.json')) && !fs.existsSync(path.join(redDir, 'tasks.json.migrated')),
      `json=${fs.existsSync(path.join(redDir, 'tasks.json'))} mig=${fs.existsSync(path.join(redDir, 'tasks.json.migrated'))}`);

    if (process.platform !== 'win32') {
      const dirMode = fs.statSync(redDir).mode & 0o777;
      const dbMode = fs.statSync(dbpR).mode & 0o777;
      ok('21.4d POSIX 下台账目录 0700、tasks.db 0600', dirMode === 0o700 && dbMode === 0o600,
        `dir=${dirMode.toString(8)} db=${dbMode.toString(8)}`);
    } else {
      ok('21.4d Windows 跳过 POSIX chmod 检查', true, 'win32');
    }

    disposeR();
  }

  const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore('USERPROFILE', saved.U);
  restore('HOME', saved.H);
  restore('DSH_PROFILE_DIR', saved.P);
  restore('DSH_COORD_LIMITS', saved.L);
  restore('DEEPSEEK_API_KEY', saved.K1);
  restore('GITHUB_TOKEN', saved.K2);
  restore('DB_PASSWORD', saved.K3);
  restore('DSH_INTERNAL_SECRET_TEST', saved.K4);
  restore('SAFE_COORDINATOR_KEEP', saved.K5);
  rm(home);
}

// ---------------------------------------------------------------------------
// 22. 0.2.5 融合：config.profile 仍是第一来源（Gemini 版把它删了，本机必需）
// ---------------------------------------------------------------------------
{
  // 从 index.js 里把 dataDir 抠出来做纯函数测试（不启插件，不受宿主影响）
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const s0 = src.indexOf('function dataDir(configHint) {');
  const s1 = src.indexOf('function dbPath(configHint) {');
  if (s0 < 0 || s1 < 0) throw new Error('dataDir(configHint) 未找到——融合没保住这条');
  const HOME_DATA = path.join(os.homedir(), '.dsh', 'background-task-coordinator');
  const mkDataDir = new Function('path', 'os', 'createHash', 'HOME_DATA',
    src.slice(s0, s1) + '; return dataDir;')(path, os, createHash, HOME_DATA);

  const savedEnv = { D: process.env.DSH_PROFILE_DIR, P: process.env.DSH_PROFILE, H: process.env.DSH_HOME };
  // 模拟「插件进程里读不到环境变量」——这台机器的实测情况
  delete process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_HOME;

  const b = (p) => path.basename(p);

  ok('22.1 config.profile 生效（env 为空时）', b(mkDataDir({ profile: 'desktop' })) === 'desktop', b(mkDataDir({ profile: 'desktop' })));
  ok('22.2 profileName 也认', b(mkDataDir({ profileName: 'mytest' })) === 'mytest');
  ok('22.3 都没有时退回 default（0.2.3 的 bug 现场）', b(mkDataDir({})) === 'default', b(mkDataDir({})));

  // 22.4 Gemini 的路径碰撞检测要保住：不同根目录下的同名 profile 不能共库
  const same1 = mkDataDir({ profile: 'default' });
  ok('22.4 config 给的纯名字不加指纹（向后兼容）', b(same1) === 'default', b(same1));
  // 完整路径形态：非标准根目录 → 带指纹
  const weird = path.join(os.homedir(), 'elsewhere', 'profiles', 'default');
  const weirdDir = mkDataDir({ profile: weird });
  ok('22.5 config 给非标准路径时加指纹（不串库）', b(weirdDir).startsWith('default-'), b(weirdDir));

  // 22.6 config 优先于 env（两个都有时用 config）
  process.env.DSH_PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'fromenv');
  ok('22.6 config 压过 env', b(mkDataDir({ profile: 'fromconfig' })) === 'fromconfig', b(mkDataDir({ profile: 'fromconfig' })));
  // 22.7 没 config 时 env 兜底（Gemini 那边的原始行为）
  ok('22.7 无 config 时 env 兜底', b(mkDataDir({})) === 'fromenv', b(mkDataDir({})));

  if (savedEnv.D !== undefined) process.env.DSH_PROFILE_DIR = savedEnv.D; else delete process.env.DSH_PROFILE_DIR;
  if (savedEnv.P !== undefined) process.env.DSH_PROFILE = savedEnv.P; else delete process.env.DSH_PROFILE;
  if (savedEnv.H !== undefined) process.env.DSH_HOME = savedEnv.H; else delete process.env.DSH_HOME;

  // 22.8 profile 配置里确实写了 profile（运行时那份不是仓库这份，但仓库这份是打包源）
  const yml = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  ok('22.8 cordis.patch.yml 里有 profile', /^\s+profile:\s*\S+/m.test(yml),
    (yml.match(/profile:.*/) ?? ['(无)'])[0].trim());
}

// ---------------------------------------------------------------------------
// 23. 0.2.5：v2 库能迁到 v3，且约束真的生效（Gemini 版没有这条）
// ---------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v025-mig-'));
  const oldDb = path.join(home, 'tasks.db');
  {
    const { DatabaseSync } = await import('node:sqlite');
    const w = new DatabaseSync(oldDb);
    w.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_session_id TEXT NOT NULL,
        type TEXT NOT NULL, native_id TEXT, native_session_id TEXT, title TEXT NOT NULL,
        objective TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT, progress_summary TEXT,
        result_summary TEXT, error_summary TEXT, priority INTEGER NOT NULL DEFAULT 5,
        retry_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER, children TEXT, labels TEXT);
      CREATE TABLE task_messages (
        message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        sender TEXT NOT NULL, content TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL, channel TEXT, reason TEXT,
        created_at INTEGER NOT NULL, delivered_at INTEGER);
      CREATE UNIQUE INDEX uq_messages_task_key ON task_messages(task_id, idempotency_key);
    `);
    w.prepare("INSERT INTO meta VALUES (?,?)").run('schema.task_messages.unique', '2');
    w.prepare("INSERT INTO tasks (id,conversation_id,owner_session_id,type,title,objective,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run('t1', 'c', 's', 'job', 'x', 'echo', 'succeeded', 5, 1, 1);
    w.prepare("INSERT INTO task_messages (message_id,task_id,sender,content,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('m1', 't1', 'user', 'hi', 'k1', 'delivered', 1);
    w.close();
  }

  const { CoordinatorDatabase } = await import(`${ROOT}/lib/storage/database.js`);
  const db = new CoordinatorDatabase(oldDb);
  const msql = db.db.prepare("SELECT sql FROM sqlite_master WHERE name='task_messages'").get().sql;
  const v = db.db.prepare("SELECT value FROM meta WHERE key='schema.task_messages.unique'").get()?.value;
  ok('23.1 v2 → v3 版本推进', Number(v) === 3, `v=${v}`);
  ok('23.2 迁移后补上了外键', /REFERENCES\s+tasks/i.test(msql));
  ok('23.3 迁移后补上了 CHECK', /CHECK\s*\(\s*status/i.test(msql));
  ok('23.4 老数据保留', db.stats().messages === 1 && db.stats().tasks === 1, JSON.stringify(db.stats()));

  let fkBlocked = false;
  try {
    db.db.prepare("INSERT INTO task_messages (message_id,task_id,sender,content,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('orphan', 'nope', 'user', 'x', 'k9', 'pending', 1);
  } catch { fkBlocked = true; }
  let ckBlocked = false;
  try {
    db.db.prepare("INSERT INTO task_messages (message_id,task_id,sender,content,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run('bad', 't1', 'user', 'x', 'k10', 'BOGUS', 1);
  } catch { ckBlocked = true; }
  ok('23.5 孤儿消息插不进去', fkBlocked);
  ok('23.6 非法 status 插不进去', ckBlocked);
  db.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

console.log('=== 0.2.0 专项 ===');
console.log(P.join('\n'));
const pass = P.filter((x) => x.startsWith('✅')).length;
console.log(`\n通过 ${pass}/${P.length}`);
process.exit(P.some((x) => x.startsWith('❌')) ? 1 : 0);
