/**
 * 跨平台命令执行封装：统一输出、计时与失败语义。
 *
 * 打包脚本要在 Windows（Git Bash）与 Linux 上都能跑，因此不用 shell 拼接，
 * 一律走 spawn + 参数数组。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Windows 上 `pnpm` 是 pnpm.cmd 批处理，Node 不能直接 spawn（会 ENOENT/EINVAL）。
 * 这里解析出 pnpm 的真实 JS 入口，改用 node 执行——不依赖 shell，也不受参数转义影响。
 */
let pnpmInvocationCache;

function resolvePnpmInvocation() {
  if (pnpmInvocationCache !== undefined) return pnpmInvocationCache;
  if (process.platform === "win32") {
    const candidates = [];
    if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
    for (const dir of (process.env.PATH ?? "").split(";").filter(Boolean)) {
      candidates.push(join(dir, "node_modules", "pnpm", "bin", "pnpm.mjs"));
      candidates.push(join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs"));
    }
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        pnpmInvocationCache = { command: process.execPath, prefix: [candidate] };
        return pnpmInvocationCache;
      }
    }
  }
  pnpmInvocationCache = { command: "pnpm", prefix: [] };
  return pnpmInvocationCache;
}

/** 把命令与参数解析成可直接 spawn 的形式。 */
function resolveInvocation(command, args) {
  if (command !== "pnpm") return { command, args };
  const { command: realCommand, prefix } = resolvePnpmInvocation();
  return { command: realCommand, args: [...prefix, ...args] };
}

/** 人类可读的耗时格式：1m12s / 3.4s。 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/**
 * 同步执行一条命令。默认继承 stdio（打包过程需要实时看到 electron-builder 日志）。
 * 失败时抛错，调用方不需要再判断退出码。
 */
export function run(command, args, options = {}) {
  const { cwd, env, label, quiet = false } = options;
  const title = label ?? `${command} ${args.join(" ")}`;
  const startedAt = Date.now();
  if (!quiet) console.log(`\n▶ ${title}`);
  const invocation = resolveInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    encoding: "utf8",
  });
  const duration = formatDuration(Date.now() - startedAt);
  if (result.error) throw new Error(`${title} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    if (quiet) {
      const stderr = (result.stderr ?? "").trim().split("\n").slice(-20).join("\n");
      const stdout = (result.stdout ?? "").trim().split("\n").slice(-10).join("\n");
      if (stderr) console.error(stderr);
      if (stdout) console.error(stdout);
    }
    throw new Error(`${title} 失败（退出码 ${result.status}，耗时 ${duration}）`);
  }
  if (!quiet) console.log(`✔ ${title}（${duration}）`);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", durationMs: Date.now() - startedAt };
}

/** 异步执行（用于 docker save 的大输出流）。 */
export function runAsync(command, args, options = {}) {
  const { cwd, env, label } = options;
  const title = label ?? `${command} ${args.join(" ")}`;
  const startedAt = Date.now();
  console.log(`\n▶ ${title}`);
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = resolveInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const duration = formatDuration(Date.now() - startedAt);
      if (code !== 0) {
        rejectPromise(new Error(`${title} 失败（退出码 ${code}）\n${stderr.slice(-2000)}`));
        return;
      }
      console.log(`✔ ${title}（${duration}）`);
      resolvePromise({ stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}
