import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 随包资产起点可控：用例注入临时目录，不依赖仓库里真实的 services 产物。
const fakeBundleDirs = vi.hoisted(() => ({ dirs: [] as string[] }));
vi.mock("../src/app/official-plugin-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/official-plugin-runtime.js")>();
  return { ...actual, bundleBaseDirs: () => fakeBundleDirs.dirs };
});

const { ENGINEERING_MCP_SERVER_NAME, findEngineeringRuntimeRoot, resolveEngineeringRuntime } =
  await import("../src/app/engineering-runtime.js");

const MONOREPO_LAYOUT = ["packages", "services", "dist", "engineering"];
const STAGED_LAYOUT = ["packages", "engineering"];
const SKILLS_DIR = "skills";
const ENTRY_FILE = "mcp-server-main.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-engineering-runtime-"));
  fakeBundleDirs.dirs = [];
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 按给定布局造一份最小产物：入口 + 一个技能目录。 */
async function seedRuntime(baseDir: string, layout: readonly string[]): Promise<string> {
  const root = join(baseDir, ...layout);
  await mkdir(join(root, SKILLS_DIR, "AutoCAD-Link"), { recursive: true });
  await writeFile(join(root, ENTRY_FILE), "// entry\n");
  await writeFile(join(root, SKILLS_DIR, "AutoCAD-Link", "SKILL.md"), "# AutoCAD-Link\n");
  return root;
}

describe("findEngineeringRuntimeRoot", () => {
  it("命中 monorepo 布局并返回该根目录", async () => {
    const expected = await seedRuntime(workspace, MONOREPO_LAYOUT);
    const found = findEngineeringRuntimeRoot({
      ancestorBases: [workspace],
      flatBases: [],
    });
    expect(found).toBe(expected);
  });

  it("命中桌面 stage 布局 packages/engineering", async () => {
    const expected = await seedRuntime(workspace, STAGED_LAYOUT);
    const found = findEngineeringRuntimeRoot({ ancestorBases: [workspace], flatBases: [] });
    expect(found).toBe(expected);
  });

  it("从最深入口（bootstrap/dist/app 形态）向上回溯 6 层仍能命中", async () => {
    const expected = await seedRuntime(workspace, MONOREPO_LAYOUT);
    // 等价于 bootstrap/src/app：app → src → bootstrap → packages → zcode-cli → apps → 仓库根。
    const deepEntry = join(workspace, "apps", "zcode-cli", "packages", "bootstrap", "src", "app");
    await mkdir(deepEntry, { recursive: true });
    const found = findEngineeringRuntimeRoot({ ancestorBases: [deepEntry], flatBases: [] });
    expect(found).toBe(expected);
  });

  it("超过 6 层时不再回溯", async () => {
    await seedRuntime(workspace, MONOREPO_LAYOUT);
    const tooDeep = join(workspace, "a", "b", "c", "d", "e", "f", "g");
    await mkdir(tooDeep, { recursive: true });
    const found = findEngineeringRuntimeRoot({ ancestorBases: [tooDeep], flatBases: [] });
    expect(found).toBeUndefined();
  });

  it("缺少 skills 目录时按未命中处理", async () => {
    const root = join(workspace, ...MONOREPO_LAYOUT);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ENTRY_FILE), "// entry\n");
    const found = findEngineeringRuntimeRoot({ ancestorBases: [workspace], flatBases: [] });
    expect(found).toBeUndefined();
  });

  it("默认工作区兜底只看当前层，不向上回溯", async () => {
    const root = await seedRuntime(workspace, MONOREPO_LAYOUT);
    const nestedDir = join(root, "nested", "deeper");
    await mkdir(nestedDir, { recursive: true });
    const found = findEngineeringRuntimeRoot({ ancestorBases: [], flatBases: [nestedDir] });
    expect(found).toBeUndefined();
  });

  it("随包起点优先于工作区兜底", async () => {
    const bundledRoot = await seedRuntime(join(workspace, "bundle"), MONOREPO_LAYOUT);
    const cwdRoot = await seedRuntime(join(workspace, "cwd"), MONOREPO_LAYOUT);
    const found = findEngineeringRuntimeRoot({
      ancestorBases: [join(workspace, "bundle")],
      flatBases: [join(workspace, "cwd")],
    });
    expect(found).toBe(bundledRoot);
    expect(found).not.toBe(cwdRoot);
  });
});

describe("resolveEngineeringRuntime", () => {
  it("生成 stdio 配置：execPath 启动、带 ELECTRON_RUN_AS_NODE", async () => {
    const root = await seedRuntime(workspace, MONOREPO_LAYOUT);
    fakeBundleDirs.dirs = [workspace];

    const runtime = resolveEngineeringRuntime();
    expect(runtime).toBeDefined();
    expect(runtime?.serverEntryPath).toBe(join(root, ENTRY_FILE));
    expect(runtime?.mcpServer).toMatchObject({
      type: "stdio",
      command: process.execPath,
      args: [join(root, ENTRY_FILE)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(runtime?.skillRoot).toEqual({
      path: join(root, SKILLS_DIR),
      priority: 999_000,
      scope: "system",
      source: "bundled",
    });
  });

  it("未找到产物时返回 undefined，不抛错", () => {
    fakeBundleDirs.dirs = [workspace];
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(workspace, "nowhere"));
    try {
      expect(resolveEngineeringRuntime()).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("MCP 注册名固定为 engineering", () => {
    expect(ENGINEERING_MCP_SERVER_NAME).toBe("engineering");
  });
});
