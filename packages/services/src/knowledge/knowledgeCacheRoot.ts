import { homedir } from "node:os";
import { join } from "node:path";

import { USER_DATA_DIR_NAME } from "@zcode/shared";

/**
 * 知识缓存的**唯一所有者**（文件审查板块，见 docs/审查板块-方案-v1.md §4.4.3）。
 *
 * 写入方是端侧同步服务（`knowledgeSyncService`），读取方是 CLI 的 `KnowledgeCheck` 工具。
 * 两边必须解析出**同一个目录**，否则表现成「同步下来了但工具说缓存为空」——
 * 这与 `serverSkillsRoot.ts` 是同一类不变式，所以同样收口成一个文件。
 *
 * 解析口径与 `serverSkillsRoot` / `skillsService` 的用户技能根逐字一致：
 * env `HOME`/`USERPROFILE` 优先，回落 `homedir()`，再拼 `USER_DATA_DIR_NAME`（`.reactor`）。
 * 刻意不用 paths.ts 的 `getDataBaseDir()`：CLI 侧只能走 env/home 口径。
 *
 * `REACTOR_KNOWLEDGE_DIR` 可覆盖（与 CLI 工具同名环境变量）：测试与多环境隔离用。
 *
 * 本文件是 node-only（node:os/node:path），不能从 services 根 index 再导出。
 */
export function resolveKnowledgeCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["REACTOR_KNOWLEDGE_DIR"]?.trim();
  if (override) return override;
  const envHome = env["HOME"]?.trim() || env["USERPROFILE"]?.trim();
  const home = envHome && envHome.length > 0 ? envHome : homedir();
  return join(home, USER_DATA_DIR_NAME, "knowledge");
}
