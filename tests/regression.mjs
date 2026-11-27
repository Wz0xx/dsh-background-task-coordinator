import { mkCtx } from './mockctx.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(),'reg-'));
process.env.USERPROFILE = fakeHome; process.env.HOME = fakeHome;
process.env.DSH_COORD_LIMITS = JSON.stringify({global:20, perOwner:20, timeoutMinutes:120, sweepSeconds:600});
const mod = await import('file:///C:/Users/stop/.dsh/worlds/default/room/background-task-coordinator/index.js');

const R = {}, log = [], alive = new Set(), confined = [], listeners = {};
const state = { kill: null, cancelCalled: false };
const ctx = mkCtx({
  logger:{info:m=>log.push(m)},
  jobs:{
    start(spec){ const h = spec.run({append(){}, updateProgress(){}}); state.handle = h; return 'nj-1'; },
    get(){ return {status:'running'} }, readAt(){ return {chunks:[{text:'out'}]} },
    kill(id,caller,reason){ state.kill = {id,caller,reason}; return 'requested'; },
    events:{ subscribe(){ return ()=>{} } },
  },
  agents:{ get(id){ return alive.has(id) ? {status:{}, followup(){}, steer(){}, cancel(){state.cancelCalled=true;}} : undefined; } },
  workingDirectory:{ ensure: async ()=> process.cwd() },
  sandboxPolicy:{ resolve: async ()=>({mode:'workspace-write'}) },
  sandbox:{ confine: async (argv)=>{ confined.push([...argv]); return {argv:['echo','CONFINED']}; } },
  tools:{ register(t){ R[t.name]=t; } },
  on(ev, fn){ listeners[ev]=fn; return ()=>{}; },
});
mod.default.apply(ctx, {});
const execA = { agent:{ id:'sess-A', session:{ id:'sess-A' } } };
const execB = { agent:{ id:'sess-B', session:{ id:'sess-B' } } };
const P=[]; const ok=(n,c,d='')=>P.push(`${c?'✅':'❌'} ${n}${d?`  (${d})`:''}`);
const dbp = path.join(fakeHome,'.dsh/background-task-coordinator/tasks.db');
const { DatabaseSync } = await import('node:sqlite');
const set = (sql, ...args) => { const w = new DatabaseSync(dbp); w.prepare(sql).run(...args); w.close(); };
const get1 = (sql, ...args) => { const ro = new DatabaseSync(dbp,{readOnly:true}); const v = ro.prepare(sql).get(...args); ro.close(); return v; };

// A 建 job（走 ctx.get 取 workingDirectory）
let r = await R.task_create.execute({type:'job', title:'build', objective:'echo hi'}, execA);
const t1 = r.text.match(/taskId=([\w-]+)/)?.[1];
ok('A1 建 job 成功', r.ok && r.text.includes('状态=running'), r.text.split('\n')[0].slice(0,30));
ok('A2 confine 真的被调用', confined.length>0, `${confined.length} 次`);

// B describe
r = await R.task_describe.execute({taskId:t1}, execA);
ok('B describe 有事件与发起行', r.text.includes('最近事件') && r.text.includes('发起：'));

// C 幂等
await R.task_append_message.execute({taskId:t1, content:'x', idempotencyKey:'K'}, execA);
r = await R.task_append_message.execute({taskId:t1, content:'x', idempotencyKey:'K'}, execA);
ok('C 幂等键命中', r.text.includes('幂等命中'));

// D 越权
r = await R.task_describe.execute({taskId:t1}, execB);
ok('D1 越权 describe 被拒', !r.ok && r.text.includes('任务不存在'));
r = await R.task_cancel.execute({taskId:t1}, execB);
ok('D2 越权 cancel 被拒', !r.ok && r.text.includes('任务不存在'));
ok('D3 kill 没被冒充 owner', !state.kill || state.kill.caller==='sess-A', JSON.stringify(state.kill));

// E 自己取消
r = await R.task_cancel.execute({taskId:t1, reason:'mine'}, execA);
ok('E 自己取消成功', r.ok);

// F subagent：登记 → 结算（succeeded）
r = await R.task_create.execute({type:'subagent', title:'sub', objective:'x'}, execA);
const t2 = r.text.match(/taskId=([\w-]+)/)?.[1];
await R.task_register_delegation.execute({taskId:t2, agentId:'ag2'}, execA);
alive.add('sess-2');
set("UPDATE tasks SET native_session_id='sess-2' WHERE id=?", t2);
listeners['subagent/end']({ id:'sess-2', stopReason:'completed' });
ok('F1 subagent 正常结束落 succeeded', get1("SELECT status FROM tasks WHERE id=?", t2).status==='succeeded');

// G stopReason 非白名单 → failed（不再误判成功）
r = await R.task_create.execute({type:'subagent', title:'sub2', objective:'x'}, execA);
const t3 = r.text.match(/taskId=([\w-]+)/)?.[1];
await R.task_register_delegation.execute({taskId:t3, agentId:'ag3'}, execA);
alive.add('sess-3');
set("UPDATE tasks SET native_session_id='sess-3' WHERE id=?", t3);
listeners['subagent/end']({ id:'sess-3', stopReason:'max_turns' });
const g = get1("SELECT status,error_summary FROM tasks WHERE id=?", t3);
ok('G max_turns 落 failed（不再误判成功）', g.status==='failed', `${g.status} / ${g.error_summary}`);

// H subagent cancel 真调 ag.cancel
r = await R.task_create.execute({type:'subagent', title:'sub3', objective:'x'}, execA);
const t4 = r.text.match(/taskId=([\w-]+)/)?.[1];
await R.task_register_delegation.execute({taskId:t4, agentId:'ag4'}, execA);
alive.add('sess-4');
set("UPDATE tasks SET native_session_id='sess-4' WHERE id=?", t4);
await R.task_cancel.execute({taskId:t4, reason:'stop'}, execA);
ok('H subagent 取消真调 ag.cancel', state.cancelCalled===true);

// I 长 objective 不阻断 context
r = await R.task_create.execute({type:'subagent', title:'long', objective:'x'.repeat(9000)}, execA);
const t5 = r.text.match(/taskId=([\w-]+)/)?.[1];
r = await R.task_context.execute({taskId:t5, stage:'init'}, execA);
ok('I 长 objective 仍可写 context', r.ok, r.text.slice(0,40));

// J 自检：三项走 ctx.get 后应为 supported
const cl = log.find(l=>l.includes('compat: '));
const cap = cl ? JSON.parse(cl.slice(cl.indexOf('compat: ')+8)) : null;
ok('J1 working_directory=supported', cap?.caps['working_directory']==='supported', cap?.caps['working_directory']);
ok('J2 sandbox.confine=supported', cap?.caps['sandbox.confine']==='supported');
ok('J3 sandbox.policy=supported', cap?.caps['sandbox.policy']==='supported');

// K 通知措辞不再撒谎
const evs = get1("SELECT COUNT(*) AS n FROM task_events WHERE event_type='task.notified'").n;
ok('K task.notified 事件存在', evs>0, `${evs} 条`);

console.log('=== 统一回归 ===');
console.log(P.join('\n'));
console.log(`\n通过 ${P.filter(x=>x.startsWith('✅')).length}/${P.length}`);
try{fs.rmSync(fakeHome,{recursive:true,force:true,maxRetries:3})}catch{}
process.exit(P.some(x=>x.startsWith('❌'))?1:0);
