/**
 * 用户级数据目录名：唯一事实源（本包副本）。
 *
 * 本包刻意不依赖 `@zcode/shared`（调试工具保持独立、可单独运行），因此保留一份与
 * `@zcode/shared` 同值的常量。值**包含前导点**，与磁盘上的目录名一致。
 * 改名时两处必须同步——见 `packages/shared/src/user-data-dir.ts` 的说明。
 */
export const USER_DATA_DIR_NAME = ".reactor";
