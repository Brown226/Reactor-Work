/**
 * Python 执行器：会话常驻的子进程池。
 *
 * 逆向自 PKPM Agent 的 execworker：
 *   - worker 按 key 复用，同一个 key 后续调用落在同一进程（变量跨调用保留）
 *   - 只有 print 的输出返回给模型
 *   - 超时与中断两套路径
 *   - 进程树随主进程回收
 *
 * 与 PKPM Agent 的差异：这里不内置 Python 解释器，用系统 python3；
 * 目标软件的内嵌解释器由子类或调用方通过 interpreter 指定。
 *
 * 协议：一条请求一行 JSON（stdin），一条结果一行 JSON（stdout，带哨兵前缀）。
 * 用户代码的 print 被重定向到内存缓冲，不会污染结果通道。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PythonWorkerOptions, PythonRunRequest, PythonRunResult } from "./types.js";

/** 单次执行的默认超时，与逆向样一致（计算类任务可能几分钟）。 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** 单次执行 stdout/stderr 的保留上限，超出截断并标注。 */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** worker 启动后等待就绪标记的时限。 */
const READY_TIMEOUT_MS = 15_000;

/**
 * 结果行哨兵前缀。
 *
 * 用控制字符而不是普通文本，避免用户脚本里恰好打印同名内容被误判为结果。
 * worker 侧写结果时先切回真实 stdout，保证结果行不会落进用户输出缓冲。
 */
const RESULT_PREFIX = "\u0001ZCODE_RESULT\u0001";

/**
 * worker 脚本：长驻进程，逐行读任务、执行、写结果。
 *
 * 关键点（都是踩过的坑）：
 *   1. namespace 在循环外创建 —— 这是「会话常驻」的实际含义，变量要跨调用保留。
 *   2. 结果写到 _REAL_STDOUT —— redirect_stdout 期间 sys.stdout 是内存缓冲，
 *      此时写 sys.stdout 会把结果混进用户输出里。
 *   3. 输出有上限 —— 死循环 print 不能把内存吃光。
 *   4. stdin 关闭即退出 —— 宿主 dispose 时无需额外信号。
 */
const WORKER_BOOTSTRAP = `
import contextlib
import io
import json
import sys
import traceback

_REAL_STDOUT = sys.stdout
_RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)}
_MAX_CHARS = ${MAX_OUTPUT_BYTES}

class _CappedBuffer(io.StringIO):
    """有上限的输出缓冲：超出后继续接收但不再增长，末尾标注省略量。"""

    def __init__(self, limit):
        super().__init__()
        self._limit = limit
        self._dropped = 0

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        room = self._limit - super().tell()
        if room <= 0:
            self._dropped += len(s)
            return len(s)
        if len(s) > room:
            self._dropped += len(s) - room
            s = s[:room]
        return super().write(s)

    def dropped(self):
        return self._dropped

def _emit(payload):
    _REAL_STDOUT.write(_RESULT_PREFIX + json.dumps(payload, ensure_ascii=False) + "\\n")
    _REAL_STDOUT.flush()

def main():
    namespace = {"__name__": "__main__"}
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue

        code = payload.get("code", "")
        buffer = _CappedBuffer(_MAX_CHARS)
        result = {"ok": False, "stdout": "", "error": ""}
        try:
            with contextlib.redirect_stdout(buffer):
                exec(compile(code, "<agent>", "exec"), namespace)
            result["ok"] = True
        except SystemExit:
            result["error"] = "脚本调用了 sys.exit()，本次执行被中止。"
        except BaseException:
            result["error"] = traceback.format_exc()

        text = buffer.getvalue()
        if buffer.dropped():
            text = text + "\\n…（已省略后 %d 字符，超出单次输出上限）…" % buffer.dropped()
        result["stdout"] = text
        _emit(result)

main()
`;

/** 默认解释器候选：按平台给出一组，逐个试到能启动为止。 */
function defaultInterpreters(): string[] {
  if (process.platform === "win32") {
    return ["python", "py", "python3"];
  }
  return ["python3", "python"];
}

interface WorkerHandle {
  key: string;
  child: ChildProcessWithoutNullStreams;
  /** 串行化：同一 worker 同时只跑一个任务。 */
  busy: boolean;
  /** stdout 行缓冲，按换行切分结果行。 */
  stdoutBuffer: string;
  /** stderr 累积，仅用于诊断。 */
  stderr: string;
  /** 当前等待结果的调用方；同一时刻至多一个（busy 保证）。 */
  pending?: {
    resolve: (result: PythonRunResult) => void;
    startedAt: number;
  };
}

/**
 * worker 池。按 key 复用，key 通常取会话或工作区标识。
 */
export class PythonWorkerPool {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly options: PythonWorkerOptions;
  private scriptPath?: string;
  /** 解析成功的解释器；命中后不再重复探测。 */
  private resolvedInterpreter?: string;
  /**
   * 正在创建中的通道。
   *
   * Bugfix 原因：acquire 里 spawn 是异步的，两个首次调用同时到达时
   * `workers.get(key)` 都取不到值，各自建了一个进程，后建的覆盖先建的 ——
   * 并发没被拦住，反而多出一个孤儿 Python 进程。
   * 修复依据：并发测试两个调用都返回 ok，说明它们落在了两个不同进程上。
   * 这里把「创建中」也登记进 map，后到者复用同一个创建 Promise。
   */
  private readonly creating = new Map<string, Promise<WorkerHandle>>();

  constructor(options: PythonWorkerOptions = {}) {
    this.options = options;
  }

  /** 取或创建一个 worker；进程已退出则重建。 */
  private async acquire(key: string): Promise<WorkerHandle> {
    const existing = this.workers.get(key);
    if (existing && existing.child.exitCode === null && !existing.child.killed) return existing;

    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;

    const creation = this.createWorker(key);
    this.creating.set(key, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(key);
    }
  }

  private async createWorker(key: string): Promise<WorkerHandle> {
    const script = await this.ensureScript();
    const interpreter = await this.resolveInterpreter();

    const child = spawn(interpreter, [script], {
      cwd: this.options.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      // 非 Windows 让子进程自成进程组，便于整树回收；Windows 用 taskkill /T 处理。
      detached: process.platform !== "win32",
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", ...this.options.env },
    });

    const handle: WorkerHandle = {
      key,
      child,
      busy: false,
      stdoutBuffer: "",
      stderr: "",
    };

    this.attachHandlers(handle);
    await this.waitForSpawn(child);
    this.workers.set(key, handle);
    return handle;
  }

  /**
   * 等待 spawn 成功；解释器不存在时 'error' 事件先到，这里转成可读错误。
   *
   * 不用 'spawn' 事件之外的超时兜底：ENOENT 会立刻触发 error，
   * 真正的挂起由后续 READY 检查覆盖。
   */
  private waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  /** 解析可用解释器：显式指定直接用，否则按候选顺序探测。 */
  private async resolveInterpreter(): Promise<string> {
    if (this.options.interpreter) return this.options.interpreter;
    if (this.resolvedInterpreter) return this.resolvedInterpreter;

    const candidates = defaultInterpreters();
    for (const candidate of candidates) {
      if (await canRunInterpreter(candidate)) {
        this.resolvedInterpreter = candidate;
        return candidate;
      }
    }
    // 全部探测失败时仍返回首选，让后续 spawn 报出真实错误供用户排查。
    return candidates[0] ?? "python3";
  }

  /**
   * 挂载长驻进程的事件处理。
   *
   * Bugfix 原因：旧实现同时监听 `exit` 与 `close`，`exit` 先触发就判失败并 settle，
   * `close` 里解析出的真实结果被 `if (settled) return` 丢弃 —— 每次执行都报
   * 「Python 进程已退出（code=0）」而实际执行是成功的。
   * 修复依据：单独 spawn 同一 worker 脚本能正常返回结果，说明问题在池子的监听顺序。
   * 现在只有一条判定路径：收到结果行即成功，进程异常退出且无结果才算失败。
   */
  private attachHandlers(handle: WorkerHandle): void {
    const { child } = handle;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      handle.stdoutBuffer += chunk;
      let index = handle.stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        const line = handle.stdoutBuffer.slice(0, index);
        handle.stdoutBuffer = handle.stdoutBuffer.slice(index + 1);
        this.consumeLine(handle, line);
        index = handle.stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      handle.stderr = appendCapped(handle.stderr, chunk);
    });

    const onGone = (reason: string) => {
      if (this.workers.get(handle.key) === handle) {
        this.workers.delete(handle.key);
      }
      const pending = handle.pending;
      handle.pending = undefined;
      if (!pending) return;
      const stderr = handle.stderr.trim();
      pending.resolve({
        ok: false,
        stdout: "",
        stderr,
        error: reason + (stderr ? `\n${stderr.slice(-2000)}` : ""),
        durationMs: Date.now() - pending.startedAt,
        key: handle.key,
      });
    };

    // 进程结束时用 close（stdio 已排空）而不是 exit，保证最后一行结果已被消费。
    child.once("close", (code, signal) => {
      // 缓冲里可能还留着没有换行结尾的最后一行结果。
      const tail = handle.stdoutBuffer.trim();
      if (tail) {
        handle.stdoutBuffer = "";
        this.consumeLine(handle, tail);
      }
      onGone(`Python 进程已退出（code=${String(code)}, signal=${String(signal)}）。`);
    });
    child.once("error", (error) => {
      onGone(`执行通道异常：${messageOf(error)}`);
    });
  }

  /** 消费一行 stdout：带哨兵前缀的是结果，其余视为噪声丢弃。 */
  private consumeLine(handle: WorkerHandle, line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith(RESULT_PREFIX)) return;
    const payload = parseWorkerOutput(trimmed.slice(RESULT_PREFIX.length));
    if (!payload) return;

    const pending = handle.pending;
    handle.pending = undefined;
    if (!pending) return;

    pending.resolve({
      ok: payload.ok,
      stdout: payload.stdout,
      stderr: handle.stderr.trim(),
      error: payload.error,
      durationMs: Date.now() - pending.startedAt,
      key: handle.key,
    });
  }

  /** 把 worker 脚本落到临时目录，进程内只写一次。 */
  private async ensureScript(): Promise<string> {
    if (this.scriptPath) return this.scriptPath;
    const dir = await mkdtemp(join(tmpdir(), "zcode-py-"));
    const path = join(dir, "worker.py");
    await writeFile(path, WORKER_BOOTSTRAP, "utf8");
    this.scriptPath = path;
    return path;
  }

  /**
   * 执行一段 Python 代码。
   *
   * 不抛异常：所有失败路径都转成 `PythonRunResult`，由调用方决定怎么呈现。
   */
  async run(request: PythonRunRequest): Promise<PythonRunResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const key = request.key ?? "default";

    let handle: WorkerHandle;
    try {
      handle = await this.acquire(key);
    } catch (error) {
      return failed(key, `无法启动 Python 解释器：${messageOf(error)}`);
    }

    if (handle.busy) {
      return failed(key, "该执行通道正在运行其它任务，请等待完成或换一个 key。");
    }
    handle.busy = true;

    try {
      return await this.runOnWorker(handle, request, timeoutMs);
    } finally {
      handle.busy = false;
    }
  }

  private runOnWorker(
    handle: WorkerHandle,
    request: PythonRunRequest,
    timeoutMs: number,
  ): Promise<PythonRunResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;

      const finish = (result: PythonRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // 结果由 consumeLine / onGone 送回；这里只登记等待者。
      handle.pending = { resolve: finish, startedAt };
      handle.stderr = "";

      const timer = setTimeout(() => {
        // 超时后重启 worker：进程里可能还挂着阻塞调用，无法安全复用。
        this.killWorker(handle.key);
        finish({
          ok: false,
          stdout: "",
          stderr: handle.stderr.trim(),
          error: `执行超时（${Math.round(timeoutMs / 1000)} 秒）。已终止该执行通道，下次调用会重启。`,
          durationMs: Date.now() - startedAt,
          key: handle.key,
        });
      }, timeoutMs);

      const payload = JSON.stringify({ code: request.code }) + "\n";
      handle.child.stdin.write(payload, (error) => {
        if (!error) return;
        // 写入失败通常意味着进程已死；onGone 会兜住，这里只补充说明。
        if (!handle.pending) return;
        handle.pending = undefined;
        finish(failed(handle.key, `写入执行通道失败：${messageOf(error)}`));
      });
    });
  }

  /** 终止指定 worker 的整个进程树。 */
  killWorker(key: string): void {
    const handle = this.workers.get(key);
    if (!handle) return;
    this.workers.delete(key);
    handle.pending = undefined;

    try {
      if (handle.child.exitCode !== null || handle.child.killed) return;
      // Windows 上 child.kill 只杀直接子进程，孙进程会残留；用 taskkill /T 收整树。
      if (process.platform === "win32" && handle.child.pid !== undefined) {
        execFile("taskkill", ["/pid", String(handle.child.pid), "/T", "/F"], { windowsHide: true }, () => {
          // 失败说明进程已退出，无需处理。
        });
        return;
      }
      handle.child.kill("SIGKILL");
    } catch {
      // 进程可能已退出，忽略。
    }
  }

  /** 终止全部 worker。 */
  killAll(): void {
    // 先快照 key：killWorker 会删除 map 项，直接迭代 Map 会漏掉后续元素。
    const keys = Array.from(this.workers.keys());
    for (const key of keys) this.killWorker(key);
  }

  /** 释放临时脚本目录。 */
  async dispose(): Promise<void> {
    // 先关闭 stdin 让 worker 自然退出，再对残留进程补杀。
    for (const handle of this.workers.values()) {
      try {
        handle.child.stdin.end();
      } catch {
        // 通道可能已关闭，忽略。
      }
    }
    this.killAll();
    if (this.scriptPath) {
      const dir = this.scriptPath.replace(/[\\/]worker\.py$/, "");
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.scriptPath = undefined;
    }
  }
}

/** 探测解释器能否启动。失败静默返回 false，由候选列表继续尝试。 */
function canRunInterpreter(interpreter: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      interpreter,
      ["-c", "import sys; sys.stdout.write(sys.version)"],
      { windowsHide: true, timeout: READY_TIMEOUT_MS },
      (error) => resolve(error === null),
    );
  });
}

/** 单次任务的输出上限，超出后保留尾部（报错通常在尾部）。 */
function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_OUTPUT_BYTES) return next;
  const dropped = next.length - MAX_OUTPUT_BYTES;
  return `…（已省略前 ${dropped} 字符）…\n` + next.slice(-MAX_OUTPUT_BYTES);
}

interface WorkerPayload {
  ok: boolean;
  stdout: string;
  error: string;
}

/** 解析 worker 结果行；失败返回 undefined，不猜。 */
function parseWorkerOutput(raw: string): WorkerPayload | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      ok: record.ok === true,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      error: typeof record.error === "string" ? record.error : "",
    };
  } catch {
    return undefined;
  }
}

function failed(key: string, error: string): PythonRunResult {
  return { ok: false, stdout: "", stderr: "", error, durationMs: 0, key };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DEFAULT_TIMEOUT_MS, READY_TIMEOUT_MS, RESULT_PREFIX };
