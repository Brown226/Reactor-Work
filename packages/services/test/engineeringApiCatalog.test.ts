import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearApiCatalogCache,
  loadApiCatalogTools,
  resolveApiCatalogPath,
} from "../src/engineering/mcp-link/api-catalog.js";

const tempDirs: string[] = [];

async function makeSkillsRoot(layout: Record<string, string | null>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eng-catalog-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(layout)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    if (content !== null) await writeFile(full, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  clearApiCatalogCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveApiCatalogPath", () => {
  it("按 <标识>-Link 目录定位目录文件", async () => {
    const root = await makeSkillsRoot({
      "SAP2000-Link/references/api.catalog.json": "[]",
    });
    expect(resolveApiCatalogPath("sap2000", root)).toBe(
      join(root, "SAP2000-Link", "references", "api.catalog.json"),
    );
  });

  it("标识大小写不敏感", async () => {
    const root = await makeSkillsRoot({
      "ETABS-Link/references/api.catalog.json": "[]",
    });
    expect(resolveApiCatalogPath("ETABS", root)).toBe(
      join(root, "ETABS-Link", "references", "api.catalog.json"),
    );
  });

  it("也接受与标识同名的目录", async () => {
    const root = await makeSkillsRoot({
      "rhino/references/api.catalog.json": "[]",
    });
    expect(resolveApiCatalogPath("rhino", root)).toBe(
      join(root, "rhino", "references", "api.catalog.json"),
    );
  });

  it("目录存在但缺目录文件时返回 undefined", async () => {
    const root = await makeSkillsRoot({ "AutoCAD-Link/SKILL.md": "# x" });
    expect(resolveApiCatalogPath("autocad", root)).toBeUndefined();
  });

  it("未知标识与空标识返回 undefined", async () => {
    const root = await makeSkillsRoot({ "SAP2000-Link/references/api.catalog.json": "[]" });
    expect(resolveApiCatalogPath("nowhere", root)).toBeUndefined();
    expect(resolveApiCatalogPath("  ", root)).toBeUndefined();
  });

  it("技能根不存在时降级为 undefined 而不是抛异常", () => {
    expect(
      resolveApiCatalogPath("sap2000", join(tmpdir(), "no-such-skills-root-xyz")),
    ).toBeUndefined();
  });

  it("能在仓库内置技能里定位到真实目录（防止资源被漏拷）", async () => {
    const path = resolveApiCatalogPath("sap2000");
    expect(path).toBeTruthy();
    const tools = await loadApiCatalogTools({ id: "sap2000", path });
    expect(tools.length).toBeGreaterThan(1000);
    expect(tools[0]?.name).toBeTruthy();
  });
});

describe("loadApiCatalogTools", () => {
  it("缺少 path 时返回空数组", async () => {
    expect(await loadApiCatalogTools({ id: "x" })).toEqual([]);
  });

  it("文件不存在时返回空数组", async () => {
    expect(await loadApiCatalogTools({ id: "x", path: join(tmpdir(), "nope-xyz.json") })).toEqual(
      [],
    );
  });

  it("解析 JSON 数组并丢弃无名条目", async () => {
    const root = await makeSkillsRoot({
      "A-Link/references/api.catalog.json": JSON.stringify([
        { name: "Add", purpose: "加法", syntax: "Add(a,b)", parameters: "a,b", module: "M" },
        { purpose: "缺少名字" },
        { name: "" },
      ]),
    });
    const tools = await loadApiCatalogTools({
      id: "a",
      path: join(root, "A-Link", "references", "api.catalog.json"),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "Add", description: "加法", group: "M" });
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("解析行式 TSV 形态", async () => {
    const root = await makeSkillsRoot({
      "B-Link/references/api.catalog.json": "Foo\t说明\tFoo(x)\tMod\n# 注释\n\nBar\t\t\t\n",
    });
    const tools = await loadApiCatalogTools({
      id: "b",
      path: join(root, "B-Link", "references", "api.catalog.json"),
    });
    expect(tools.map((t) => t.name)).toEqual(["Foo", "Bar"]);
  });

  it("非法 JSON 返回空数组而不是抛异常", async () => {
    const root = await makeSkillsRoot({
      "C-Link/references/api.catalog.json": "[{not json",
    });
    expect(
      await loadApiCatalogTools({
        id: "c",
        path: join(root, "C-Link", "references", "api.catalog.json"),
      }),
    ).toEqual([]);
  });

  it("同一路径第二次读取命中缓存", async () => {
    const root = await makeSkillsRoot({
      "D-Link/references/api.catalog.json": JSON.stringify([{ name: "Only" }]),
    });
    const path = join(root, "D-Link", "references", "api.catalog.json");
    const first = await loadApiCatalogTools({ id: "d", path });
    const second = await loadApiCatalogTools({ id: "d", path });
    expect(second).toBe(first);
  });
});
