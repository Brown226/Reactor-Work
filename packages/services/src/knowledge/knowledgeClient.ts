/**
 * 知识库 sidecar 进程管理与 RPC 客户端。
 *
 * 设计与协议见 `docs/未完成-知识库-sidecar-与检索链路-spec-v1.md` §4。
 *
 * 与 `dwg-tools` 的一次性 spawn 不同，这里是**常驻进程**：知识库检索是高频操作
 * （每轮对话可能多次触发），Python 解释器启动 + SQLite 打开约 300-800ms，
 * 一次性 spawn 会显著拖慢对话（spec §4.1）。
 *
 * 生命周期：
 * ```
 * 首次操作时懒启动（不在 app 启动时拉起，避免拖慢冷启动）
 *   → spawn → 等 ready 握手（10s 超时）
 *   → 常驻，NDJSON 请求/响应
 *   → 空闲 5 分钟 → SIGTERM（3s 后 SIGKILL）
 *   → 下次操作重新启动
 * ```
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("knowledge-client");

/** 握手超时：Python 启动 + import 模块，冷启动留足余量。 */
const READY_TIMEOUT_MS = 10_000;
/** 单请求超时：嵌入调用可能较慢（spec §4.2）。 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 空闲多久后退出（spec §4.1）。 */
const IDLE_SHUTDOWN_MS = 5 * 60_000;
/** SIGTERM 后等待多久再 SIGKILL。 */
const KILL_GRACE_MS = 3_000;
/** 单行响应上限：超过说明协议层出问题，直接判定不可用。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface KnowledgeClientOptions {
  /** 知识库数据根目录（`<userData>/knowledge`）。 */
  dataRoot: string;
  /**
   * sidecar 启动命令覆盖。缺省按「内置资产 → 开发态源码」候选链解析。
   * 测试与自定义部署用。
   */
  command?: { executable: string; args: string[] };
}

export interface KnowledgeRpcError {
  code: string;
  message: string;
}

export class KnowledgeRpcCallError extends Error {
  readonly code: string;
  constructor(error: KnowledgeRpcError) {
    super(error.message);
    this.name = "KnowledgeRpcCallError";
    this.code = error.code;
  }
}

/** sidecar 不可用（缺资产 / 启动失败 / 崩溃）。UI 据此提示，不阻塞对话。 */
export class KnowledgeUnavailableError extends Error {
  readonly code = "KNOWLEDGE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeUnavailableError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析 sidecar 启动命令。
 *
 * 候选链（与 `officeEnginesEnv.resolveOfficeEnginesRoot` 同思路）：
 * 显式 env > 安装器内置资产（resources/tools/knowledge-engines）> 平台域 bundled-tools（dev）。
 *
 * Python 解释器与 sidecar 代码都在资产树里：
 * ```
 * knowledge-engines/
 *   python/bin/python3        （或 Windows 的 python/python.exe）
 *   sidecar/knowledge_sidecar/
 * ```
 */
export function resolveKnowledgeSidecarCommand(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = import.meta.dirname,
): { executable: string; args: string[] } | null {
  // 显式覆盖：测试与自定义部署直接指到 python 可执行文件。
  const explicitPython = env.ZCODE_KNOWLEDGE_PYTHON_PATH?.trim();
  const explicitSidecar = env.ZCODE_KNOWLEDGE_SIDECAR_DIR?.trim();
  if (explicitPython && isFile(explicitPython) && explicitSidecar && isDirectory(explicitSidecar)) {
    return {
      executable: explicitPython,
      args: withDataRoot(["-m", "knowledge_sidecar"]),
    };
  }

  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : null;
  const runtimeRoot = env.ZCODE_SERVER_RUNTIME_ROOT?.trim();
  const platformKey = `${process.platform}-${process.arch}`;
  // moduleDir = <repo>/packages/services/dist/knowledge（或 src/knowledge）。
  // 到仓库根要上溯 4 级；到 packages/ 是 2 级。两种都列，兼容 src 与 dist 运行。
  const repoRootFromDist = resolvePath(moduleDir, "..", "..", "..", "..");
  const repoRootFromSrc = resolvePath(moduleDir, "..", "..", "..");
  const roots = [
    runtimeRoot ? resolvePath(runtimeRoot, "tools", "knowledge-engines") : null,
    resourcesPath ? resolvePath(resourcesPath, "tools", "knowledge-engines") : null,
    // 开发态：packages/desktop/bundled-tools/<platform>/knowledge-engines
    ...[...new Set([repoRootFromDist, repoRootFromSrc])].map((repoRoot) =>
      resolvePath(repoRoot, "packages", "desktop", "bundled-tools", platformKey, "knowledge-engines"),
    ),
  ].filter((path): path is string => Boolean(path));

  for (const root of roots) {
    if (!isDirectory(root)) continue;
    const sidecarDir = join(root, "sidecar");
    if (!isDirectory(sidecarDir)) continue;

    let python: string | null = null;
    // 1) 打包态：资产树内自带解释器（Windows embeddable，或将来 Unix 便携版）
    python = [
      join(root, "python", "bin", "python3"),
      join(root, "python", "bin", "python3.exe"),
      join(root, "python", "python3"),
      join(root, "python", "python.exe"),
    ].find((candidate) => isFile(candidate)) ?? null;

    // 2) Unix 打包态：prepare 脚本只写了 interpreter.json（记录系统 python）
    if (!python) {
      python = readInterpreterJson(join(root, "python", "interpreter.json"));
    }

    // 3) 开发态兜底：用 PATH 里的 python3。资产树里的依赖通过 PYTHONPATH 生效，
    //    不要求解释器本身在资产树内。
    if (!python && process.platform !== "win32") {
      python = "python3";
    }

    if (!python) continue;

    // Unix 用系统 python，无法从可执行路径反推资产树，所以把 sidecar 目录显式写进
    // env，resolvePythonPath 才知道去哪找代码与依赖。
    if (!process.env.ZCODE_KNOWLEDGE_SIDECAR_DIR) {
      process.env.ZCODE_KNOWLEDGE_SIDECAR_DIR = sidecarDir;
    }
    return { executable: python, args: withDataRoot(["-m", "knowledge_sidecar"]) };
  }

  return null;
}

/**
 * 拼上 `--data-root`。
 *
 * 早期漏了它：sidecar 的 argparse 把它设为必填，缺了直接 exit 2。而 Node 侧只看到
 * 「引擎退出（code=2）」——一个纯参数缺失被表现成引擎崩溃，白排查很久。
 * 数据根从 `ZCODE_KNOWLEDGE_DATA_ROOT` 取，由 services 装配层注入。
 */
function withDataRoot(args: string[]): string[] {
  const dataRoot = process.env.ZCODE_KNOWLEDGE_DATA_ROOT?.trim();
  if (!dataRoot) return args;
  return [...args, "--data-root", dataRoot];
}

/** 读 prepare 脚本写的 interpreter.json，取系统解释器绝对路径。 */
function readInterpreterJson(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { executable?: unknown };
    return typeof parsed.executable === "string" && parsed.executable
      ? parsed.executable
      : null;
  } catch {
    return null;
  }
}

export class KnowledgeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private idleTimer: NodeJS.Timeout | null = null;
  private starting = false;
  /** 崩溃重启只自动尝试一次，避免无限重启（spec §4.4）。 */
  private restartedAfterCrash = false;

  constructor(private readonly options: KnowledgeClientOptions) {}

  /** 懒启动；已启动则复用。并发调用共享同一个启动 Promise。 */
  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.ready) return this.ready;
    this.ready = this.start();
    try {
      await this.ready;
    } finally {
      // 启动失败后清空，下次调用可重试（如用户刚装好资产）。
      if (!this.child) this.ready = null;
    }
  }

  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      const command = this.options.command ?? resolveKnowledgeSidecarCommand();
      if (!command) {
        throw new KnowledgeUnavailableError(
          "未找到知识库引擎（knowledge-engines 资产缺失）。" +
            "开发态需运行 node scripts/prepare-knowledge-assets.mjs。",
        );
      }

      const child = spawn(command.executable, command.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONPATH: this.resolvePythonPath(command),
          // 无缓冲：否则协议行会滞留在 Python 的 stdout 缓冲区里，Node 侧一直等不到 ready。
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        },
      });
      this.child = child;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // sidecar 日志走 stderr；这里只记录，不参与协议解析。
        for (const line of chunk.split("\n")) {
          if (line.trim()) logger.debug(line);
        }
      });
      child.on("error", (error) => this.failAll(error));
      child.on("exit", (code, signal) => this.onExit(code, signal));

      await this.waitReady();
      this.restartedAfterCrash = false;
      logger.info("knowledge sidecar ready", {
        executable: command.executable,
        dataRoot: this.options.dataRoot,
      });
    } finally {
      this.starting = false;
    }
  }

  /**
   * 组装 sidecar 的 PYTHONPATH。
   *
   * 必须把 sidecar 代码目录与 site-packages 都带上，并且**保留调用方已有的
   * PYTHONPATH**（部署方可能要注入自己的模块）。早期版本直接赋值，把外部传入的
   * 值覆盖掉，症状是「资产明明在、sidecar 却 import 不到」。
   */
  /**
   * 组装 sidecar 的 PYTHONPATH。
   *
   * 必须把 sidecar 代码目录与 site-packages 都带上，并且**保留调用方已有的
   * PYTHONPATH**（部署方可能要注入自己的模块）。早期版本直接赋值，把外部传入的
   * 值覆盖掉，症状是「资产明明在、sidecar 却 import 不到」。
   *
   * 注意：不能从 `command.executable` 反推资产树 —— Unix 平台用的是**系统 python**
   * （见 prepare-knowledge-assets.mjs 的 interpreter.json），`/usr/local/bin/python3`
   * 的 `../../` 是 `/usr/local`，跟资产树毫无关系。所以只信显式 env 与
   * `ZCODE_KNOWLEDGE_SIDECAR_DIR`，以及 Windows 下 embeddable 的固定布局。
   */
  private resolvePythonPath(command: { executable: string }): string {
    const entries: string[] = [];

    // 1) 显式指定的 sidecar 代码目录（资产树探测的产物、测试与自定义部署）
    const explicitSidecar = process.env.ZCODE_KNOWLEDGE_SIDECAR_DIR?.trim();
    if (explicitSidecar) {
      entries.push(explicitSidecar);
      const sitePackages = join(explicitSidecar, "..", "python", "Lib", "site-packages");
      if (isDirectory(sitePackages)) entries.push(sitePackages);
    }

    // 2) Windows embeddable 布局：<root>/python/python.exe → <root>/sidecar
    const pythonDir = resolvePath(command.executable, "..");
    const sidecarBesidePython = join(pythonDir, "..", "sidecar");
    if (isDirectory(sidecarBesidePython)) {
      entries.push(sidecarBesidePython);
      const sitePackages = join(pythonDir, "..", "python", "Lib", "site-packages");
      if (isDirectory(sitePackages)) entries.push(sitePackages);
    }

    // 3) 调用方已有的 PYTHONPATH 放最后：优先用资产树，但不清空外部注入
    const inherited = process.env.PYTHONPATH?.trim();
    if (inherited) entries.push(inherited);

    return entries.join(process.platform === "win32" ? ";" : ":");
  }

  private waitReady(): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        this.readyResolver = null;
        rejectReady(
          new KnowledgeUnavailableError(`知识库引擎启动超时（${READY_TIMEOUT_MS}ms 内无 ready 握手）`),
        );
      }, READY_TIMEOUT_MS);
      this.readyResolver = () => {
        clearTimeout(timer);
        this.readyResolver = null;
        resolveReady();
      };
      this.readyRejecter = (error: Error) => {
        clearTimeout(timer);
        this.readyResolver = null;
        this.readyRejecter = null;
        rejectReady(error);
      };
    });
  }

  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      logger.error("knowledge sidecar 输出超过单行上限，判定不可用");
      this.failAll(new KnowledgeUnavailableError("sidecar 输出异常"));
      this.child?.kill("SIGKILL");
      return;
    }
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      logger.warn("knowledge sidecar 输出无法解析为 JSON", { line: line.slice(0, 200) });
      return;
    }
    if (typeof payload !== "object" || payload === null) return;

    const record = payload as Record<string, unknown>;
    if (record.type === "ready") {
      this.readyResolver?.();
      return;
    }

    const id = typeof record.id === "string" ? record.id : null;
    if (!id) return;
    const pendingRequest = this.pending.get(id);
    if (!pendingRequest) return; // 已超时或已取消
    this.pending.delete(id);
    clearTimeout(pendingRequest.timer);

    if (record.ok === true) {
      pendingRequest.resolve(record.result);
      return;
    }
    const error = (record.error ?? {}) as Partial<KnowledgeRpcError>;
    pendingRequest.reject(
      new KnowledgeRpcCallError({
        code: typeof error.code === "string" ? error.code : "INTERNAL",
        message: typeof error.message === "string" ? error.message : "sidecar 返回未知错误",
      }),
    );
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasRunning = this.child !== null;
    this.child = null;
    this.ready = null;
    const error = new KnowledgeUnavailableError(
      `知识库引擎退出（code=${code ?? "null"} signal=${signal ?? "null"}）`,
    );
    this.failAll(error);
    if (!wasRunning) return;

    // 崩溃自动重启一次；主动 shutdown 不算崩溃（此时 restartedAfterCrash 已被重置逻辑绕过）。
    if (!this.restartedAfterCrash && this.intentionalShutdown !== true) {
      this.restartedAfterCrash = true;
      logger.warn("knowledge sidecar 异常退出，尝试重启一次");
      void this.ensureStarted().catch((restartError: unknown) => {
        logger.error("knowledge sidecar 重启失败", restartError);
      });
    }
  }

  private intentionalShutdown = false;

  private failAll(error: Error): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.readyRejecter?.(error);
  }

  /** 调用 sidecar 方法；失败抛 `KnowledgeRpcCallError` 或 `KnowledgeUnavailableError`。 */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new KnowledgeUnavailableError("知识库引擎不可用");

    this.touchIdle();
    const id = `req-${this.nextId++}`;
    const line = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new KnowledgeUnavailableError(`知识库请求超时（${REQUEST_TIMEOUT_MS}ms）：${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => resolveCall(value as T),
        reject: rejectCall,
        timer,
      });

      child.stdin.write(line, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        rejectCall(new KnowledgeUnavailableError(`写入知识库引擎失败：${error.message}`));
      });
    });
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.shutdown("idle");
    }, IDLE_SHUTDOWN_MS);
    // 空闲计时器不应该阻止进程退出。
    this.idleTimer.unref?.();
  }

  /** 主动关闭（app 退出时调用；空闲超时也会走这里）。 */
  async shutdown(reason: "idle" | "dispose" = "dispose"): Promise<void> {
    this.intentionalShutdown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = null;
    this.failAll(new KnowledgeUnavailableError("知识库引擎已关闭"));

    await new Promise<void>((resolveShutdown) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveShutdown();
      }, KILL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolveShutdown();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
    logger.info("knowledge sidecar shutdown", { reason });
    this.intentionalShutdown = false;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /** 仅测试用：暴露给单测判断数据目录是否就绪。 */
  get dataRootExists(): boolean {
    return existsSync(this.options.dataRoot);
  }
}
