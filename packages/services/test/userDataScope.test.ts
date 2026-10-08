import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZCODE_DATA_SCOPE_ENV_KEY,
  ZCODE_DATA_SCOPE_MARKER_FILE_NAME,
  ZCODE_LOCAL_DATA_SCOPE,
  ZCODE_USER_SCOPED_DATA_DIR_NAME,
  parseZCodeDataScopeMarkerFile,
  readZCodeDataScopeFromEnv,
  sanitizeZCodeDataScope,
  stringifyZCodeDataScopeMarkerFile,
} from "@zcode/shared";
import {
  getTasksIndexDatabasePath,
  resetZCodeDataScopeCache,
  setDataBaseDir,
} from "../src/paths.js";

/**
 * 用户数据隔离的纯契约（docs/已完成/已完成-用户数据隔离-命名空间与切换.md）。
 *
 * 判据只有一条：不同 scope 必须解析到不同数据根，而 local 必须等于历史路径本身
 * （零迁移，已完成-data-directory-contract.md §5）。
 */

const previousScopeEnv = process.env[ZCODE_DATA_SCOPE_ENV_KEY];

test("sanitizeZCodeDataScope：空值回落本地态，非法字符折叠而不合并用户", () => {
  assert.equal(sanitizeZCodeDataScope(undefined), ZCODE_LOCAL_DATA_SCOPE);
  assert.equal(sanitizeZCodeDataScope("   "), ZCODE_LOCAL_DATA_SCOPE);
  assert.equal(sanitizeZCodeDataScope("tiankd"), "tiankd");
  assert.equal(sanitizeZCodeDataScope("u_12345.d"), "u_12345.d");
  // 折叠成 `_` 而不是回落 local：两个不同 uid 不能因为字符不同就共享同一份数据。
  const foldedA = sanitizeZCodeDataScope("田科/达");
  const foldedB = sanitizeZCodeDataScope("王五");
  assert.match(foldedA, /^[A-Za-z0-9._-]{1,64}$/);
  assert.notEqual(foldedA, foldedB, "折叠后还必须互不相同，否则中文 uid 会被折进同一目录");
  assert.match(sanitizeZCodeDataScope("a".repeat(200)), /^a{55}-[0-9a-f]{8}$/);
});

test("readZCodeDataScopeFromEnv：未注入 = 本地态", () => {
  assert.equal(readZCodeDataScopeFromEnv({}), ZCODE_LOCAL_DATA_SCOPE);
  assert.equal(readZCodeDataScopeFromEnv({ [ZCODE_DATA_SCOPE_ENV_KEY]: "" }), ZCODE_LOCAL_DATA_SCOPE);
  assert.equal(readZCodeDataScopeFromEnv({ [ZCODE_DATA_SCOPE_ENV_KEY]: " tiankd " }), "tiankd");
});

test("marker 往返：scope 与 uid 保留，损坏内容回落本地态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "data-scope-marker-"));
  try {
    const filePath = join(dir, ZCODE_DATA_SCOPE_MARKER_FILE_NAME);
    await writeFile(
      filePath,
      stringifyZCodeDataScopeMarkerFile({ scope: "tiankd", uid: "tiankd" }),
      "utf8",
    );
    const marker = parseZCodeDataScopeMarkerFile(await readFile(filePath, "utf8"));
    assert.equal(marker.scope, "tiankd");
    assert.equal(marker.uid, "tiankd");

    await writeFile(filePath, "{ 这不是 JSON", "utf8");
    assert.equal(parseZCodeDataScopeMarkerFile("{ 这不是 JSON").scope, ZCODE_LOCAL_DATA_SCOPE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tasks-index 路径：local = 历史路径；uid scope = users/{uid} 前缀", async () => {
  const dir = await mkdtemp(join(tmpdir(), "data-scope-paths-"));
  try {
    setDataBaseDir(dir);

    delete process.env[ZCODE_DATA_SCOPE_ENV_KEY];
    resetZCodeDataScopeCache();
    assert.equal(
      getTasksIndexDatabasePath(),
      join(dir, ".reactor", "v2", "tasks-index.sqlite"),
      "无 scope 时必须是历史路径，否则老用户升级后历史任务全部消失",
    );

    process.env[ZCODE_DATA_SCOPE_ENV_KEY] = "tiankd";
    resetZCodeDataScopeCache();
    assert.equal(
      getTasksIndexDatabasePath(),
      join(
        dir,
        ".reactor",
        ZCODE_USER_SCOPED_DATA_DIR_NAME,
        "tiankd",
        "v2",
        "tasks-index.sqlite",
      ),
    );

    process.env[ZCODE_DATA_SCOPE_ENV_KEY] = "admin";
    resetZCodeDataScopeCache();
    assert.equal(
      getTasksIndexDatabasePath(),
      join(
        dir,
        ".reactor",
        ZCODE_USER_SCOPED_DATA_DIR_NAME,
        "admin",
        "v2",
        "tasks-index.sqlite",
      ),
    );
  } finally {
    if (previousScopeEnv === undefined) delete process.env[ZCODE_DATA_SCOPE_ENV_KEY];
    else process.env[ZCODE_DATA_SCOPE_ENV_KEY] = previousScopeEnv;
    resetZCodeDataScopeCache();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
