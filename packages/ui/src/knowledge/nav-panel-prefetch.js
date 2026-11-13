/**
 * 导航预热缓存 shim。
 *
 * EvoFlow 的 `lib/nav-panel-prefetch.js` 在鼠标悬停侧栏项时预取列表数据，
 * 点进页面时用 `takeNavWarm(key)` 直接拿缓存。我们没有这套预热机制
 * （Reactor 的侧栏走自己的 prefetch），所以 `takeNavWarm` 恒返回 null ——
 * 调用方会走正常的 `api.listOwnedKnowledgeBases()` 重新拉取，行为正确，
 * 只是少了 hover 预热的提速。
 *
 * 保留同名导出是为了不改 EvoFlow 页面的调用点。
 */

/** @returns {null} 永远没有预热缓存，调用方会回退到真实请求。 */
export function takeNavWarm(_key) {
  return null;
}

/** 预热入口：空实现（我们不预热）。 */
export function warmNav(_key, _loader) {
  /* no-op */
}
