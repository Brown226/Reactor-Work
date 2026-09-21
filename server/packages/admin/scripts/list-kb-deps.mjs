/** 临时清单工具：枚举移植页面引用的上游服务具名导入（用完即删，不进门禁） */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname ?? ".", "..", "src", "kb-port", "pages", "datasets");
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) files.push(p);
  }
})(root);

const bySpec = new Map();
for (const f of files) {
  const t = readFileSync(f, "utf8");
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/gs;
  for (const m of t.matchAll(re)) {
    const spec = m[3];
    if (!spec.includes("services/web") && !spec.includes("services/console") && !spec.includes("ask-assistant-ui") && !spec.includes("@buildingai/hooks") && !spec.includes("@buildingai/stores") && !spec.includes("@buildingai/utils")) continue;
    const names = m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^type\s+/, ""));
    if (!bySpec.has(spec)) bySpec.set(spec, new Map());
    const agg = bySpec.get(spec);
    for (const n of names) agg.set(n, (agg.get(n) ?? 0) + 1);
  }
}
for (const [spec, names] of [...bySpec].sort()) {
  console.log(`\n${spec}`);
  for (const [n, c] of [...names].sort()) console.log(`   ${String(c).padStart(2)}  ${n}`);
}
