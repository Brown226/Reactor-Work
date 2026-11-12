/**
 * 向量维度解析（纯函数，零依赖）—— 从 `format_type(atttypid, atttypmod)` 的结果里取维度。
 *
 * ## 为什么单独一个文件
 *
 * 为了**可测**：t202 探针按 `file://` 直接 import 本文件钉住解析规则（本仓既有手法：
 * 把判断抽成纯函数，探针不渲染组件也能钉矩阵）。放在 admin-routes.ts 里就会把
 * hono / pg 一整条依赖链拖进探针。
 *
 * ## 为什么解析 `format_type` 而不是直接读 atttypmod（踩过的坑，别改回去）
 *
 * 第一版写成「`atttypmod - 4`」，理由是 varchar/numeric 的 atttypmod 确实带 4 字节头。
 * 但 **pgvector 不是这样**：`vector(1024)` 的 atttypmod 就是 `1024`，实测
 * `SELECT atttypmod, format_type(atttypid, atttypmod) → 1024, 'vector(1024)'`。
 * 于是上报的维度变成 1020，而知识库检索配置的**维度闸门**会拿它去比对 ——
 * 结果是**正确的 1024 维模型被判成不一致、拒绝保存**（假拒绝），且界面显示的维度也是错的。
 *
 * 改成交给 `format_type` 出字符串再解析：不管将来 pgvector 怎么存 atttypmod，
 * 只要类型名还是 `vector(N)` 就解析得对；解析不出来就返回 null（调用方按"未知"处理，
 * 不去做维度闸门，而不是拿一个错数字去拦人）。
 */

/**
 * 从 PostgreSQL 的类型全名里取向量维度。
 *
 * @example
 *   parseVectorDim("vector(1024)") // 1024
 *   parseVectorDim("vector(4096)") // 4096
 *   parseVectorDim("integer")      // null（不是向量列）
 *   parseVectorDim(null)           // null（列不存在 / 探测失败）
 */
export function parseVectorDim(fullType: string | null | undefined): number | null {
  if (typeof fullType !== "string") return null;
  const m = /^\s*vector\s*\(\s*(\d+)\s*\)\s*$/i.exec(fullType);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
