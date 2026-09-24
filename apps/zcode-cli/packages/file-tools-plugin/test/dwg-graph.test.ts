import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dwgGraph, dwgGraphInputSchema } from "../src/tools/dwg-graph.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "docs", "审查板块原始数据", "标准库测试文档");
const FIXTURE_DWG = join(FIXTURE_DIR, "FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg");

/** sidecar 可执行文件（bin/Release 或 dotnet publish 输出）；没有则跳过端到端用例。 */
function findSidecarExe(): string | null {
  const exeName = process.platform === "win32" ? "dwg-sidecar.exe" : "dwg-sidecar";
  const packageDir = join(REPO_ROOT, "apps/zcode-cli/packages/file-tools-plugin");
  const candidates = [
    process.env.ZCODE_DWG_SIDECAR_PATH,
    join(packageDir, "dist/dwg-sidecar", `${process.platform}-${process.arch}`, exeName),
    join(packageDir, "tools/dwg-sidecar/bin/Release/net9.0", exeName),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

test("dwg_graph：schema 校验（snap_tol 与上限边界）", () => {
  assert.equal(dwgGraphInputSchema.safeParse({ file_path: "a.dwg" }).success, true);
  assert.equal(dwgGraphInputSchema.safeParse({ file_path: "" }).success, false);
  assert.equal(dwgGraphInputSchema.safeParse({ file_path: "a.dwg", snap_tol: 0.05 }).success, false);
  assert.equal(dwgGraphInputSchema.safeParse({ file_path: "a.dwg", snap_tol: 1000 }).success, true);
  assert.equal(dwgGraphInputSchema.safeParse({ file_path: "a.dwg", max_symbols: 60000 }).success, false);
  assert.equal(dwgGraphInputSchema.safeParse({ file_path: "a.dwg", max_segments: 50000 }).success, true);
});

test("dwg_graph：非 dwg 拒绝；不存在的文件走统一防护", async () => {
  const notDwg = await dwgGraph({ file_path: "a.txt" });
  assert.equal(notDwg.status, "failed");
  assert.match(notDwg.note ?? "", /不是 \.dwg 文件/);
  await assert.rejects(dwgGraph({ file_path: "Z:/missing.dwg" }), /文件不存在或不可读/);
});

test("dwg_graph：真实 DWG 端到端（sidecar graph 命令 + 融合）", async (t) => {
  const sidecar = findSidecarExe();
  if (!sidecar || !existsSync(FIXTURE_DWG)) {
    t.skip("sidecar 未构建（tools/dwg-sidecar/bin/Release）或 fixture 缺失，跳过端到端");
    return;
  }
  process.env.ZCODE_DWG_SIDECAR_PATH = sidecar;

  const result = await dwgGraph({ file_path: FIXTURE_DWG });
  assert.equal(result.status, "success");
  // 实测口径（M5）：1655 实体中 INSERT 仅 4 个（含匿名块 *U14/*U17），符号为散落图元画法；
  // 默认 snap=5 下 tag 与连线均为 0——工具如实返回稀疏图，不编造连接。
  assert.equal(result.stats.nodeCount, 4);
  assert.equal(result.stats.textCount, 617);
  assert.equal(result.stats.edgeCount, 0);
  assert.equal(result.stats.isolatedNodeCount, 4);
  assert.equal(result.truncated, false);
  for (const node of result.nodes) {
    assert.match(node.id, /^[0-9A-F]+$/, `handle 应为十六进制：${node.id}`);
  }
  assert.ok(result.text.startsWith("<file_content>"));
  assert.match(result.text, /\[符号\]/);

  // snap_tol 放大到 1000（绘图单位）：2 个符号命中最近文本——容差参数真实生效。
  const loose = await dwgGraph({ file_path: FIXTURE_DWG, snap_tol: 1000 });
  assert.equal(loose.status, "success");
  assert.equal(loose.stats.taggedNodeCount, 2);

  // 上限截断：sidecar 置 truncated，工具出 note 明示，不得静默。
  const capped = await dwgGraph({ file_path: FIXTURE_DWG, max_symbols: 1 });
  assert.equal(capped.status, "success");
  assert.equal(capped.truncated, true);
  assert.match(capped.note ?? "", /超过上限/);
});

test("dwg_graph：读不出内容的 .dwg 走失败路径（不静默成功）", async () => {
  const sidecar = findSidecarExe();
  if (!sidecar) return;
  process.env.ZCODE_DWG_SIDECAR_PATH = sidecar;
  const dir = await mkdtemp(join(tmpdir(), "dwg-graph-test-"));
  const fakeDwg = join(dir, "fake.dwg");
  await writeFile(fakeDwg, "not-a-dwg", "utf8");
  const result = await dwgGraph({ file_path: fakeDwg });
  assert.equal(result.status, "failed");
  assert.ok(result.note && result.note.length > 0, "失败必须带 note，不得静默");
});
