import { USER_DATA_DIR_NAME } from "@zcode/shared";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `server-skills` 根目录的唯一所有者：同步器（写）与 skillsService / CLI 发现层（读）
 * 都必须用这里，不得各写一份，否则「同步下来没人发现」。
 *
 * 解析口径与 skillsService 的用户技能根逐字一致：env `HOME`/`USERPROFILE` →
 * `homedir()`，再拼 `USER_DATA_DIR_NAME`。刻意**不**用 paths.ts 的
 * `getDataBaseDir()`——发现层走的是 env/home 口径，写入方与读取方必须同一个目录
 * （契约 docs/server-skill-sync.md §2 不变式 3）。
 *
 * 本文件是 node-only（node:os/node:path），不能从 services 根 index 再导出。
 */
export function resolveServerSkillRoot(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  const home = envHome && envHome.length > 0 ? envHome : homedir();
  return join(home, USER_DATA_DIR_NAME, "server-skills");
}
