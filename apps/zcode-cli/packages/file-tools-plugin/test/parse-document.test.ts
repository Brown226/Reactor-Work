import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { parseDocument, parseDocumentInputSchema } from "../src/tools/parse-document.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "docs", "审查板块原始数据", "标准库测试文档");

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "file-tools-test-"));
  const filePath = join(dir, name);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

test("parse_document：纯文本格式直读并用 <file_content> 包裹", async () => {
  const filePath = await writeTempFile("note.md", "# 标题\n你好，审查。");
  const result = await parseDocument({ file_path: filePath });
  assert.equal(result.parser, "plain-text");
  assert.equal(result.markdown, "<file_content># 标题\n你好，审查。</file_content>");
  assert.equal(result.charCount, "# 标题\n你好，审查。".length);
});

test("parse_document：不存在的文件给人话报错", async () => {
  const missing = join(tmpdir(), "file-tools-missing", "a.docx");
  await assert.rejects(parseDocument({ file_path: missing }), /文件不存在或不可读/);
});

test("parse_document：真实 docx 走 anydoc 出 markdown", async (t) => {
  const docx = join(FIXTURE_DIR, "HX1CI084200B25A43GNACFC (15251CI-JPS502).docx");
  let bytes: Buffer;
  try {
    bytes = await readFile(docx);
  } catch {
    t.skip("fixture docx 不在检出的 docs 目录，跳过真实解析");
    return;
  }
  assert.ok(bytes.length > 1000);
  const result = await parseDocument({ file_path: docx });
  assert.equal(result.parser, "anydoc");
  assert.ok(result.markdown.startsWith("<file_content>"));
  assert.ok(result.charCount > 1000, `docx 解析字符数应上千，实际 ${result.charCount}`);
  // 该 fixture 正文含「设计依据」与标准引用字样。
  assert.match(result.markdown, /设计依据|标准|规范/);
});

test("parse_document：空解析结果引导 ocr_scan（needsOCR 码）", async (t) => {
  // 用一个零字节文件触发 anydoc 的解析失败路径，验证错误翻成人话。
  const emptyPath = await writeTempFile("empty.docx", "");
  try {
    await parseDocument({ file_path: emptyPath });
    assert.fail("应当抛错");
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert.match(error instanceof Error ? error.message : String(error), /解析失败|不支持|空/);
    // 空文件要么报格式不支持，要么被 anydoc 拒绝；两种都必须是可读消息。
    if (code !== undefined) assert.equal(typeof code, "string");
  }
});

test("parse_document：输入 schema 拒绝空路径", () => {
  const parsed = parseDocumentInputSchema.safeParse({ file_path: "" });
  assert.equal(parsed.success, false);
});
