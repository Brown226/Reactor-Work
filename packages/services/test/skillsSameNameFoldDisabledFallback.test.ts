import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { USER_DATA_DIR_NAME } from "@zcode/shared";

/**
 * 同名折叠的回落：server 版被本地停用时，同名回落到 user 版（契约 §6.1
 * 「启停 = 是否注入」——停用优先于来源优先级）。
 *
 * 单独成文件：skillsService 的 CLI config 路径是模块级常量，import 时即固定 HOME；
 * node:test 每文件独立进程，这里必须在 import 前设好 HOME（动态 import）。
 */

const USER_SKILL_MD = "---\nname: dup\ndescription: user version\n---\n\nUSER-BODY\n";
const SERVER_SKILL_MD = "---\nname: dup\ndescription: server version\n---\n\nSERVER-BODY\n";

test("server 版被本地停用时，同名回落到 user 版", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-fold-fallback-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const userDir = join(home, USER_DATA_DIR_NAME, "skills", "dup");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "SKILL.md"), USER_SKILL_MD, "utf-8");
    const serverDir = join(home, USER_DATA_DIR_NAME, "server-skills", "dup");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "SKILL.md"), SERVER_SKILL_MD, "utf-8");

    // 停用 server 版：写 CLI config 的 skills enabled map。键是发现阶段 realpath 后的
    // SKILL.md 路径（正斜杠、原大小写——normalizeSkillConfigPath 只换分隔符）。
    const serverSkillCanonicalPath = (await realpath(join(serverDir, "SKILL.md"))).replaceAll(
      "\\",
      "/",
    );
    const cliDir = join(home, USER_DATA_DIR_NAME, "cli");
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      join(cliDir, "config.json"),
      JSON.stringify({ skills: { [serverSkillCanonicalPath]: { enable: false } } }, null, 2),
      "utf-8",
    );

    const { createSkillsService } = await import("../src/skills/skillsService.js");
    const service = createSkillsService({ isDesktopRuntime: true });
    const context = await service.buildPromptContext({
      workspacePath: join(home, "workspace"),
      prompt: "请使用 $dup 完成",
    });

    assert.ok(context.prompt.includes("USER-BODY"), "server 版停用后应回落到 user 版");
    assert.ok(!context.prompt.includes("SERVER-BODY"), "停用的 server 版不应注入");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});
