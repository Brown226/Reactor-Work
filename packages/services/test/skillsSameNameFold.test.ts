import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { USER_DATA_DIR_NAME } from "@zcode/shared";

/**
 * `$` 同名折叠：server 优先于 user（docs/server-skill-sync.md §6.1）。
 * 发现层仍两者都列（列表语义），但注入会话时同名只取 server 版。
 *
 * 单独成文件：skillsService 的 CLI config 路径是模块级常量，import 时即固定 HOME；
 * node:test 每文件独立进程，这里必须在 import 前设好 HOME（动态 import）。
 */

const USER_SKILL_MD = "---\nname: dup\ndescription: user version\n---\n\nUSER-BODY\n";
const SERVER_SKILL_MD = "---\nname: dup\ndescription: server version\n---\n\nSERVER-BODY\n";

test("同名折叠：$dup 注入 server 版而非 user 版", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-fold-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const userDir = join(home, USER_DATA_DIR_NAME, "skills", "dup");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "SKILL.md"), USER_SKILL_MD, "utf-8");
    const serverDir = join(home, USER_DATA_DIR_NAME, "server-skills", "dup");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "SKILL.md"), SERVER_SKILL_MD, "utf-8");

    const { createSkillsService } = await import("../src/skills/skillsService.js");
    const service = createSkillsService({ isDesktopRuntime: true });

    const context = await service.buildPromptContext({
      workspacePath: join(home, "workspace"),
      prompt: "请使用 $dup 完成",
    });

    assert.ok(context.prompt.includes("SERVER-BODY"), "应注入 server 版正文");
    assert.ok(!context.prompt.includes("USER-BODY"), "不应同时注入 user 版正文");
    assert.deepEqual(context.activatedSkillNames, ["dup"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
