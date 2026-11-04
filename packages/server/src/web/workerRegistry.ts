import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  getWebDataRoot,
  getWebHomesRoot,
  getWebUsersRoot,
  prepareWebUserSandbox,
} from "@zcode/services/node";
import type { ReactorServerStatus } from "@zcode/services";

const DEFAULT_IDLE_STOP_MS = 30 * 60 * 1000;
const WORKER_READY_TIMEOUT_MS = 45_000;
const STDERR_TAIL_LINES = 40;

export interface WebWorkerHandle {
  readonly uid: string;
  readonly port: number;
  readonly token: string;
  readonly child: ChildProcess;
  activeConnections: number;
  lastUsedAt: number;
}

export interface WebWorkerRegistry {
  ensure(uid: string): Promise<WebWorkerHandle>;
  get(uid: string): WebWorkerHandle | undefined;
  login(uid: string, username: string, password: string): Promise<ReactorServerStatus>;
  status(uid: string): Promise<WorkerSessionIdentity>;
  logout(uid: string): Promise<void>;
  stop(uid: string): Promise<void>;
  stopAll(): Promise<void>;
  markConnectionOpened(uid: string): void;
  markConnectionClosed(uid: string): void;
}

export interface WorkerSessionIdentity {
  loggedIn: boolean;
  uid: string | null;
}

export interface WebWorkerRegistryOptions {
  identityUrl?: string | null;
  entryPath?: string;
  idleStopMs?: number;
  now?: () => number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export class WebWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebWorkerError";
  }
}

interface WorkerEntry {
  handle: WebWorkerHandle;
  ready: Promise<WebWorkerHandle>;
  stderrTail: string[];
}

function resolveWorkerEntryPath(): string {
  const configured = process.env.ZCODE_WEB_WORKER_ENTRY?.trim();
  if (configured) return configured;
  // 生产镜像通过 node /app/server-dist/entry-http.js 启动；dev 通过 dist/entry-http.js。
  // 直接复用当前入口，避免 import.meta.url 在 bundle 与源码运行态下解析出不同目录。
  const currentEntry = process.argv[1]?.trim();
  if (currentEntry && existsSync(currentEntry)) return currentEntry;
  return fileURLToPath(new URL("./entry-http.js", import.meta.url));
}

function resolveIdleStopMs(): number {
  const raw = process.env.REACTOR_WEB_WORKER_IDLE_STOP_MS?.trim();
  if (!raw) return DEFAULT_IDLE_STOP_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_STOP_MS;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new WebWorkerError("无法分配 worker 端口"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function buildWorkerEnv(
  uid: string,
  port: number,
  token: string,
  sandboxHome: string,
  sandboxTmp: string,
  identityUrl?: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    ZCODE_SERVER_HOST: "127.0.0.1",
    ZCODE_SERVER_AUTH_TOKEN: token,
    ZCODE_WEB_WORKER: "1",
    // 2026-11-03：worker 是单用户执行面，不能继承网关的会话模式。
    // 变量名必须是 REACTOR_WEB_SESSION_AUTH（entry-http 读的就是它）；此前误写成
    // ZCODE_WEB_SESSION_AUTH，worker 继承 =1 后会以“网关”身份创建会话库，
    // 以 uid 20000 去 mkdir /data/.reactor/web-sessions 直接 EACCES，登录 502。
    REACTOR_WEB_SESSION_AUTH: "0",
    ZCODE_WEB_USER_SANDBOX: "0",
    HOME: sandboxHome,
    TMPDIR: sandboxTmp,
    TMP: sandboxTmp,
    XDG_CONFIG_HOME: join(sandboxHome, ".config"),
    XDG_CACHE_HOME: join(sandboxHome, ".cache"),
    ZCODE_DATA_BASE_DIR: sandboxHome,
    // worker home 本身已经按 uid 隔离，不需要再切 `users/<scope>` 子目录；
    // 固定 local 还能避免「登录写 marker → worker 重启后任务库搬到 scoped 路径」的撕裂。
    ZCODE_DATA_SCOPE: "local",
    // 运维台（REACTOR_WEB_PRIVILEGED=1）：worker 直接以宿主根为工作区（/host）。
    // 普通 Web 容器保持每 uid 独立工作区。
    ZCODE_SERVER_WORKSPACE:
      process.env.REACTOR_WEB_PRIVILEGED === "1"
        ? process.env.ZCODE_SERVER_WORKSPACE?.trim() || "/"
        : join(getWebUsersRoot(), uid),
    REACTOR_WEB_WORKSPACE_ROOT: getWebUsersRoot(),
    REACTOR_WEB_USERS_ROOT: getWebUsersRoot(),
    REACTOR_WEB_HOMES_ROOT: getWebHomesRoot(),
    REACTOR_WEB_DATA_ROOT: getWebDataRoot(),
    USER: `reactor-${uid}`,
    LOGNAME: `reactor-${uid}`,
    ...(identityUrl ? { REACTOR_IDENTITY_URL: identityUrl } : {}),
  };
  // worker 不需要静态站点、共享令牌或网关会话库。
  delete env.ZCODE_WEB_STATIC_ROOT;
  delete env.REACTOR_WEB_TOKEN;
  delete env.REACTOR_WEB_SESSION_DB;
  return env;
}

async function fetchWorker(
  handle: WebWorkerHandle,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}${pathname}?token=${encodeURIComponent(handle.token)}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
}

async function waitForWorkerReady(handle: WebWorkerHandle, entry: WorkerEntry): Promise<void> {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      const tail = entry.stderrTail.join("\n");
      throw new WebWorkerError(
        `worker(${handle.uid}) 启动失败${tail ? `：\n${tail}` : ""}`,
      );
    }
    try {
      const response = await fetchWorker(handle, "/api/server-info", {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // 端口尚未监听：继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new WebWorkerError(
    `worker(${handle.uid}) 在 ${WORKER_READY_TIMEOUT_MS}ms 内未就绪`,
  );
}

export function createWebWorkerRegistry(
  options: WebWorkerRegistryOptions = {},
): WebWorkerRegistry {
  if (process.platform !== "linux") {
    return {
      async ensure() {
        throw new WebWorkerError("Web 多用户会话仅支持 Linux");
      },
      get() {
        return undefined;
      },
      async login() {
        throw new WebWorkerError("Web 多用户会话仅支持 Linux");
      },
      async status() {
        throw new WebWorkerError("Web 多用户会话仅支持 Linux");
      },
      async logout() {},
      async stop() {},
      async stopAll() {},
      markConnectionOpened() {},
      markConnectionClosed() {},
    };
  }

  const now = options.now ?? Date.now;
  const idleStopMs = options.idleStopMs ?? resolveIdleStopMs();
  const log =
    options.log ??
    ((message: string, details?: Record<string, unknown>) => {
      console.log(`[zcode-server:web-worker] ${message}`, details ?? "");
    });
  const entryPath = options.entryPath ?? resolveWorkerEntryPath();
  const workers = new Map<string, WorkerEntry>();
  const starting = new Map<string, Promise<WebWorkerHandle>>();

  async function spawnWorker(uid: string): Promise<WorkerEntry> {
    // 运维台（REACTOR_WEB_PRIVILEGED=1）：worker 以容器 root 运行、不降权，
    // 工作区直接是宿主根（/host，见 deploy/ops）。仅独立的 reactor-ops 容器开启，
    // 普通 Web 容器永远走下面的每用户沙箱分支。
    const privileged = process.env.REACTOR_WEB_PRIVILEGED === "1";
    const workspace = privileged
      ? process.env.ZCODE_SERVER_WORKSPACE?.trim() || "/"
      : join(getWebUsersRoot(), uid);
    const sandbox = privileged
      ? null
      : prepareWebUserSandbox(workspace, { copyProviderConfig: false });
    if (!privileged && !sandbox) {
      throw new WebWorkerError(`无法为 uid=${uid} 准备工作区沙箱`);
    }
    const port = await getFreePort();
    const token = randomBytes(32).toString("base64url");
    const env = buildWorkerEnv(
      uid,
      port,
      token,
      sandbox?.home ?? (process.env.HOME?.trim() || "/root"),
      sandbox?.tmpdir ?? "/tmp",
      options.identityUrl,
    );
    const entryArgs = [entryPath];
    const args = sandbox
      ? [
          "--reuid",
          String(sandbox.uid),
          "--regid",
          String(sandbox.gid),
          "--clear-groups",
          "--",
          process.execPath,
          ...entryArgs,
        ]
      : entryArgs;
    const child = sandbox
      ? spawn("setpriv", args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        })
      : spawn(process.execPath, args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });
    let resolveReady!: (handle: WebWorkerHandle) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<WebWorkerHandle>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const entry: WorkerEntry = {
      handle: {
        uid,
        port,
        token,
        child,
        activeConnections: 0,
        lastUsedAt: now(),
      },
      ready,
      stderrTail: [],
    };
    const appendStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        entry.stderrTail.push(line);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.shift();
      }
      log(`worker(${uid}) stderr`, { line: text.trim() });
    };
    child.stderr?.on("data", appendStderr);
    child.stdout?.on("data", (chunk: Buffer) => {
      log(`worker(${uid})`, { line: chunk.toString("utf8").trim() });
    });
    child.once("error", (error) => {
      const current = workers.get(uid);
      if (current === entry) workers.delete(uid);
      rejectReady(new WebWorkerError(`worker(${uid}) 启动失败：${error.message}`));
    });
    child.once("exit", (code, signal) => {
      const current = workers.get(uid);
      if (current?.handle.child === child) {
        workers.delete(uid);
      }
      log(`worker(${uid}) 已退出`, { code, signal });
    });
    workers.set(uid, entry);
    waitForWorkerReady(entry.handle, entry).then(
      () => resolveReady(entry.handle),
      (error: unknown) => {
        const current = workers.get(uid);
        if (current === entry) workers.delete(uid);
        child.kill("SIGKILL");
        rejectReady(error);
      },
    );
    await entry.ready;
    log(`worker(${uid}) 已就绪`, { port, numericUid: sandbox?.uid ?? 0 });
    return entry;
  }

  async function ensure(uid: string): Promise<WebWorkerHandle> {
    const existing = workers.get(uid);
    if (existing) return existing.ready;
    const inFlight = starting.get(uid);
    if (inFlight) return inFlight;
    const promise = spawnWorker(uid)
      .then((entry) => entry.handle)
      .finally(() => starting.delete(uid));
    starting.set(uid, promise);
    return promise;
  }

  async function workerRequest(
    uid: string,
    pathname: string,
    init?: RequestInit,
  ): Promise<Response> {
    const handle = await ensure(uid);
    return fetchWorker(handle, pathname, init);
  }

  async function readStatus(response: Response): Promise<ReactorServerStatus> {
    if (!response.ok) {
      throw new WebWorkerError(`worker 状态接口返回 ${response.status}`);
    }
    return (await response.json()) as ReactorServerStatus;
  }

  const cleanupTimer = setInterval(() => {
    const at = now();
    for (const [uid, entry] of workers) {
      if (
        entry.handle.activeConnections === 0 &&
        at - entry.handle.lastUsedAt >= idleStopMs &&
        !starting.has(uid)
      ) {
        void stop(uid);
      }
    }
  }, Math.min(60_000, Math.max(10_000, Math.floor(idleStopMs / 2))));
  cleanupTimer.unref?.();

  async function stop(uid: string): Promise<void> {
    const entry = workers.get(uid);
    if (!entry) return;
    workers.delete(uid);
    const child = entry.handle.child;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    ensure,
    get(uid) {
      return workers.get(uid)?.handle;
    },
    async login(uid, username, password) {
      const response = await workerRequest(uid, "/api/internal/reactor-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(options.identityUrl ? { serverUrl: options.identityUrl } : {}),
        }),
      });
      return readStatus(response);
    },
    async status(uid) {
      const response = await workerRequest(uid, "/api/internal/reactor-identity");
      if (!response.ok) {
        throw new WebWorkerError(`worker 身份接口返回 ${response.status}`);
      }
      const body = (await response.json()) as {
        loggedIn?: unknown;
        user?: { uid?: unknown } | null;
      };
      return {
        loggedIn: body.loggedIn === true,
        uid: typeof body.user?.uid === "string" ? body.user.uid : null,
      };
    },
    async logout(uid) {
      const response = await workerRequest(uid, "/api/internal/reactor-logout", {
        method: "POST",
      });
      if (!response.ok) {
        throw new WebWorkerError(`worker 登出接口返回 ${response.status}`);
      }
    },
    stop,
    async stopAll() {
      clearInterval(cleanupTimer);
      await Promise.all([...workers.keys()].map((uid) => stop(uid)));
    },
    markConnectionOpened(uid) {
      const entry = workers.get(uid);
      if (entry) {
        entry.handle.activeConnections += 1;
        entry.handle.lastUsedAt = now();
      }
    },
    markConnectionClosed(uid) {
      const entry = workers.get(uid);
      if (entry) {
        entry.handle.activeConnections = Math.max(0, entry.handle.activeConnections - 1);
        entry.handle.lastUsedAt = now();
      }
    },
  };
}
