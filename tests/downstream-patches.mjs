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

// 补丁1: 默认限额 5/4（本测用环境变量覆盖成 20，验的是代码里默认字面量已改）
const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
ok('补丁1 默认 global:5 perOwner:4', src.includes('global: 5, perOwner: 4'));

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
