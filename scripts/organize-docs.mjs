#!/usr/bin/env node
/**
 * docs 根目录散落文档归类。
 *
 * 背景：docs 根下堆了 299 个无前缀文档，按主题混在一起难以检索。
 * 归约：`未完成-*.md` 与 `已完成-*.md` 是**状态前缀**，按 docs/README.md 约定
 * 分别留在根下 / 进 `已完成/`，本脚本不碰它们，只处理无前缀的散落文件。
 *
 * 安全约束：
 * - 只移动，不删除；目标已存在同名文件时跳过并报告，不覆盖。
 * - 每步打印 `源 -> 目标`，便于 git 追溯（git 会识别为 rename）。
 * - --dry 只打印计划，不落盘。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const DRY = process.argv.includes("--dry");

/** 前缀 → 目标目录。按顺序匹配，命中即停。 */
const RULES = [
  [/^coding-plan-/, "coding-plan"],
  [/^desktop-/, "desktop"],
  [/^electron-/, "electron"],
  [/^(plans?)-/, "plan"],
  [/^web-remote-control-/, "web-remote-control"],
  [/^dynamic-workflow/, "dynamic-workflow"],
  [/^ci-/, "ci"],
  [/^cua-/, "cua"],
  [/^highspeed-/, "highspeed"],
  [/^oauth-/, "oauth"],
  [/^remote-/, "remote"],
  [/^task-/, "task"],
  [/^chat-/, "chat"],
  [/^ui-/, "ui"],
  [/^git-/, "git"],
  // 主题目录（部分已存在但为空）
  [/^zcode-/, "zcode"],
  [/^(model|bigmodel)-/, "model"],
  [/^(plugin|builtin-plugin|claude-.*marketplace)/, "plugins"],
  [/^mcp-/, "mcp"],
  [/^(settings|setting)-/, "settings"],
  [/^conversation-/, "conversation"],
  [/^(bots?)-/, "bots"],
  [/^(agents?|subagent)-/, "agents"],
  [/^wsl/, "wsl"],
  [/^windows-/, "windows"],
  [/^workspace-/, "workspace"],
  [/^web-/, "web"],
  [/^cli-/, "cli"],
  [/^automation/, "automation"],
  [/^cloud-content/, "cloud-content"],
  [/^(bash|background-bash|dangerous-command)-/, "shell"],
  [/^security-/, "security"],
  [/^performance-/, "performance"],
  [/^monitoring-/, "monitoring"],
  [/^i18n-/, "i18n"],
  [/^adr-/, "adr"],
  [/^specs?-/, "specs"],
  [/^issues?-/, "issues"],
  // 二轮细分：这些前缀此前都落进 misc，实际主题集中，单独成目录更好检索。
  [/^feedback-/, "feedback"],
  [/^external-agent-/, "external-agent"],
  [/^context-/, "context"],
  [/^session-/, "session"],
  [/^project-/, "project"],
  [/^permission-/, "permission"],
  [/^telemetry-/, "telemetry"],
  [/^trace-/, "trace"],
  [/^memory-/, "memory"],
  [/^skill-/, "skills"],
  [/^output-style/, "output-style"],
  [/^tool-/, "tools"],
  [/^file-/, "files"],
  [/^git-/, "git"],
  [/^term-|^terminal-/, "terminal"],
  [/^update-/, "update"],
  [/^font-|^typography-/, "typography"],
  [/^language-|^locale-/, "i18n"],
  [/^v4-/, "v4-refactor"],
  [/^(zai|bigmodel|start-plan|zcodeplan)-/, "model"],
  [/^usage-/, "usage"],
  [/^sidebar-/, "ui"],
  [/^product-/, "product"],
  [/^streaming-/, "conversation"],
  [/^onboarding-/, "onboarding"],
  [/^marketing-/, "marketing"],
  [/^hooks-/, "ui"],
  [/^feature-/, "product"],
  [/^welcome-/, "onboarding"],
  [/^websearch-/, "tools"],
  [/^whiteboard-/, "ui"],
  [/^workflow-/, "dynamic-workflow"],
  // 收尾：仍未命中的按主题兜底到 misc
];

/** 不参与归类的文件：状态前缀文档、README、图片等。 */
function isExcluded(name) {
  if (/^(未完成|已完成)-/.test(name)) return true;
  if (name === "README.md") return true;
  // 图片/数据文件不按 md 规则搬，留在原处避免引用失效。
  if (!name.endsWith(".md")) return true;
  return false;
}

const entries = readdirSync(DOCS, { withFileTypes: true }).filter((e) => e.isFile());
const plan = new Map(); // target -> [files]
const skipped = [];

for (const entry of entries) {
  const name = entry.name;
  if (isExcluded(name)) {
    skipped.push(name);
    continue;
  }
  let target = "misc";
  for (const [pattern, dir] of RULES) {
    if (pattern.test(name)) {
      target = dir;
      break;
    }
  }
  if (!plan.has(target)) plan.set(target, []);
  plan.get(target).push(name);
}

let moved = 0;
let conflicts = 0;
for (const [dir, files] of [...plan.entries()].sort()) {
  const targetDir = join(DOCS, dir);
  if (!DRY && !existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const from = join(DOCS, file);
    const to = join(targetDir, file);
    if (existsSync(to)) {
      console.log(`SKIP   ${file}  (目标已存在)`);
      conflicts += 1;
      continue;
    }
    if (DRY) {
      console.log(`PLAN   ${file}  ->  ${dir}/`);
    } else {
      renameSync(from, to);
      console.log(`MOVE   ${file}  ->  ${dir}/`);
    }
    moved += 1;
  }
}

console.log(`\n${DRY ? "[dry-run] " : ""}移动 ${moved} 个，跳过冲突 ${conflicts} 个，不参与归类 ${skipped.length} 个`);
for (const [dir, files] of [...plan.entries()].sort()) {
  console.log(`  ${dir}/  ${files.length} 个`);
}
