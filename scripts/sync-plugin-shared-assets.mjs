#!/usr/bin/env node
/**
 * 插件间共享资产的单源同步：canonical → 各插件副本。
 *
 * 背景：visual-judge.md（审查验收 agent 定义）在 documents/pdf/presentations/
 * spreadsheets 四个内容型插件里各有一份字节级相同拷贝，改一处漏三处会让
 * 「审查标准」随时间分叉。约定：**documents-plugin 是正本**，其余为生成副本；
 * seed 校验（official-plugin-seeds.mjs 的 requiredSeedPaths）仍要求每个插件目录
 * 都有实体文件（自包含分发约定不变）。
 *
 * 用法：
 *   node scripts/sync-plugin-shared-assets.mjs          # 正本 → 副本同步
 *   node scripts/sync-plugin-shared-assets.mjs --check  # 只校验一致性（CI/打包前）
 */
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
/** 正本 → 副本清单（新增共享资产时在此登记）。 */
const SHARED_ASSETS = [
  {
    canonical: "apps/zcode-cli/packages/documents-plugin/agents/visual-judge.md",
    copies: [
      "apps/zcode-cli/packages/pdf-plugin/agents/visual-judge.md",
      "apps/zcode-cli/packages/presentations-plugin/agents/visual-judge.md",
      "apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md",
    ],
  },
];

const checkOnly = process.argv.includes("--check");
let drifted = false;

for (const asset of SHARED_ASSETS) {
  const canonicalPath = join(repoRoot, asset.canonical);
  const canonicalHash = createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
  for (const copy of asset.copies) {
    const copyPath = join(repoRoot, copy);
    let copyHash = "";
    try {
      copyHash = createHash("sha256").update(readFileSync(copyPath)).digest("hex");
    } catch {
      copyHash = "<缺失>";
    }
    if (copyHash === canonicalHash) continue;
    drifted = true;
    if (checkOnly) {
      console.error(`[sync] 漂移：${copy} ≠ 正本 ${asset.canonical}`);
      continue;
    }
    copyFileSync(canonicalPath, copyPath);
    console.log(`[sync] 已同步：${copy}`);
  }
}

if (checkOnly && drifted) {
  console.error("[sync] 存在漂移：跑 node scripts/sync-plugin-shared-assets.mjs 同步后重试");
  process.exit(1);
}
if (!checkOnly && !drifted) {
  console.log("[sync] 全部一致，无需更新");
}
