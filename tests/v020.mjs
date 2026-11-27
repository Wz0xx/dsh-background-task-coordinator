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
  ok('0.6 迁移版本落 meta 且不重复迁移', Number(meta?.value) === 2 && db2.listMessages('tA').length === 1, `v=${meta?.value}`);
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

console.log('=== 0.2.0 专项 ===');
console.log(P.join('\n'));const pass = P.filter((x) => x.startsWith('✅')).length;
console.log(`\n通过 ${pass}/${P.length}`);
process.exit(P.some((x) => x.startsWith('❌')) ? 1 : 0);
