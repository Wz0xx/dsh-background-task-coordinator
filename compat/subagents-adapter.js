// compat/subagents-adapter.js —— subagent 名字 → 会话 id 的双路反查。
//
// 背景（2026-11-27 实测反馈 + 本机 asar 核对）：
//   - subagent/end 事件的载荷只有 { runId, provider, id: SessionId, local, stopReason }
//     （@deepseek-ai/dsh-subagent/types 的 SubagentRunEndInfo 原文），没有 sessionId/agentId/childId。
//   - 原生 subagent 工具只返回 "started subagent <name>"，调用方拿不到会话 id。
//   - 所以「按名字找会话」必须由插件自己做，且两个版本的路径不同：
//       0.2.2+  ctx.subagents.resolveName(callerAgent, name) → SessionId
//       0.2.1   ctx.subagents.listChildren(parentSessionId) → [{ id, createdAt, mode, label? }]，按 label 匹配
//   - 本机 0.2.1-rc.4 的 asar 里没有 resolveName（5 处命中全是 fast-xml-parser 的私有方法），
//     只有 listChildren(parentSessionId, signal?) 与 listDescendants(rootSessionId)。
//
// 这条降级链必须两头都能跑：有 resolveName 用它，没有就扫 listChildren。

/**
 * 取 subagents 服务（Cordis 服务键已在 0.2.1 注册：TeamService.inject 里就有 'subagents'）。
 * @param {object} ctx Cordis 上下文
 * @returns {object|null}
 */
export function getSubagentsService(ctx) {
  // 只走 ctx.get()：cordis 4.x 里直取未 inject 的属性会抛
  // `cannot get property "subagents" without inject`，而 subagents 不在本插件的
  // inject 列表里（也不能加 —— 加了整个插件不启动，见 cwd 缺陷报告 §3.4）。
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get('subagents');
      if (viaGet) return viaGet;
    }
  } catch { /* 服务不存在或宿主不认这个键 */ }
  return null;
}

/**
 * 名字 → 会话 id。取不到一律返回 null，绝不把名字当 id 落库。
 *
 * @param {object} ctx              Cordis 上下文
 * @param {string} agentName        原生 subagent 工具给的 agent 名
 * @param {object|undefined} caller 发起方 agent（需要 .session.id 作父会话）
 * @param {string} given            调用方自己填的 sessionId（可能是名字，也可能真的是 id）
 * @returns {Promise<string|null>}
 */
export async function resolveSubagentSessionId(ctx, agentName, caller, given) {
  const name = String(agentName ?? '').trim();
  if (!name) return null;

  // 调用方明确给了、且不等于 agent 名 → 要用，但**先核实它真的是一个会话 id**
  // （0.2.1 修，审计 P1-6）。
  //
  // 0.2.0 是「给了就信」：`if (g && g !== name) return g;` 直接原样落库。
  // 问题是这个字段由模型填，什么都能塞进去 —— 一个随手写的「随便」「abc」会被当成
  // 会话 id 存进 native_session_id，之后所有按 id 的探活、结算匹配、取消全部落空。
  //
  // 0.2.1 的判据要**松到不打断正常时序**（原生工具刚返回 sessionId 时，
  // agents 注册表往往还没登记；测试/其它宿主也可能用 `sess-xxx` 这种短 id）：
  //   ① 排除明显不是 id 的（空串、纯中文、带空格、超短）；
  //   ② 注册表能查到 → 确认；查不到 → 接受但算「未核实」，不当成已确认。
  // 只有真正不像 id 的才丢掉、进反查。这一条是被测试逼出来的：一开始写成
  // 「必须是 UUID」，结果 `sess-F1` 这种合法短 id 被打断，补投直接失效。
  const g = String(given ?? '').trim();
  if (g && g !== name) {
    // 「像 id」= 无空白、非全中文、长度 >= 4。
    // 会话 id 的真实形态在这些宿主里并不统一（UUID、session-xxx、sess-F1 都见过），
    // 所以不能按某一种格式硬卡，只能排除明显是话而不是 id 的。
    const looksLikeId = g.length >= 4 && !/\s/.test(g) && !/^[\u4e00-\u9fa5]+$/.test(g);
    if (looksLikeId) {
      const agents = (() => {
        try { return typeof ctx?.get === 'function' ? ctx.get('agents') : undefined; } catch { return undefined; }
      })();
      if (agents && typeof agents.get === 'function') {
        try {
          if (agents.get(g)) return g;   // 注册表里有 → 确认是活会话 id
        } catch { /* 查询抛错 → 下面按未核实处理 */ }
      }
      // 格式过得去、注册表暂时查不到（或没有 agents 服务）：接受，但未核实。
      return g;
    }
    // 不像 id：进反查，别把它当 id 落库。
  }

  const sub = getSubagentsService(ctx);
  if (!sub) return null;

  // ---- 路径一：0.2.2+ 的 resolveName（按名字解析） ----
  if (typeof sub.resolveName === 'function' && caller) {
    try {
      const sid = await sub.resolveName(caller, name);
      // resolveName 对「不是名字的单个 token」会原样返回该 token（当 session id 用），
      // 所以相等就等于没解析出来 —— 这行不能省。
      if (sid && String(sid) !== name) return String(sid);
    } catch { /* 落到路径二 */ }
  }

  // ---- 路径二：0.2.1 的 listChildren（扫父会话的子级目录，按 label 匹配） ----
  //
  // 父会话 id 的取法要全（0.2.1 修，审计 P1-6）：0.2.0 只认 `caller.session.id`
  // 和 `caller.sessionId`，漏了 `caller.id` —— 而空态兜底造出来的 caller 恰恰是
  // `{ session: {...}, id }` 形态，别的宿主也可能只给 .id。
  // 结果：`{ id: 'parent-only-id' }` 这种 caller 会让这条路径整个跳过、直接返回 null。
  const parentSid = caller?.session?.id ?? caller?.sessionId ?? caller?.id ?? null;
  if (typeof sub.listChildren === 'function' && parentSid) {
    try {
      const kids = await sub.listChildren(parentSid);
      const hits = (Array.isArray(kids) ? kids : []).filter((k) => k && String(k.label ?? '') === name);
      if (hits.length === 1) return String(hits[0].id);
      if (hits.length > 1) {
        // 同名多个：取最新创建的那个。这是 best-effort，调用方应知道存在歧义。
        hits.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
        return String(hits[0].id);
      }
    } catch { /* 拿不到就 null */ }
  }

  return null;
}

/**
 * 探测本机是否支持各条反查路径（启动自检用）。
 * @returns {{resolveName: 'supported'|'unsupported', listChildren: 'supported'|'unsupported'}}
 */
export function probeSubagentCapabilities(ctx) {
  const sub = getSubagentsService(ctx);
  return {
    resolveName: typeof sub?.resolveName === 'function' ? 'supported' : 'unsupported',
    listChildren: typeof sub?.listChildren === 'function' ? 'supported' : 'unsupported',
  };
}

/**
 * 取 agent handle：ctx.agents 只按 session id 索引，不能喂 agent 名字。
 * @param {object} ctx
 * @param {{nativeSessionId?: string|null, nativeId?: string|null}} task
 */
/**
 * 取 agent handle。
 *
 * 返回三态（2026-11-27 下游补丁反馈「顺带 1」）：
 *   - agent 对象：查到了
 *   - undefined：确实查不到（agent 已回收）—— 这是**结论**
 *   - 抛错不再吞：调用方要能区分「查不到」和「查询本身失败」
 *
 * 早期把异常吞成 undefined，导致 index.js 里「探不动就别下结论」那层 try/catch
 * 成了死代码 —— 查出错和查不到被混成同一件事，会误判死活。
 */
export function getAgentHandle(ctx, task) {
  const sid = task?.nativeSessionId || task?.nativeId;
  if (!sid) return undefined;
  // 只让「服务取不到」退化为 undefined；get 本身抛错就让它冒出去，
  // 调用方据此判断「这次探活没做成」（而不是「agent 没了」）。
  const agents = (() => {
    try { return typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents; }
    catch { return undefined; }
  })();
  if (!agents || typeof agents.get !== 'function') return undefined;
  return agents.get(sid);
}
