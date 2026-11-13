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
