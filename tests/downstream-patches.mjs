import { mkCtx } from './mockctx.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(),'pt-'));
process.env.USERPROFILE=fakeHome; process.env.HOME=fakeHome;
process.env.DSH_PROFILE_DIR = path.join(fakeHome, '.dsh', 'profiles', 'ptest');
delete process.env.DSH_PROFILE;
process.env.DSH_COORD_LIMITS = JSON.stringify({global:20, perOwner:20, timeoutMinutes:120, sweepSeconds:600});
// 相对导入：仓库 clone 到哪都能跑
const mod = await import(new URL('../index.js', import.meta.url).href);
const R={}, log=[], alive=new Set();
const state={cancelCalled:false};
const ctx = mkCtx({
  logger:{info:m=>log.push(m)},
  jobs:{start(){return 'nj'}, get(){return{status:'running'}}, readAt(){return{chunks:[]}}, kill(){return'requested'}, events:{subscribe(){return()=>{}}}},
  agents:{get(id){return alive.has(id)?{status:{},followup(){},steer(){},cancel(){state.cancelCalled=true;}}:undefined;}},
  systemPrompt:{section:()=>()=>{},getSectionOrder:()=>1600},
  tools:{register(t){R[t.name]=t;}}, on(){return()=>{}},
  // 故意不提供 workingDirectory —— 模拟「取不到会话 cwd」
  sandboxPolicy:{resolve:async()=>({mode:'danger-full-access'})},
  sandbox:{confine:async a=>({argv:a})},
});
mod.default.apply(ctx,{});
const dbp = path.join(fakeHome,'.dsh/background-task-coordinator/ptest/tasks.db');
const { DatabaseSync } = await import('node:sqlite');
const get1=(sql,...a)=>{const ro=new DatabaseSync(dbp,{readOnly:true});const v=ro.prepare(sql).get(...a);ro.close();return v;};
const P=[]; const ok=(n,c,d='')=>P.push(`${c?'✅':'❌'} ${n}${d?`  (${d})`:''}`);

// 补丁2: exec.agent 空 + 无 workingDirectory → 应退回进程目录并打标记，不拒建
const execNoAgent = {};   // exec.agent 为空
let r = await R.task_create.execute({type:'job', title:'t', objective:'echo hi', conversationId:'c1'}, execNoAgent);
const t1 = r.text.match(/taskId=([\w-]+)/)?.[1];
ok('补丁2 exec.agent 空时不拒建', r.ok, r.text.split('\n')[0].slice(0,30));
const lab = t1 ? JSON.parse(get1("SELECT labels FROM tasks WHERE id=?", t1)?.labels || '{}') : {};
ok('补丁2 落 cwdFallback 标记', lab.cwdFallback==='true', JSON.stringify(lab).slice(0,80));
ok('补丁2 记了实际 cwd', typeof lab.cwd==='string' && lab.cwd.length>0, lab.cwd);

// 补丁1: 默认限额 5/4
//   这里原来查源码字面量 `'global: 5, perOwner: 4'` —— 0.2.1 把那套合并进 LIMITS_READ、
//   拆成多行了，字面量断言立刻误报。改成**行为断言**：不设任何环境变量、
//   不传 config 起一个实例，验限额与 deadline 用的就是 5/4/120。
{
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(),'dflt-'));
  const saved = { U: process.env.USERPROFILE, H: process.env.HOME, P: process.env.DSH_PROFILE_DIR, L: process.env.DSH_COORD_LIMITS };
  process.env.USERPROFILE = home2; process.env.HOME = home2;
  process.env.DSH_PROFILE_DIR = path.join(home2, '.dsh', 'profiles', 'dflt');
  delete process.env.DSH_COORD_LIMITS;
  const mod2 = await import(new URL('../index.js', import.meta.url).href + '?dflt=1');
  const R3 = {};
  const ctx3 = mkCtx({
    logger:{info:()=>{}},
    jobs:{start(){return 'nj'},get(){return{status:'running'}},readAt(){return{chunks:[]}},kill(){},events:{subscribe(){return()=>{}}}},
    agents:{get(){return undefined}},
    workingDirectory:{ensure:async()=>process.cwd()},
    sandboxPolicy:{resolve:async()=>({mode:'danger-full-access'})},
    sandbox:{confine:async a=>({argv:a})},
    tools:{register(t){R3[t.name]=t}}, on(){return()=>{}},
  });
  mod2.default.apply(ctx3, {});   // 不传 config
  const ex = { agent:{ id:'s-dflt', session:{ id:'s-dflt' } } };
  const rr = await R3.task_create.execute({type:'job', title:'d', objective:'echo hi'}, ex);
  const tid3 = rr.text.match(/taskId=([\w-]+)/)?.[1];
  const dbp3 = path.join(home2,'.dsh','background-task-coordinator','dflt','tasks.db');
  const { DatabaseSync: DS3 } = await import('node:sqlite');
  const ro3 = new DS3(dbp3, { readOnly: true });
  const lab3 = JSON.parse(ro3.prepare("SELECT labels FROM tasks WHERE id=?").get(tid3)?.labels ?? '{}');
  ro3.close();
  ok('补丁1 默认限额 5/4 且 deadline=120', lab3.deadlineMinutes === '120', JSON.stringify(lab3).slice(0,60));
  // 同一会话连建 5 个：第 5 个应被 perOwner=4 挡住（4 比 global=5 先撞上，顺序是对的）
  for (let i=0;i<3;i++) await R3.task_create.execute({type:'job', title:`d${i}`, objective:'echo hi'}, ex);
  const r5 = await R3.task_create.execute({type:'job', title:'d4', objective:'echo hi'}, ex);
  ok('补丁1 同会话第 5 个撞 perOwner=4', !r5.ok && r5.text.includes('/4'), r5.text.slice(0,40));
  if (saved.U !== undefined) process.env.USERPROFILE = saved.U;
  if (saved.H !== undefined) process.env.HOME = saved.H;
  if (saved.P !== undefined) process.env.DSH_PROFILE_DIR = saved.P;
  if (saved.L !== undefined) process.env.DSH_COORD_LIMITS = saved.L;
  try { fs.rmSync(home2,{recursive:true,force:true,maxRetries:3}); } catch {}
}

// 补丁3: sandbox 服务不可用 vs 真拒绝 要分开
//   这里 sandboxPolicy 有、confine 有 → 正常。构造一个「服务不存在」的场景：
const ctx2 = mkCtx({ logger:{info:()=>{}}, jobs:{start(){return 'x'},get(){},readAt(){},kill(){},events:{subscribe(){return()=>{}}}},
  agents:{get(){}}, systemPrompt:{section:()=>()=>{}}, tools:{register(t){R2[t.name]=t;}}, on(){return()=>{}},
  workingDirectory:{ensure:async()=>process.cwd()} /* 无 sandboxPolicy */ });
const R2={};
mod.default.apply(ctx2,{});
r = await R2.task_create.execute({type:'job', title:'t2', objective:'echo hi'}, {agent:{id:'s',session:{id:'s'}}});
ok('补丁3 服务不存在时不误称「沙箱拒绝」', !r.ok && r.text.includes('服务不可用') && !r.text.includes('不允许自由 shell'), r.text.slice(0,60));

// 补丁4: nativeSessionId 为 null 时 cancel 不探活、不误杀
r = await R.task_create.execute({type:'subagent', title:'sub-null', objective:'x'}, {agent:{id:'sess-X',session:{id:'sess-X'}}});
const t4 = r.text.match(/taskId=([\w-]+)/)?.[1];
await R.task_register_delegation.execute({taskId:t4, agentId:'ag-null'}, {agent:{id:'sess-X',session:{id:'sess-X'}}});
// 确保 nativeSessionId 是 null（没 subagents 服务，反查必败）
const row4 = get1("SELECT native_session_id,status FROM tasks WHERE id=?", t4);
ok('准备：nativeSessionId 确为 null', row4.native_session_id===null, JSON.stringify(row4));
r = await R.task_cancel.execute({taskId:t4, reason:'x'}, {agent:{id:'sess-X',session:{id:'sess-X'}}});
ok('补丁4 无真 id 时不误判已回收', !r.text.includes('原生 agent 已不在'), r.text.slice(0,70));
const after = get1("SELECT status FROM tasks WHERE id=?", t4);
ok('补丁4 落 cancel_requested 而非 cancelled', after.status==='cancel_requested', after.status);

console.log('=== 下游四处补丁验证 ===');
console.log(P.join('\n'));
console.log(`\n通过 ${P.filter(x=>x.startsWith('✅')).length}/${P.length}`);
try{fs.rmSync(fakeHome,{recursive:true,force:true,maxRetries:3})}catch{}
process.exit(P.some(x=>x.startsWith('❌'))?1:0);
