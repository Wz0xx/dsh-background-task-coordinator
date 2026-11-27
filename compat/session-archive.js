// compat/session-archive.js —— subagent 子会话的自动归档。
//
// 背景：面板上的「子智能体」列表是父会话日志里 subagent/catalog 事件的投影，
// 面板本身没有删除入口。真正能把它从列表里拿走的是 DSH 自己的
// workspaceController.archiveSession —— 契约（cordis inspect 实测）：
//
//   ctx.get("workspaceController")            // 可选依赖，要判 undefined
//   ctx.workspaceController.archiveSession({
//     sessionId: SessionId,
//     stopActivity?: boolean
//   }) → { archivedSessionIds: readonly SessionId[] }
//
// 对应逆操作 unarchiveSession({ sessionId }) 也在同一个服务上。
//
// 设计边界（不越权）：
//   - 只归档 subagent 类型任务对应的**子会话**，不碰用户自己的普通会话；
//   - 只在任务已落终态后归档（活动中的绝不归档——那是把正在跑的东西藏起来）；
//   - 归档失败一律如实返回原因，不假装成功；
//   - 每个任务只尝试一次，失败不无限重试（避免对宿主形成请求风暴）。

/**
 * 取 workspaceController 服务。
 * @param {object} ctx Cordis 上下文
 * @returns {object|null}
 */
export function getWorkspaceController(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const svc = ctx.get('workspaceController');
      if (svc) return svc;
    }
  } catch { /* ctx.get 不认这个键 */ }
  try {
    return ctx?.workspaceController ?? null;
  } catch {
    return null;
  }
}

/**
 * 归档一个会话。返回 {ok, archived?, reason?}。
 *
 * @param {object} ctx        Cordis 上下文
 * @param {string} sessionId  要归档的会话 id
 * @param {object} [opts]
 * @param {boolean} [opts.stopActivity] 是否顺带停掉它的运行中工作（默认 false）
 */
export async function archiveSession(ctx, sessionId, opts = {}) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return { ok: false, reason: 'sessionId 为空' };

  const svc = getWorkspaceController(ctx);
  if (!svc) return { ok: false, reason: '宿主没有 workspaceController（本版本不支持归档）' };
  if (typeof svc.archiveSession !== 'function') {
    return { ok: false, reason: 'workspaceController 上没有 archiveSession（本版本不支持）' };
  }

  try {
    const res = await svc.archiveSession({
      sessionId: sid,
      ...(opts.stopActivity === undefined ? {} : { stopActivity: Boolean(opts.stopActivity) }),
    });
    const ids = Array.isArray(res?.archivedSessionIds) ? res.archivedSessionIds.map(String) : [];
    // 归档成功与否以返回集合里包不包含它为准，别只看没抛错。
    if (ids.includes(sid)) return { ok: true, archived: ids };
    return { ok: false, reason: `归档未被采纳（返回 ${JSON.stringify(ids)}）` };
  } catch (e) {
    return { ok: false, reason: `archiveSession 抛错：${String(e).slice(0, 160)}` };
  }
}

/**
 * 恢复归档。给「归档错了能退回来」留一条路。
 * @param {object} ctx
 * @param {string} sessionId
 */
export async function unarchiveSession(ctx, sessionId) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return { ok: false, reason: 'sessionId 为空' };
  const svc = getWorkspaceController(ctx);
  if (!svc || typeof svc.unarchiveSession !== 'function') {
    return { ok: false, reason: '宿主没有 unarchiveSession' };
  }
  try {
    const res = await svc.unarchiveSession({ sessionId: sid });
    const ids = Array.isArray(res?.archivedSessionIds) ? res.archivedSessionIds.map(String) : [];
    return { ok: !ids.includes(sid), archived: ids, reason: ids.includes(sid) ? '仍在归档集中' : undefined };
  } catch (e) {
    return { ok: false, reason: `unarchiveSession 抛错：${String(e).slice(0, 160)}` };
  }
}

/** 探测本机是否支持归档（启动自检用）。 */
export function probeArchiveCapability(ctx) {
  const svc = getWorkspaceController(ctx);
  if (!svc) return 'unsupported';
  return typeof svc.archiveSession === 'function' ? 'supported' : 'unsupported';
}
