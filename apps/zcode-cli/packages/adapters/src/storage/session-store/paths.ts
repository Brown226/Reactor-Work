import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import {
  USER_DATA_DIR_NAME,
  ZCODE_LOCAL_DATA_SCOPE,
  ZCODE_USER_SCOPED_DATA_DIR_NAME,
  readZCodeDataScopeFromEnv,
} from "@zcode/shared";

/** 历史（本地态）会话库相对用户数据根的段：`./cli/db/db.sqlite`。 */
const LEGACY_SESSION_DB_SEGMENTS = ["cli", "db", "db.sqlite"] as const;

/**
 * 会话库默认路径：`{用户数据根}/users/{scope}/cli/db/db.sqlite`。
 *
 * 会话语料（消息正文）只按 workspace 分表，不认企业身份；同一台机器上换企业账号登录
 * 就等于把上一任账号的会话原样交出去。因此这里跟随 Host 注入的 `ZCODE_DATA_SCOPE`
 * 分命名空间，未注入（本地/终端手工启动 CLI）时沿用历史路径，零迁移。
 */
export function getDefaultSessionDbPath(): string {
  const scope = readZCodeDataScopeFromEnv(process.env);
  return join(homedir(), USER_DATA_DIR_NAME, ...scopeSegments(scope), ...LEGACY_SESSION_DB_SEGMENTS);
}

/**
 * 把「默认形态」的会话库路径改写到当前数据命名空间。
 *
 * 只改默认形态：用户显式配了 `storage.sessionDbPath` 时原样返回，配置优先级高于隔离策略
 * （那边写的是用户自己的选择，不是我们的兜底值）。默认形态的判定用段比对，不依赖字符串
 * 配置值——配置项将来换成别的字面量也不会让这里静默失效。
 */
export function applyDataScopeToDefaultSessionDbPath(dbPath: string): string {
  const scope = readZCodeDataScopeFromEnv(process.env);
  if (scope === ZCODE_LOCAL_DATA_SCOPE) {
    return dbPath;
  }
  const legacy = join(homedir(), USER_DATA_DIR_NAME, ...LEGACY_SESSION_DB_SEGMENTS);
  return dbPath === legacy
    ? join(homedir(), USER_DATA_DIR_NAME, ...scopeSegments(scope), ...LEGACY_SESSION_DB_SEGMENTS)
    : dbPath;
}

function scopeSegments(scope: string): string[] {
  return scope === ZCODE_LOCAL_DATA_SCOPE ? [] : [ZCODE_USER_SCOPED_DATA_DIR_NAME, scope];
}

export function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    maybeThrowStorageFsFault({ operation: "mkdir", path: parent });
    mkdirSync(parent, { recursive: true });
  }
}
