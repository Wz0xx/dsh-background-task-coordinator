// 统一的 Cordis ctx mock，行为对齐 cordis 4.x：
//   - 核心方法（on / get / inject / effect / emit ...）直接可读
//   - inject 白名单里的服务直接可读
//   - 其他服务直取抛 `cannot get property "x" without inject`
//   - ctx.get(name, strict = true) 是可选查询，永远不抛
//
// 0.2.6 关键：strict 语义必须复刻。
// 宿主原文（从 app.asar 读出）：
//     get(name, strict = true) { return getTraceable(this.ctx, this._getImpl(name, strict)?.value); }
//     _getImpl(name, strict = true) {
//       const impl = key && this.store[key];
//       if (!impl) return;
//       if (strict && impl.fiber.state !== 2) return;   // ACTIVE = 2
//       return impl;
//     }
//
// 也就是说 **strict=true 时只返回 fiber 已 ACTIVE 的服务**。
// 之前这个 mock 的 get 完全忽略 strict，导致「strict 查询拿不到服务」这个真 bug
// 在测试里永远暴露不出来（0.2.0–0.2.5 一直带着它）。
//
// 约定：要模拟「fiber 未 ACTIVE」的服务，用 { fiber: { state: 1 }, ...实际成员 }。
const CORE = new Set([
  'get','on','once','off','emit','inject','effect','set','provide','plugin',
  'logger','tools','jobs','agents','systemPrompt','then',
]);

const ACTIVE = 2;

export function mkCtx(over = {}) {
  const store = {
    logger: { info: () => {} },
    tools: { register() {} },
    on: () => () => {},
    ...over,
  };

  // 复刻宿主 _getImpl
  const getImpl = (name, strict) => {
    const impl = store[name];
    if (!impl) return undefined;
    // 只有明确带 fiber 的对象才参与状态判断；普通对象视为已 ACTIVE
    const st = impl.fiber?.state;
    if (strict && st !== undefined && st !== ACTIVE) return undefined;
    return impl;
  };

  return new Proxy(store, {
    get(t, prop) {
      // 0.2.6：get 必须接 strict 参数并按状态过滤
      if (prop === 'get') return (name, strict = true) => getImpl(name, strict);
      if (typeof prop === 'symbol') return t[prop];
      if (CORE.has(prop)) return t[prop];
      if (prop in t) {
        // 非核心、未 inject 的服务：cordis 直取即抛
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
      return undefined;
    },
    set(t, prop, v) { t[prop] = v; return true; },
    has(t, prop) { return prop in t; },
  });
}

/** 造一个「fiber 未 ACTIVE」的服务包装（用于测试 strict 语义）。 */
export function notActive(obj) {
  return { ...obj, fiber: { state: 1 } };
}