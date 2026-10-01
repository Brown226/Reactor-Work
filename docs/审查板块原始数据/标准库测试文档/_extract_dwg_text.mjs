// 一次性的图纸文本抽取脚本：调用 dwg-tools 的 DWG sidecar（与 dwg_modify 同一引擎），
// 把整图文本落成 .txt 供 KnowledgeCheck(textFile) 做标准引用比对，并保存 standardRefs。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SIDECAR =
  "E:/工作/Reactor-Work/apps/zcode-cli/packages/dwg-tools-plugin/dist/dwg-sidecar/win-x64/dwg-sidecar.exe";
const DWG =
  "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg";
const OUT_TXT =
  "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/_FZ9HX011101B25A43SDACFC_extracted.txt";
const OUT_JSON =
  "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/_FZ9HX011101B25A43SDACFC_refs.json";

const child = spawn(SIDECAR, [], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
child.on("close", (code) => {
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line) {
    console.error(`sidecar 无响应 exit=${code}: ${stderr.slice(0, 400)}`);
    process.exit(1);
  }
  const res = JSON.parse(line);
  if (!res.ok) {
    console.error(`sidecar 返回错误: ${res.error}`);
    process.exit(1);
  }
  // 图纸正文：text 字段已是整图文本，去掉 <file_content> 包裹后原样落盘。
  const raw = String(res.text ?? "");
  const body = raw.replace(/^<file_content>/, "").replace(/<\/file_content>\s*$/, "");
  writeFileSync(OUT_TXT, body, "utf8");
  writeFileSync(OUT_JSON, JSON.stringify(res.standardRefs ?? [], null, 2), "utf8");
  console.log(
    JSON.stringify({
      txtChars: body.length,
      layerCount: res.layers?.length ?? 0,
      textCount: res.metadata?.textCount ?? null,
      dimensionCount: res.metadata?.dimensionCount ?? null,
      entityCount: res.metadata?.entityCount ?? null,
      version: res.metadata?.version ?? null,
      standardRefCount: (res.standardRefs ?? []).length,
      truncated: res.truncated ?? false,
    }),
  );
});
child.stdin.write(JSON.stringify({ command: "read", path: DWG, maxTextEntities: 20000 }));
child.stdin.end();
