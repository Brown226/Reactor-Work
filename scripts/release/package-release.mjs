#!/usr/bin/env node
/**
 * 交付打包统一入口。
 *
 * 用法：
 *   node scripts/release/package-release.mjs <target> [更多 target...] [选项]
 *
 * target：
 *   desktop   桌面端 Windows x64 安装包（唯一受支持的桌面平台）
 *   web       Web 端镜像 reactor-web:v<version>
 *   server    服务端镜像 reactor-desktop-server:local + openldap + pgvector
 *   portal    产品门户镜像 reactor-portal:v<version>
 *   all       以上全部
 *
 * 选项：
 *   --out <dir>        交付目录（默认 E:\工作\Reactor-版本更新\V<version>，
 *                      也可用环境变量 REACTOR_DELIVERY_ROOT）
 *   --version <v>      覆盖版本号（默认取仓库根 package.json）
 *   --reuse-assets     复用已有 Web 能力资产（bundled-tools），不重新下载
 *   --skip-build       跳过构建，只重新导出（仅 web/server/portal 有意义）
 *   --verify           结束后校验交付包 MANIFEST 全量
 *   --dry-run          只打印将要执行的步骤
 *
 * 例子：
 *   node scripts/release/package-release.mjs portal --verify
 *   node scripts/release/package-release.mjs web --reuse-assets
 *   node scripts/release/package-release.mjs desktop web --out "E:\工作\Reactor-版本更新\V1.1.1"
 *
 * 设计约束（都是踩过的坑，见 docs/交付打包流程.md）：
 * - 打包路径**不允许**卡在模型调用上：截图要静态拿，拿不到就留占位；
 * - 内容批量改完再一次性 build/save，别改一次建一次；
 * - save 之后不做冗余 `docker load` 验证，MANIFEST + sha256 才是门禁。
 */
import { formatDuration } from "./lib/exec.mjs";
import { deliveryRoot as resolveDeliveryRoot, repoVersion } from "./lib/context.mjs";
import { verifyManifest } from "./lib/manifest.mjs";
import { packageDesktop } from "./targets/desktop.mjs";
import { packageWeb } from "./targets/web.mjs";
import { packageServer } from "./targets/server.mjs";
import { packagePortal } from "./targets/portal.mjs";

const TARGETS = {
  desktop: packageDesktop,
  web: packageWeb,
  server: packageServer,
  portal: packagePortal,
};

function parseArgs(argv) {
  const options = { targets: [], out: "", version: "", reuseAssets: false, skipBuild: false, verify: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.out = argv[++index] ?? "";
    } else if (arg === "--version") {
      options.version = argv[++index] ?? "";
    } else if (arg === "--reuse-assets") {
      options.reuseAssets = true;
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--verify") {
      options.verify = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`未知选项：${arg}`);
    } else {
      options.targets.push(arg);
    }
  }
  if (options.targets.includes("all")) {
    options.targets = ["desktop", "web", "server", "portal"];
  }
  for (const target of options.targets) {
    if (!TARGETS[target]) {
      throw new Error(`未知 target：${target}（可选 ${Object.keys(TARGETS).join(" / ")} / all）`);
    }
  }
  return options;
}

function printUsage() {
  console.log(
    [
      "用法：node scripts/release/package-release.mjs <target> [选项]",
      "",
      "target: desktop | web | server | portal | all",
      "选项：",
      "  --out <dir>     交付目录（默认 E:\\工作\\Reactor-版本更新\\V<version>）",
      "  --version <v>   覆盖版本号（默认取仓库根 package.json）",
      "  --reuse-assets  复用 Web 能力资产，不重新下载 bundled-tools",
      "  --skip-build    跳过构建，只重新导出",
      "  --verify        结束后校验 MANIFEST 全量",
      "  --dry-run       只打印步骤",
    ].join("\n"),
  );
}

const options = parseArgs(process.argv.slice(2));
if (options.help || options.targets.length === 0) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

const version = options.version.trim() || repoVersion();
const delivery = resolveDeliveryRoot(version, options.out);

console.log("══════════════════════════════════════════════");
console.log(" Reactor 交付打包");
console.log(` 版本      ${version}`);
console.log(` 交付目录  ${delivery}`);
console.log(` 目标      ${options.targets.join(", ")}`);
console.log("══════════════════════════════════════════════");

if (options.dryRun) {
  for (const target of options.targets) {
    console.log(`· ${target}`);
  }
  process.exit(0);
}

const startedAt = Date.now();
const produced = [];
for (const target of options.targets) {
  const files = await TARGETS[target]({
    version,
    deliveryRoot: delivery,
    reuseAssets: options.reuseAssets,
    skipBuild: options.skipBuild,
  });
  produced.push(...files);
}

console.log("\n══════════════════════════════════════════════");
console.log(` 打包完成，耗时 ${formatDuration(Date.now() - startedAt)}`);
console.log(` 交付目录：${delivery}`);
for (const file of produced) console.log(`   · ${file}`);

if (options.verify) {
  const { checked, failures } = await verifyManifest(delivery);
  if (failures.length > 0) {
    console.error(`\n✗ MANIFEST 校验失败（${failures.length} 项）：`);
    for (const failure of failures) console.error(`   - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ MANIFEST 校验通过（${checked} 项）`);
  }
}

console.log(
  [
    "",
    "⚠ 打包脚本只覆盖镜像与桌面安装包。下列文件是人工维护的，请自行确认是否需要同步：",
    "   server/compose.yml、server/.env、server/load-and-up.sh、server/部署说明.md",
    "   web/compose.yml、web/.env、web/load-and-up.sh、web/部署说明.md",
    "   docs/更新说明-*.md、README.md",
  ].join("\n"),
);
