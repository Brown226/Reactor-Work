import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { quoteArgsForWindowsShell } from "./spawn-command.mjs";
import {
  computeAgentBuildStamp,
  isAgentBuildUpToDate,
  resolveAgentBuildStampFile,
  writeAgentBuildStamp,
} from "./agent-build-stamp.mjs";

const requestedEnv = process.argv[2]?.trim().toLowerCase();
const extraArgs = process.argv.slice(3);
const agentBytecode = extraArgs.includes("--agent-bytecode");
// --reuse/--fast：源码没变就复用上一次的 agent 产物，并且不清空 out/（tsup 增量）。
// 默认（不带 flag）仍是全量重建，保证 CI 与"改了 agent 代码"的语义不被悄悄改变。
const reuseAgentBuild = extraArgs.includes("--reuse") || extraArgs.includes("--fast");
const forceAgentBuild = extraArgs.includes("--force-agent-build");
if (requestedEnv !== "test" && requestedEnv !== "production") {
  console.error(
    "Usage: node scripts/dev-desktop-env.mjs <test|production> [--agent-bytecode] [--reuse] [--force-agent-build]",
  );
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    // Windows 下 shell:true 只按空格拼接参数；仓库路径含空格（如 E:\Z Code\...）时
    // node <script> 的脚本路径会被 cmd 截断成 E:\Z 并报 Cannot find module，因此先补引号。
    const spawnArgs = process.platform === "win32" ? quoteArgsForWindowsShell(args) : args;
    const child = spawn(command, spawnArgs, {
      cwd: repoRoot,
      env: withPinnedNodePath(
        {
          ...process.env,
          ZCODE_ENV: requestedEnv,
          ZCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
        },
        process.execPath,
      ),
      stdio: "inherit",
      // Windows .cmd/.bat executables (pnpm.cmd, npm.cmd, etc.) require shell: true
      shell: process.platform === "win32",
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

try {
  // The public dev scripts delegate here instead of invoking the package's
  // `dev` lifecycle directly, so pnpm will not run `pre-dev` automatically.
  // Preserve its runtime-asset preparation and stale `out` cleanup explicitly
  // before rebuilding bundles or starting Electron.
  // --reuse 时换成 pre-dev:reuse：仍准备运行时资产，但保留 out/，让 tsup watch 走增量。
  await run(pnpmCommand, [
    "--filter",
    "@zcode/desktop",
    reuseAgentBuild ? "pre-dev:reuse" : "pre-dev",
  ]);
  const stampFile = resolveAgentBuildStampFile(repoRoot);
  const agentState = reuseAgentBuild
    ? isAgentBuildUpToDate(repoRoot, stampFile)
    : { upToDate: false, reason: "未启用 --reuse" };
  if (agentState.upToDate) {
    console.log(
      `[dev] 复用上一次 agent 构建（${agentState.reason}）。改了 agent 代码却想强制重建：去掉 --reuse 或加 --force-agent-build。`,
    );
  } else {
    if (reuseAgentBuild) {
      console.log(`[dev] agent 需要重建：${agentState.reason}`);
    }
    // On Windows, use "node" (resolved via PATHEXT) to avoid "C:\Program Files\..." space issues
    await run(process.platform === "win32" ? "node" : process.execPath, [
      resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs"),
    ]);
    if (reuseAgentBuild) {
      // 只在构建成功后才写指纹：失败时旧指纹若已被覆盖，下一次会误判为"未变化"。
      writeAgentBuildStamp(stampFile, computeAgentBuildStamp(repoRoot));
    }
  }
  if (agentBytecode) {
    await run(process.platform === "win32" ? "node" : process.execPath, [
      resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs"),
    ]);
  }
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "dev:runtime"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
