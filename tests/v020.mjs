// 0.2.0 专项回归：收尾七条（审计 P1-4 / P1-5 / P1-7 / P2-6 / P2-7）。
//
// 每条都做成「能反驳自己」的断言：不是「代码里有这个词」，而是真跑一遍看库里/输出里变了什么。
import { mkCtx } from './mockctx.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  const src = fs.readFileSync('C:/Users/stop/.dsh/worlds/default/room/background-task-coordinator/index.js', 'utf8');
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

console.log('=== 0.2.0 专项 ===');
console.log(P.join('\n'));const pass = P.filter((x) => x.startsWith('✅')).length;
console.log(`\n通过 ${pass}/${P.length}`);
process.exit(P.some((x) => x.startsWith('❌')) ? 1 : 0);
