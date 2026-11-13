/**
 * Reactor 定制红线检查。
 *
 * 为什么需要：整包吸收上游时，本地定制极易被上游同名文件静默覆盖——编译器不会报错，
 * 只有线上跑起来才会以「数据落到别的目录」「登录页回来了」「标签全没了」的形式暴露。
 * 每一条都对应一次真实事故，检查失败时按提示恢复实现，不要改检查。
 *
 * 用法：node scripts/check-reactor-invariants.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

/**
 * 每条：name / file / test(content) / hint（怎么恢复）
 */
const INVARIANTS = [
  {
    name: "数据根目录使用 USER_DATA_DIR_NAME（红线：不能丢用户数据落点）",
    file: "packages/services/src/paths.ts",
    test: (s) => {
      // 只检查函数体里的实际 return 语句，注释里出现 ".zcode" 不算违规。
      const match = s.match(/export function getZCodeDataRootDir\(\)[^{]*\{([\s\S]*?)\n\}/);
      if (!match) return false;
      const body = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return body.includes("USER_DATA_DIR_NAME") && !body.includes('".zcode"');
    },
    hint: 'getZCodeDataRootDir() 必须 return join(getDataBaseDir(), USER_DATA_DIR_NAME)，不能硬编码 ".zcode"。',
  },
  {
    name: "USER_DATA_DIR_NAME 常量为 .reactor",
    file: "packages/shared/src/user-data-dir.ts",
    test: (s) => /USER_DATA_DIR_NAME\s*=\s*"\.reactor"/.test(s),
    hint: 'export const USER_DATA_DIR_NAME = ".reactor";',
  },
  {
    name: "数据作用域函数存在（企业多用户隔离）",
    file: "packages/services/src/paths.ts",
    test: (s) => ["getZCodeDataScope", "getZCodeDataScopeMarkerFilePath", "getZCodeUserScopedDataRootDir"].every((n) => s.includes(n)),
    hint: "补齐 getZCodeDataScope / getZCodeDataScopeMarkerFilePath / getZCodeUserScopedDataRootDir。",
  },
  {
    name: "免登录门禁关闭（本机无身份服务）",
    file: "packages/ui/src/lib/rootStartupGate.ts",
    test: (s) => {
      const idx = s.indexOf("shouldEnableProviderAvailabilityLoginEntryGuard");
      if (idx < 0) return false;
      const body = s.slice(idx, idx + 800);
      return /return false/.test(body);
    },
    hint: "shouldEnableProviderAvailabilityLoginEntryGuard 必须 return false（跳过启动身份门禁）。",
  },
  {
    name: "界面模式三档（办公/编程/审查）",
    file: "packages/ui/src/lib/interfaceMode.ts",
    test: (s) => s.includes('"office"') && s.includes('"coding"') && s.includes('"review"'),
    hint: 'export type InterfaceMode = "office" | "coding" | "review";',
  },
  {
    name: "isFocusedMode 收敛办公+审查",
    file: "packages/ui/src/hooks/useInterfaceMode.ts",
    test: (s) => {
      const idx = s.indexOf("useIsFocusedMode");
      if (idx < 0) return false;
      const body = s.slice(idx, idx + 600);
      return body.includes("review");
    },
    hint: "useIsFocusedMode 必须同时覆盖 office 与 review（审查档也要隐藏编程向 UI）。",
  },
  {
    name: "accessor 保留三个企业服务（可选）",
    file: "packages/services/src/accessor.ts",
    test: (s) =>
      ["reactorServerService?", "serverSkillSyncService?", "serverAgentSyncService?"].every((n) => s.includes(n)),
    hint: "IServiceAccessor 必须保留 reactorServerService? / serverSkillSyncService? / serverAgentSyncService?。",
  },
  {
    name: "企业服务通道存在",
    file: "packages/shared/src/channels.ts",
    test: (s) => ["ReactorServer", "ServerSkillSync", "ServerAgentSync"].every((n) => s.includes(n)),
    hint: "ServiceChannels 必须包含 ReactorServer / ServerSkillSync / ServerAgentSync。",
  },
  {
    name: "Markdown 导出通道存在",
    file: "packages/shared/src/channels.ts",
    test: (s) => s.includes("MarkdownExport") && s.includes("AboutVersionTap"),
    hint: "PlatformChannels 必须包含 MarkdownExport 与 AboutVersionTap / DevModeUnlock*。",
  },
  {
    name: "远程工作区本地项目根目录名",
    file: "packages/shared/src/web-remote-relay/domain/webRemoteControlActions.ts",
    test: (s) => /WEB_REMOTE_CONTROL_LOCAL_PROJECT_ROOT_DIR\s*=\s*"ZCodeProject"/.test(s),
    hint: 'export const WEB_REMOTE_CONTROL_LOCAL_PROJECT_ROOT_DIR = "ZCodeProject";',
  },
  {
    name: "产品文档入口走服务端策略（不硬编码官方站）",
    file: "packages/ui/src/lib/productDocs.ts",
    test: (s) => s.includes("resolveProductDocsUrl") && !s.includes("zcode.z.ai/docs"),
    hint: "resolveProductDocsUrl 必须只从服务端策略取值，不得硬编码官方文档地址。",
  },
  {
    name: "企业登录页组件存在",
    file: "packages/ui/src/EnterpriseLoginScreen.tsx",
    test: (s) => s !== null && s.includes("EnterpriseLoginScreen"),
    hint: "恢复 EnterpriseLoginScreen.tsx（企业账号登录入口）。",
  },
  {
    name: "企业账号设置分区存在",
    file: "packages/ui/src/settings/account/AccountSection.tsx",
    test: (s) => s !== null && s.includes("settings.account"),
    hint: "恢复 settings/account 分区，并在 userActionTraceCatalog 注册 settings.account 动作。",
  },
  {
    name: "强制改密门禁存在",
    file: "packages/ui/src/settings/account/ForcePasswordChangeDialog.tsx",
    test: (s) => s !== null,
    hint: "恢复 ForcePasswordChangeDialog.tsx（初始密码必须改过一次才放行）。",
  },
  {
    name: "背景壁纸主题切片",
    file: "packages/ui/src/store/backgroundThemeState.ts",
    test: (s) => s !== null && s.includes("createBackgroundThemeStoreActions"),
    hint: "恢复 store/backgroundThemeState.ts 与 store/accentColorState.ts 并装配进 store/index.ts。",
  },

  // ── 自建插件注册红线（2026-11-12 上游同步事故后补）────────────────────────
  // 事故：`2c0fc9dd` 用「上游为基准」整块覆盖时，把 4 个本地自建插件
  // （file-tools / ocr-tools / dwg-tools / review-skills）的注册条目全部删掉。
  // 它们 100% 是 fork 自有，上游 b95ebaff 里根本没有这些目录，却被当成杂质扫掉。
  // 症状：图纸解析 / 扫描件识别 / 文件审查在插件市场和运行期一起消失，
  // 而 tsc、lint、vite build 全都不报错。
  // 判定标准是 3-way：「上游没动、本地动了」= 真定制；
  // **不能**按「上游有没有这个文件」判断，否则每次同步都会再丢一次。
  {
    name: "自建插件在官方插件注册表里（file-tools/ocr-tools/dwg-tools/review-skills）",
    file: "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    test: (s) =>
      s !== null &&
      ["file-tools", "ocr-tools", "dwg-tools", "review-skills"].every((n) =>
        new RegExp(`name:\\s*"${n}"`).test(s),
      ),
    hint:
      "从 dbc38d7d 取回 4 个自建插件的定义块插进 OFFICIAL_PLUGIN_DEFINITIONS。" +
      "它们上游不存在，整包同步会静默删掉；每次同步上游后必须跑本检查。",
  },
  {
    name: "自建内容型插件在官方插件注册表里（accounting/research/analytics/obsidian）",
    file: "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    test: (s) =>
      s !== null &&
      ["accounting-and-reporting", "research", "analytics", "obsidian"].every((n) =>
        new RegExp(`name:\\s*"${n}"`).test(s),
      ),
    hint:
      "从 dbc38d7d 取回 4 个自建内容型插件的 map 定义块插进 OFFICIAL_PLUGIN_DEFINITIONS。" +
      "它们上游不存在，整包同步会静默删掉。" +
      "注意 superpowers 不在此列：上游主动下线了它（改走 UI 推荐区按需安装），别一并塞回内置。",
  },
  {
    name: "自建插件在远端资产合同里（server/remote/zcodeAgentOfficialPluginAssets.ts）",
    file: "packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts",
    test: (s) =>
      s !== null &&
      [
        "file-tools-plugin",
        "ocr-tools-plugin",
        "dwg-tools-plugin",
        "review-skills-plugin",
        "accounting-and-reporting-plugin",
        "analytics-plugin",
        "research-plugin",
        "obsidian-plugin",
      ].every((n) => s.includes(n)),
    hint:
      "补回 REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES 与 REQUIRED_RELATIVE_PATHS 里的自建插件，" +
      "并把 assets 加回 INCLUDED_TOP_LEVEL_PATHS（缺了 seed 会以「声明了 assets 却没文件」整体拒绝）。",
  },
  {
    name: "自建插件在 SEA 资源清单里（cli/scripts/sea-official-plugin-assets.mjs）",
    file: "apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs",
    test: (s) =>
      s !== null &&
      [
        "file-tools",
        "ocr-tools",
        "dwg-tools",
        "review-skills",
        "accounting-and-reporting",
        "research",
        "analytics",
        "obsidian",
      ].every((n) => new RegExp(`name:\\s*"${n}"`).test(s)),
    hint:
      "补回 officialSeaPlugins 里的自建插件条目（file-tools/dwg-tools 带 runtimeTopLevelPaths: [\"assets\"]）。",
  },
  {
    name: "自建插件在桌面打包 stage 清单里（prepare-agent-node-bundle.mjs）",
    file: "packages/desktop/scripts/prepare-agent-node-bundle.mjs",
    test: (s) =>
      s !== null &&
      [
        "file-tools-plugin",
        "ocr-tools-plugin",
        "dwg-tools-plugin",
        "review-skills-plugin",
        "accounting-and-reporting-plugin",
        "analytics-plugin",
        "research-plugin",
        "obsidian-plugin",
      ].every((n) => s.includes(n)),
    hint:
      "补回 officialPluginPackages 里的自建插件，并把 assets 加回 includedOfficialPluginTopLevelPaths。" +
      "上游已把本文件从「展开 CONTENT_PLUGIN_SEED_ENTRIES」改成显式清单，内容型插件也要逐条列出。",
  },
  {
    name: "声明了 assets 的插件必须真收到资产文件（seed 守卫存在）",
    file: "apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts",
    test: (s) => s !== null && s.includes("hasDeclaredAssetsButNoFiles"),
    hint:
      "恢复 hasDeclaredAssetsButNoFiles 与 missingAssetFiles 门禁：声明 runtimeTopLevelPaths 却收不到文件时，" +
      "必须按残缺处理并降级，不能写出「seed 成功但缺引擎」的缓存（症状是运行期报未找到原生资产，且永不自愈）。",
  },
];

let failed = 0;
const lines = [];
for (const inv of INVARIANTS) {
  const content = read(inv.file);
  const ok = content !== null && inv.test(content);
  if (!ok) failed += 1;
  lines.push(`${ok ? "OK  " : "FAIL"} ${inv.name}`);
  if (!ok) {
    lines.push(`      文件: ${inv.file}`);
    lines.push(`      恢复: ${inv.hint}`);
  }
}

console.log(lines.join("\n"));
console.log(`\n${INVARIANTS.length - failed}/${INVARIANTS.length} 项通过`);
if (failed > 0) {
  console.error(`\n有 ${failed} 项定制红线被覆盖，请按上面的提示恢复实现，不要改检查。`);
  process.exit(1);
}
