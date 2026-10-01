/**
 * guard.ts 路径校验单测：存在/是文件/体积之外，新增的「不跟符号链接出工作区」
 * （spec §4）在这里单独钉住，避免它随 pdf_* 工具一起漂移。
 */
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileToolError, assertReadableFile } from "../src/guard.js";

/**
 * 工作区根取宿主注入的 ZCODE_PROJECT_DIR / CLAUDE_PROJECT_DIR（见 src/guard.ts）。
 * 单测把它指到临时目录，「区外」就是另一个确定的临时目录，不依赖测试进程 cwd。
 */
async function withWorkspaceRoot<T>(root: string, run: () => Promise<T> | T): Promise<T> {
  const previousProject = process.env.ZCODE_PROJECT_DIR;
  const previousClaude = process.env.CLAUDE_PROJECT_DIR;
  process.env.ZCODE_PROJECT_DIR = root;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    return await run();
  } finally {
    if (previousProject === undefined) delete process.env.ZCODE_PROJECT_DIR;
    else process.env.ZCODE_PROJECT_DIR = previousProject;
    if (previousClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousClaude;
  }
}

/** Windows 无开发者模式/无权限时创建符号链接会 EPERM，返回 false 让用例跳过。 */
async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

async function setupWorkspace(): Promise<{
  workspace: string;
  outside: string;
  insideFile: string;
  outsideFile: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "guard-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "guard-outside-"));
  const insideFile = join(workspace, "inside.pdf");
  const outsideFile = join(outside, "secret.pdf");
  await writeFile(insideFile, "inside");
  await writeFile(outsideFile, "outside");
  return { workspace, outside, insideFile, outsideFile };
}

test("guard：工作区内文件与调用方显式给出的区外文件都放行", async () => {
  const { workspace, insideFile, outsideFile } = await setupWorkspace();
  await withWorkspaceRoot(workspace, () => {
    assert.doesNotThrow(() => assertReadableFile(insideFile));
    // 附件/临时目录常在区外，显式绝对路径按既有语义放行，不能被边界校验误杀
    assert.doesNotThrow(() => assertReadableFile(outsideFile));
  });
});

test("guard：工作区内的符号链接指向工作区外时被拒", async (t) => {
  const { workspace, outsideFile } = await setupWorkspace();
  const link = join(workspace, "escape.pdf");
  if (!(await trySymlink(outsideFile, link))) {
    t.skip("当前环境无法创建符号链接（Windows 需开发者模式/管理员）");
    return;
  }
  await withWorkspaceRoot(workspace, () => {
    assert.throws(
      () => assertReadableFile(link),
      (error: Error) => {
        assert.ok(error instanceof FileToolError, `应为 FileToolError，实际 ${error?.name}`);
        assert.match(error.message, /拒绝跟随符号链接到工作区之外/);
        return true;
      },
    );
    // 同一个目标直接给出（不经链接）仍然放行：被拒的是越过工作区的链接，不是文件本身
    assert.doesNotThrow(() => assertReadableFile(outsideFile));
  });
});

test("guard：指向工作区内的符号链接不误伤", async (t) => {
  const { workspace, insideFile } = await setupWorkspace();
  const link = join(workspace, "alias.pdf");
  if (!(await trySymlink(insideFile, link))) {
    t.skip("当前环境无法创建符号链接（Windows 需开发者模式/管理员）");
    return;
  }
  await withWorkspaceRoot(workspace, () => {
    assert.doesNotThrow(() => assertReadableFile(link));
  });
});

test("guard：不存在 / 不是文件的中文文案保持不变", async () => {
  const { workspace } = await setupWorkspace();
  await withWorkspaceRoot(workspace, () => {
    assert.throws(
      () => assertReadableFile(join(workspace, "missing.pdf")),
      /文件不存在或不可读/,
    );
    // 目录：statSync 通过、不是文件 → 原错误
    assert.throws(() => assertReadableFile(workspace), /不是文件/);
  });
});
