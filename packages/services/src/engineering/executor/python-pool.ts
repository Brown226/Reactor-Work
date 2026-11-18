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
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

/** worker 脚本：从 stdin 读任务，执行后把结果写到 stdout 的结构化通道。 */
const WORKER_BOOTSTRAP = `
import json, sys, traceback, io, contextlib

def main():
    payload = json.loads(sys.stdin.read() or "{}")
    code = payload.get("code", "")
    namespace = {"__name__": "__main__"}
    out = io.StringIO()
    result = {"ok": False, "stdout": "", "error": ""}
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, "<agent>", "exec"), namespace)
        result["ok"] = True
    except BaseException:
        result["error"] = traceback.format_exc()
    result["stdout"] = out.getvalue()
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()

main()
`;

interface WorkerHandle {
  key: string;
  child: ChildProcessWithoutNullStreams;
  /** 串行化：同一 worker 同时只跑一个任务。 */
  busy: boolean;
}

/**
 * worker 池。按 key 复用，key 通常取会话或工作区标识。
 */
export class PythonWorkerPool {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly options: PythonWorkerOptions;
  private scriptPath?: string;

  constructor(options: PythonWorkerOptions = {}) {
    this.options = options;
  }

  /** 取或创建一个 worker。 */
  private async acquire(key: string): Promise<WorkerHandle> {
    const existing = this.workers.get(key);
    if (existing && existing.child.exitCode === null) return existing;

    const script = await this.ensureScript();
    const interpreter = this.options.interpreter ?? (process.platform === "win32" ? "python" : "python3");
    const child = spawn(interpreter, [script], {
      cwd: this.options.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows 下 detached 让进程形成独立进程组，便于整树回收。
      detached: process.platform !== "win32",
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", ...this.options.env },
    });

    const handle: WorkerHandle = { key, child, busy: false };
    this.workers.set(key, handle);
    return handle;
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
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: PythonRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        handle.child.stdout.removeListener("data", onStdout);
        handle.child.stderr.removeListener("data", onStderr);
        resolve(result);
      };

      const onStdout = (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk.toString("utf8"));
      };
      const onStderr = (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk.toString("utf8"));
      };

      const timer = setTimeout(() => {
        // 超时后重启 worker：进程里可能还挂着阻塞调用，无法安全复用。
        this.killWorker(handle.key);
        finish({
          ok: false,
          stdout: "",
          stderr,
          error: `执行超时（${Math.round(timeoutMs / 1000)} 秒）。已终止该执行通道，下次调用会重启。`,
          durationMs: Date.now() - started,
          key: handle.key,
        });
      }, timeoutMs);

      handle.child.stdout.on("data", onStdout);
      handle.child.stderr.on("data", onStderr);

      handle.child.once("error", (error) => {
        finish(failed(handle.key, `执行通道异常：${messageOf(error)}`));
      });
      handle.child.once("exit", (code, signal) => {
        if (settled) return;
        finish(
          failed(
            handle.key,
            `Python 进程已退出（code=${String(code)}, signal=${String(signal)}）。` +
              (stderr ? `\n${stderr.slice(-2000)}` : ""),
          ),
        );
      });

      const payload = JSON.stringify({ code: request.code });
      handle.child.stdin.write(payload, (error) => {
        if (error) finish(failed(handle.key, `写入执行通道失败：${messageOf(error)}`));
        else handle.child.stdin.end();
      });

      // worker 每次任务后进程退出，所以用 close 事件收结果。
      handle.child.once("close", () => {
        if (settled) return;
        const parsed = parseWorkerOutput(stdout);
        if (!parsed) {
          clearTimeout(timer);
          finish({
            ok: false,
            stdout: "",
            stderr,
            error: stderr
              ? `执行结束但未能解析结果：\n${stderr.slice(-2000)}`
              : "执行结束但未返回结果。",
            durationMs: Date.now() - started,
            key: handle.key,
          });
          return;
        }
        this.workers.delete(handle.key);
        finish({
          ok: parsed.ok,
          stdout: parsed.stdout,
          stderr,
          error: parsed.error,
          durationMs: Date.now() - started,
          key: handle.key,
        });
      });
    });
  }

  /** 终止指定 worker 的整个进程树。 */
  killWorker(key: string): void {
    const handle = this.workers.get(key);
    if (!handle) return;
    this.workers.delete(key);
    try {
      if (handle.child.exitCode === null) {
        handle.child.kill("SIGKILL");
      }
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
    this.killAll();
    if (this.scriptPath) {
      const dir = this.scriptPath.replace(/[\\/]worker\.py$/, "");
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.scriptPath = undefined;
    }
  }
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

/** 解析 worker 输出；失败返回 undefined，不猜。 */
function parseWorkerOutput(raw: string): WorkerPayload | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  // worker 正常只输出一个 JSON；stdout 里混了别的内容时取最后一个能解析的对象。
  const start = text.lastIndexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
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

export { DEFAULT_TIMEOUT_MS, READY_TIMEOUT_MS };
