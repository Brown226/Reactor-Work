/**
 * [本地定制] 导航面板的悬停预热缓存。
 *
 * 用途：鼠标悬停侧栏条目时先把列表数据取回来，点进去就不用等。
 * 消费方（knowledge-owned.jsx:1297）的契约是：
 *   const { takeNavWarm } = await import("./nav-panel-prefetch.js");
 *   const cached = takeNavWarm("knowledge:bases");  // 命中返回 { items }, 未命中返回 null
 *   if (!cached) cached = await api.listOwnedKnowledgeBases(...);
 *
 * 设计取舍：
 * - **纯缓存，不是数据源**。命中就用、未命中就返回 null 让调用方自己取，
 *   所以即使预热从未发生（例如没人写过 warmNav），功能也完全正常，只是少一次
 *   加速。这样本模块坏了也不会影响正确性。
 * - 一次取值即失效（take 的语义）：消费方拿到后缓存被清掉，避免展示陈旧列表。
 * - 只存内存，不落盘；页面刷新即失效。
 * - 带 TTL：网络慢时预热结果可能已经过期，超过 30 秒按未命中处理。
 */

/** 预热缓存的有效期：超过就当作未命中，宁可多请求一次也不显示旧数据。 */
const WARM_TTL_MS = 30_000;

/** key → { value, at }。value 是调用方最终要拿到的那个响应对象。 */
const warm = new Map();

/**
 * 写一条预热结果。给「悬停时开始取数」的地方调用。
 * @param {string} key 缓存键，例如 "knowledge:bases"
 * @param {unknown} value 已经取回的响应（原样存，take 时原样返回）
 */
export function putNavWarm(key, value) {
  if (typeof key !== "string" || key === "") return;
  warm.set(key, { value, at: Date.now() });
}

/**
 * 取走一条预热结果（一次性）。
 * @param {string} key
 * @returns {unknown | null} 命中且未过期返回值本身；否则 null
 */
export function takeNavWarm(key) {
  const entry = warm.get(key);
  if (entry === undefined) return null;
  // 无论是否过期都取走：过期值没有保留价值，留着只会占内存。
  warm.delete(key);
  if (Date.now() - entry.at > WARM_TTL_MS) return null;
  return entry.value;
}

/** 丢弃某个 key 或全部缓存。数据变更后调用，避免把旧列表当预热结果发出去。 */
export function clearNavWarm(key) {
  if (key === undefined) warm.clear();
  else warm.delete(key);
}
