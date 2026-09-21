/**
 * G0 数据面「阈值常量」——与服务端 dist 自包含的取舍有关。
 *
 * 服务端刻意**不做 `@reactor/shared` 运行时依赖**（dist 自包含，见 packages/server/Dockerfile），
 * 因此 shared/src/audit.ts 里的常量在这里本地复制一份。
 * 契约类型仍从 shared **仅 type import**（编译期擦除，不进运行时）。
 *
 * ⚠ 改动时两边必须同步：`packages/shared/src/audit.ts` 的
 *    MAX_AUDIT_BATCH / MAX_AUDIT_SUMMARY_CHARS。
 *    行为由冒烟锁定（超批上限 → 400；超长 summary → 该条 rejected）。
 */

/** 单批事件上限 */
export const MAX_AUDIT_BATCH = 500;

/** 单条摘要字符上限（正文不落服务端的护栏之一） */
export const MAX_AUDIT_SUMMARY_CHARS = 200;
