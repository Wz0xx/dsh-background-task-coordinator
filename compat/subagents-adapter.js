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

  // 调用方明确给了、且明显不是名字本身 → 直接信它
  const g = String(given ?? '').trim();
  if (g && g !== name) return g;

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
  const parentSid = caller?.session?.id ?? caller?.sessionId ?? null;
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
export function getAgentHandle(ctx, task) {
  const sid = task?.nativeSessionId || task?.nativeId;
  if (!sid) return undefined;
  try {
    return ctx?.agents?.get?.(sid);
  } catch {
    return undefined;
  }
}
