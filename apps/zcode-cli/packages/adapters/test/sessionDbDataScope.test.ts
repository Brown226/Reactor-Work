import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  USER_DATA_DIR_NAME,
  ZCODE_DATA_SCOPE_ENV_KEY,
  ZCODE_USER_SCOPED_DATA_DIR_NAME,
} from "@zcode/shared";
import {
  applyDataScopeToDefaultSessionDbPath,
  getDefaultSessionDbPath,
} from "../src/storage/session-store/paths.js";

/**
 * 会话语料库（消息正文真正所在）按企业用户分命名空间：
 * 未注入 scope 时沿用 `~/.reactor/cli/db/db.sqlite`（零迁移），
 * 注入后落到 `~/.reactor/users/{scope}/cli/db/db.sqlite`。
 */

const previous = process.env[ZCODE_DATA_SCOPE_ENV_KEY];

test.after(() => {
  if (previous === undefined) delete process.env[ZCODE_DATA_SCOPE_ENV_KEY];
  else process.env[ZCODE_DATA_SCOPE_ENV_KEY] = previous;
});

const defaultDbPath = join(homedir(), USER_DATA_DIR_NAME, "cli", "db", "db.sqlite");

test("无 scope：会话库走历史路径", () => {
  delete process.env[ZCODE_DATA_SCOPE_ENV_KEY];
  const path = getDefaultSessionDbPath();
  assert.ok(
    path.endsWith(join(USER_DATA_DIR_NAME, "cli", "db", "db.sqlite")),
    "本地态不能插入 users 层级，否则老用户的历史会话全部不可见",
    path,
  );
  assert.ok(!path.includes(ZCODE_USER_SCOPED_DATA_DIR_NAME), path);
});

test("有 scope：会话库进入用户命名空间", () => {
  process.env[ZCODE_DATA_SCOPE_ENV_KEY] = "tiankd";
  const tiankd = getDefaultSessionDbPath();
  process.env[ZCODE_DATA_SCOPE_ENV_KEY] = "admin";
  const admin = getDefaultSessionDbPath();
  assert.ok(tiankd.endsWith(join(ZCODE_USER_SCOPED_DATA_DIR_NAME, "tiankd", "cli", "db", "db.sqlite")));
  assert.ok(admin.endsWith(join(ZCODE_USER_SCOPED_DATA_DIR_NAME, "admin", "cli", "db", "db.sqlite")));
  assert.notEqual(tiankd, admin, "两个企业用户的会话语料不能落在同一个文件里");
});

test("默认形态才改写：显式配置的 storage.sessionDbPath 原样保留", () => {
  process.env[ZCODE_DATA_SCOPE_ENV_KEY] = "tiankd";
  assert.equal(applyDataScopeToDefaultSessionDbPath(defaultDbPath), getDefaultSessionDbPath());
  const custom = join(homedir(), "my-own-sessions.sqlite");
  assert.equal(applyDataScopeToDefaultSessionDbPath(custom), custom);
});

test("本地态不改写任何默认路径", () => {
  delete process.env[ZCODE_DATA_SCOPE_ENV_KEY];
  assert.equal(applyDataScopeToDefaultSessionDbPath(defaultDbPath), defaultDbPath);
});
