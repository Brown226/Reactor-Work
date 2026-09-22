import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { USER_DATA_DIR_NAME } from "@zcode/shared";
import { resolveDefaultSkillRoots } from "../src/skills/roots.js";

/**
 * server-skills 发现根的插入位置（docs/server-skill-sync.md §6.1）：
 * priority 必须位于 extraRoots 之后、用户级两根之前——CLI 的同名解析是
 * first-match（priority 升序），这样 server 版同名优先，且不改动既有
 * user/project 相对顺序。
 */

test("server-skills 根位于用户级两根之前、显式 extraRoots 之后", async () => {
  const home = homedir();
  const workspace = join(home, "some-workspace");
  const roots = await resolveDefaultSkillRoots(workspace, {
    homeDirectory: home,
    extraRoots: [join(home, "explicit-root")],
  });

  const serverRoot = roots.find((root) => root.source === "remote");
  assert.ok(serverRoot, "应存在 source=remote 的 server-skills 根");
  assert.equal(serverRoot.path, join(home, USER_DATA_DIR_NAME, "server-skills"));
  assert.equal(serverRoot.scope, "user", "服务端技能是用户级资源");

  const userZcodeRoot = roots.find((root) => root.scope === "user" && root.source === "zcode");
  const explicitRoot = roots.find((root) => root.path === join(home, "explicit-root"));
  assert.ok(userZcodeRoot, "应存在用户级 zcode 根");
  assert.ok(explicitRoot, "应存在显式 extraRoot");
  assert.ok(serverRoot.priority > explicitRoot.priority, "显式配置的 extraRoots 仍应最高优先");
  assert.ok(
    serverRoot.priority < userZcodeRoot.priority,
    "server-skills 必须优先于用户级两根（同名解析取 server 版）",
  );
});
