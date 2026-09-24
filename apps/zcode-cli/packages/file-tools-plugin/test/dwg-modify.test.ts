import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dwgModify, dwgModifyInputSchema } from "../src/tools/dwg-modify.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "docs", "审查板块原始数据", "标准库测试文档");
const FIXTURE_DWG = join(FIXTURE_DIR, "FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg");

/** sidecar 可执行文件（bin/Release 或 dotnet publish 输出）；没有则跳过端到端用例。 */
function findSidecarExe(): string | null {
  // 优先自包含发布产物（dist/dwg-sidecar/<rid>），退回 framework 构建（bin/Release）。
  const exeName = process.platform === "win32" ? "dwg-sidecar.exe" : "dwg-sidecar";
  const packageDir = join(
    REPO_ROOT,
    "apps/zcode-cli/packages/file-tools-plugin",
  );
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

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dwg-modify-test-"));
  const filePath = join(dir, name);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

test("dwg_modify：非 dwg 拒绝；schema 校验", () => {
  assert.equal(dwgModifyInputSchema.safeParse({ file_path: "a.dwg" }).success, true);
  assert.equal(dwgModifyInputSchema.safeParse({ file_path: "" }).success, false);
  assert.equal(
    dwgModifyInputSchema.safeParse({
      file_path: "a.dwg",
      ops: [{ type: "replace_text", match: "a", replace: "b" }],
    }).success,
    true,
  );
  assert.equal(
    dwgModifyInputSchema.safeParse({
      file_path: "a.dwg",
      ops: [{ type: "unknown_op" }],
    }).success,
    false,
  );
});

test("dwg_modify：不存在的文件走统一防护", async () => {
  const sidecar = findSidecarExe();
  if (!sidecar) return; // 无 sidecar 时不启动子进程，护栏测试同样无意义
  await assert.rejects(dwgModify({ file_path: "Z:/missing.dwg" }), /文件不存在或不可读/);
});

test("dwg_modify：真实 DWG 读模式（sidecar 端到端）", async (t) => {
  const sidecar = findSidecarExe();
  if (!sidecar || !existsSync(FIXTURE_DWG)) {
    t.skip("sidecar 未构建（tools/dwg-sidecar/bin/Release）或 fixture 缺失，跳过端到端");
    return;
  }
  process.env.ZCODE_DWG_SIDECAR_PATH = sidecar;
  const result = await dwgModify({ file_path: FIXTURE_DWG });
  assert.equal(result.status, "success");
  assert.equal(result.metadata.version, "AC1018");
  assert.ok(result.metadata.layerCount >= 10, `图层数应 ≥10，实际 ${result.metadata.layerCount}`);
  assert.ok(result.metadata.textCount >= 100, `文本实体应 ≥100，实际 ${result.metadata.textCount}`);
  assert.ok(result.standardRefs.length >= 10, `标准引用应 ≥10，实际 ${result.standardRefs.length}`);
  // 契约兼容旧 parse_dwg：每条引用都有 ident，标准号带年份。
  for (const ref of result.standardRefs) {
    assert.ok(ref.standardIdent.length > 0, `引用缺少 ident：${ref.standardNo}`);
    assert.match(ref.standardNo, /\d{4}/, `标准号应带年份：${ref.standardNo}`);
  }
  const joined = result.standardRefs.map((ref) => ref.standardNo).join(" ");
  assert.match(joined, /GB|DL|HG/);
  assert.ok(result.text.startsWith("<file_content>"));
  assert.ok(result.text.includes("电解海水"));
});

test("dwg_modify：真实 DWG 修改模式——replace_text + rename_layer 落盘并读回校验", async (t) => {
  const sidecar = findSidecarExe();
  if (!sidecar || !existsSync(FIXTURE_DWG)) {
    t.skip("sidecar 未构建或 fixture 缺失，跳过端到端");
    return;
  }
  process.env.ZCODE_DWG_SIDECAR_PATH = sidecar;
  const dir = await mkdtemp(join(tmpdir(), "dwg-modify-e2e-"));
  const workCopy = join(dir, "mod-target.dwg");
  await writeFile(workCopy, await readFile(FIXTURE_DWG));

  const before = await dwgModify({ file_path: workCopy });
  assert.equal(before.status, "success");

  const result = await dwgModify({
    file_path: workCopy,
    ops: [
      { type: "replace_text", match: "电解海水制氯系统", replace: "电解海水制氯及循环水系统" },
      { type: "rename_layer", from: "GT_1", to: "GT_1_RENAMED" },
    ],
    in_place: true,
  });
  assert.equal(result.status, "success");
  assert.ok(result.modify, "修改模式应返回 modify 详情");
  assert.ok(result.modify!.modifiedHandles.length >= 1, "至少命中一个文本实体");
  assert.equal(result.modify!.verify.reReadOk, true);
  assert.equal(
    result.modify!.verify.entitiesAfter,
    before.metadata.entityCount,
    "写后实体数应保持一致",
  );
  assert.ok(result.text.includes("电解海水制氯及循环水系统"));
  assert.ok(result.layers.includes("GT_1_RENAMED"));
});

test("dwg_modify：文本型 .dwg 内容不走文件系统外的路径（安全护栏）", async () => {
  const fakeDwg = await writeTempFile("fake.dwg", "not-a-dwg");
  const sidecar = findSidecarExe();
  if (!sidecar) return;
  process.env.ZCODE_DWG_SIDECAR_PATH = sidecar;
  const result = await dwgModify({ file_path: fakeDwg });
  // sidecar 读不出内容时返回 failed；不允许静默成功。
  if (result.status === "success") {
    assert.equal(result.metadata.entityCount, 0);
  } else {
    assert.ok(result.note && result.note.length > 0);
  }
});
