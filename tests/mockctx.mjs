// 统一的 Cordis ctx mock，行为对齐 cordis 4.x：
//   - 核心方法（on / get / inject / effect / emit ...）直接可读
//   - inject 白名单里的服务直接可读
//   - 其他服务直取抛 `cannot get property "x" without inject`
//   - ctx.get(name) 是可选查询，永远不抛
const CORE = new Set([
  'get','on','once','off','emit','inject','effect','set','provide','plugin',
  'logger','tools','jobs','agents','systemPrompt','then',
]);

export function mkCtx(over = {}) {
  const store = {
    logger: { info: () => {} },
    tools: { register() {} },
    on: () => () => {},
    ...over,
  };
  return new Proxy(store, {
    get(t, prop) {
      if (prop === 'get') return (name) => t[name];
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
