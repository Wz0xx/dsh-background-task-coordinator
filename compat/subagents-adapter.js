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
  //
  // 0.2.6：必须传 strict=false。
  // 宿主 Context.get(name, strict = true) 在 strict 时只返回 fiber 已 ACTIVE(2) 的服务；
  // subagents 的服务 fiber 未必在插件加载时就 ACTIVE，strict 查询会返回 undefined，
  // 于是所有「按名字反查会话 id」的路径全被判成「宿主不支持」。
  // 实测症状：compat 里 subagent.resolve_name / list_children 同时报 unsupported。
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('subagents', false) ?? ctx.get('subagents');
      if (viaGet) return viaGet;
    }
  } catch { /* 服务不存在或宿主不认这个键 */ }
  return null;
}

/**
 * 名字 → 会话 id（带父子归属校验，0.2.4）。
 *
 * 返回结构 `{ sid, rejected, verified, reason }`：
 *   - `rejected: true` 表示目标会话被判定不属于当前父会话（或无法通过可用 subagents 服务核验），
 *     调用方必须拒绝首次绑定，防止共享 profile 下借别人的子代理 sessionId 跨会话发指令或取消；
 *   - `sid` 为已校验/解析出的子代理会话 id，解析不到为 null。
 *
 * 降级边界（明确约定，避免在精简/旧版宿主上误伤正常绑定）：
 *   1. 若 `agents.get(sid)` 或 `sessions.get(sid)` 暴露了父会话字段且与当前父会话不一致 → 一律拒绝；
 *   2. 若宿主**完全不提供** `subagents` 的 `listDescendants` / `listChildren` / `resolveName`
 *      （`!canList && !canResolve`）→ **不误拒**，放行并交由元数据父会话核验 + SQLite 跨会话唯一校验兜底；
 *   3. 若宿主提供了 `subagents` 枚举/解析服务，则要求目标在子树或 `resolveName` 中命中，
 *      或已由 `agents`/`sessions` 元数据正向确权（`metadataConfirmed === true`，兼容已结束子代理被移出 listChildren 的早到竞态），
 *      否则 fail-closed 拒绝。
 *
 * @param {object} ctx              Cordis 上下文
 * @param {string} agentName        原生 subagent 工具给的 agent 名
 * @param {object|undefined} caller 发起方 agent（需要 .session.id 作父会话）
 * @param {string} given            调用方自己填的 sessionId（可能是名字，也可能真的是 id）
 * @returns {Promise<{sid: string|null, rejected: boolean, verified: boolean, reason?: string}>}
 */
export async function resolveSubagentBinding(ctx, agentName, caller, given) {
  const name = String(agentName ?? '').trim();
  if (!name) return { sid: null, rejected: false, verified: false };

  // 父会话 id 一次算好，全链路共用：三个字段形状都认 —— caller.session.id / caller.sessionId / caller.id。
  const parentSid = caller?.session?.id ?? caller?.sessionId ?? caller?.id ?? null;
  const parentStr = parentSid ? String(parentSid) : null;
  const hasRealParent = !!parentStr && !/^(current|null|undefined|none|unknown)$/i.test(parentStr);

  const sub = getSubagentsService(ctx);
  const getSvc = (k) => {
    // 0.2.6：strict=false。宿主 ctx.get(name, strict=true) 只返回 fiber 已 ACTIVE 的服务，
    // agents / sessions 未必在插件加载时就 ACTIVE —— strict 查询会误报「没有这个服务」，
    // 于是下面的父会话核验整段被跳过，降级成「零校验」。
    try {
      if (typeof ctx?.get !== 'function') return undefined;
      return ctx.get(k, false) ?? ctx.get(k);
    } catch { return undefined; }
  };

  // 辅助核验 1：检查 agents 句柄与 sessions 元数据中声明的父会话字段。
  // 只要明确带了父会话字段且与当前父会话不相等，直接判越权拒绝。
  const checkMetadataParent = (candidateSid) => {
    let confirmed = false;
    const agents = getSvc('agents');
    if (agents && typeof agents.get === 'function') {
      try {
        const ag = agents.get(candidateSid);
        if (ag && typeof ag === 'object') {
          const agParent = ag.parentSessionId ?? ag.parentId
            ?? ag.session?.parentSessionId ?? ag.session?.parentId
            ?? ag.ownerSessionId ?? null;
          if (agParent) {
            if (!hasRealParent || String(agParent) !== parentStr) {
              return { ok: false, confirmed: false, reason: `子代理会话 ${candidateSid} 的父会话与当前调用者不一致` };
            }
            confirmed = true;
          }
        }
      } catch { /* 查询抛错不作为通过依据，交给后续 subagents 核验 */ }
    }
    const sessions = getSvc('sessions');
    if (sessions && typeof sessions.get === 'function') {
      try {
        const sess = sessions.get(candidateSid);
        const hdr = sess?.header ?? sess;
        const sessParent = hdr?.parentSessionId ?? hdr?.parentId ?? hdr?.ownerSessionId ?? null;
        if (sessParent) {
          if (!hasRealParent || String(sessParent) !== parentStr) {
            return { ok: false, confirmed: false, reason: `会话 ${candidateSid} 的父会话元数据与当前调用者不一致` };
          }
          confirmed = true;
        }
      } catch { /* 同上 */ }
    }
    return { ok: true, confirmed };
  };

  // 辅助核验 2：利用宿主原生 subagents 服务（listDescendants / listChildren / resolveName）
  // 权威验证调用方传入的 candidateSid 是否确实属于当前父会话的子树。
  const verifyViaSubagents = async (candidateSid, metadataConfirmed) => {
    const canList = typeof sub?.listDescendants === 'function' || typeof sub?.listChildren === 'function';
    const canResolve = typeof sub?.resolveName === 'function';
    if (!canList && !canResolve) {
      // 宿主未提供任何 subagents 归属枚举/解析能力：只能依赖 metadata 与台账跨会话唯一性。
      //
      // 这一层**不做强判断**，只拦一种明确的坏情况：
      //   candidateSid 与 agentName 都给了，但 agents 服务明确知道有这个 sid、
      //   而它跟传进来的名字对不上 —— 那是把别的 agent 的 id 按到自己名下。
      // 其余（查不到、服务不可用、注册表还没登记）一律放行：
      //   原生工具刚返回 sessionId 时 agents 往往还没登记，硬拒会打断正常流程。
      const agents = getSvc('agents');
      if (agents && typeof agents.get === 'function') {
        try {
          const ag = agents.get(candidateSid);
          if (ag && typeof ag === 'object') {
            const agName = ag.name ?? ag.agentName ?? ag.label ?? null;
            // 明确有名字且和传进来的 agent 名不一致 → 拒绝（把别人的 id 按到自己名下）
            if (agName && name && String(agName) !== name) {
              return { ok: false, verified: false, reason: `会话 ${candidateSid} 属于 agent "${agName}"，与传入的 "${name}" 不符` };
            }
          }
        } catch { /* 查询失败按放行处理，交给台账唯一性兜底 */ }
      }
      return { ok: true, verified: metadataConfirmed };
    }
    if (canList) {
      if (!hasRealParent) {
        return { ok: false, verified: false, reason: '缺少有效的当前父会话 id，无法核验子代理归属' };
      }
      try {
        const rawList = typeof sub.listDescendants === 'function'
          ? await sub.listDescendants(parentStr)
          : await sub.listChildren(parentStr);
        const list = Array.isArray(rawList) ? rawList : [];
        if (list.some((k) => k && String(k.id) === String(candidateSid))) {
          return { ok: true, verified: true };
        }
      } catch {
        // list 查询失败时：若 resolveName 或已正向确权的父会话元数据可证实归属则放行，否则 fail-closed
        if (canResolve && caller) {
          try {
            const r = await sub.resolveName(caller, name);
            if (r && String(r) !== name && String(r) === String(candidateSid)) {
              return { ok: true, verified: true };
            }
          } catch { /* 落到下一步 */ }
        }
        if (metadataConfirmed) return { ok: true, verified: true };
        return { ok: false, verified: false, reason: '核验子代理归属失败（subagents 服务异常），拒绝盲绑' };
      }
      // 不在子列表中：再给 resolveName 一次机会（兼容 listChildren 只列直接子级或已裁剪结束项）
      if (canResolve && caller) {
        try {
          const r = await sub.resolveName(caller, name);
          if (r && String(r) !== name && String(r) === String(candidateSid)) {
            return { ok: true, verified: true };
          }
        } catch { /* 落到下一步 */ }
      }
      // 若 agents/sessions 元数据已正向证明 parentSessionId === 当前父会话（如早到结束的子代理已从 listChildren 移出），允许绑定
      if (metadataConfirmed) return { ok: true, verified: true };
      return { ok: false, verified: false, reason: `子代理会话 ${candidateSid} 不属于当前父会话的子代理列表` };
    }
    // 只有 resolveName（无 listChildren/listDescendants）
    if (!caller) {
      return { ok: false, verified: false, reason: '缺少调用者身份，无法通过 resolveName 核验子代理归属' };
    }
    try {
      const r = await sub.resolveName(caller, name);
      if (r && String(r) !== name) {
        if (String(r) === String(candidateSid)) return { ok: true, verified: true };
        return { ok: false, verified: false, reason: `给定会话 ${candidateSid} 与当前会话解析出的 ${name}（${r}）不一致` };
      }
    } catch { /* 落到下面 */ }
    if (metadataConfirmed) return { ok: true, verified: true };
    return { ok: false, verified: false, reason: `无法证明会话 ${candidateSid} 属于当前会话（resolveName 未命中）` };
  };

  // 调用方明确给了 sessionId 且不等于 agent 名：先过格式/占位词/自指过滤，再强制做归属核验（0.2.4）。
  const g = String(given ?? '').trim();
  if (g && g !== name) {
    const isPlaceholder = /^(current|null|undefined|none|unknown)$/i.test(g);
    const isParentItself = !!parentStr && g === parentStr;
    const looksLikeId = g.length >= 4 && !/\s/.test(g) && !/^[\u4e00-\u9fa5]+$/.test(g);
    if (!isPlaceholder && !isParentItself && looksLikeId) {
      const meta = checkMetadataParent(g);
      if (!meta.ok) return { sid: null, rejected: true, verified: false, reason: meta.reason };
      const tree = await verifyViaSubagents(g, meta.confirmed);
      if (!tree.ok) return { sid: null, rejected: true, verified: false, reason: tree.reason };
      return { sid: g, rejected: false, verified: tree.verified };
    }
    // 不像 id / 是占位词 / 是父会话自己：进反查，别把它当 id 落库。
  }

  if (!sub) return { sid: null, rejected: false, verified: false };

  // ---- 路径一：0.2.2+ 的 resolveName（按调用者作用域解析名字） ----
  if (typeof sub.resolveName === 'function' && caller) {
    try {
      const sid = await sub.resolveName(caller, name);
      // resolveName 对「不是名字的单个 token」会原样返回该 token，相等等于没解析出来；同时防自指。
      if (sid && String(sid) !== name && (!parentStr || String(sid) !== parentStr)) {
        const resolved = String(sid);
        const meta = checkMetadataParent(resolved);
        if (!meta.ok) return { sid: null, rejected: true, verified: false, reason: meta.reason };
        return { sid: resolved, rejected: false, verified: true };
      }
    } catch { /* 落到路径二 */ }
  }

  // ---- 路径二：0.2.1 的 listChildren（只扫当前父会话的子级目录，按 label 匹配） ----
  if (typeof sub.listChildren === 'function' && hasRealParent) {
    try {
      const kids = await sub.listChildren(parentStr);
      const hits = (Array.isArray(kids) ? kids : []).filter((k) => k && String(k.label ?? '') === name);
      if (hits.length > 0) {
        if (hits.length > 1) {
          hits.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
        }
        const resolved = String(hits[0].id);
        if (resolved !== parentStr) {
          const meta = checkMetadataParent(resolved);
          if (!meta.ok) return { sid: null, rejected: true, verified: false, reason: meta.reason };
          return { sid: resolved, rejected: false, verified: true };
        }
      }
    } catch { /* 拿不到就 null */ }
  }

  return { sid: null, rejected: false, verified: false };
}

/**
 * 名字 → 会话 id（兼容旧签名的便捷包装）。取不到或归属校验拒绝一律返回 null。
 *
 * @param {object} ctx              Cordis 上下文
 * @param {string} agentName        原生 subagent 工具给的 agent 名
 * @param {object|undefined} caller 发起方 agent（需要 .session.id 作父会话）
 * @param {string} given            调用方自己填的 sessionId（可能是名字，也可能真的是 id）
 * @returns {Promise<string|null>}
 */
export async function resolveSubagentSessionId(ctx, agentName, caller, given) {
  const res = await resolveSubagentBinding(ctx, agentName, caller, given);
  return res.rejected ? null : res.sid;
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
    try {
      // 0.2.7：必须 strict=false。默认 strict 只返回 fiber 已 ACTIVE 的服务，
      // agents 未必在插件加载时 ACTIVE → 返回 undefined → **所有探活都判「查不到」**，
      // 活任务被当成已死。这条比自检误报严重：它直接决定任务状态。
      if (typeof ctx?.get !== 'function') return ctx?.agents;
      return ctx.get('agents', false) ?? ctx.get('agents');
    }
    catch { return undefined; }
  })();
  if (!agents || typeof agents.get !== 'function') return undefined;
  return agents.get(sid);
}
