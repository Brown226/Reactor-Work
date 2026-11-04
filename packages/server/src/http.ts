/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  IReactorServerService,
  ISystemService,
  ITerminalService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import {
  getCurrentLoginUid,
  installLoginUidRecorder,
  isValidUid,
  registerUserWorkspaceRoutes,
  resolveUserWorkspaceRoot,
  type ServerInfoWithUserWorkspace,
} from "./user-workspace.js";
import { createUserSpaceRoutes } from "./user-space/routes.js";
import {
  IdentityLoginError,
  clearWebSessionCookie,
  createLoginRateLimiter,
  getWebAuthSession,
  isCrossSiteMutation,
  isSessionProtectedPath,
  loginWithIdentity,
  readClientIp,
  readWebSessionCookie,
  resolveIdentityBaseUrl,
  setWebAuthSession,
  setWebSessionCookie,
} from "./web/sessionAuth.js";
import {
  createWebSessionStore,
  resolveWebSessionTtlSeconds,
  type WebSession,
} from "./web/sessionStore.js";
import { createWorkerWsBridge, type WorkerWsBridge } from "./web/workerBridge.js";
import {
  createWebWorkerRegistry,
  type WebWorkerRegistry,
} from "./web/workerRegistry.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<
  string,
  { connection: RemoteConnection; uid: string | null }
>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  /** Web 网关：每浏览器会话鉴权；worker 不使用该模式。 */
  sessionAuth?: boolean;
  /** 会话登录转发的 identity 地址；worker 也用它做企业登录。 */
  identityUrl?: string;
  /** 当前进程是某个 uid 的 worker：开放 /api/internal/*。 */
  webWorker?: boolean;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(
  options: HttpServerOptions,
  sessionUid?: string | null,
): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  /*
   * 每用户空间即默认工作区（产物自动归集）。
   *
   * 登录成功后服务端已记下 uid（user-workspace 的登录记录器），此时把工作区指向
   * `<空间根>/<uid>`：agent 的读写、终端命令、生成的文件全都落在该用户 1GB 配额内，
   * 不需要任何额外的"搬运到我的空间"逻辑——这就是归集的实现方式。
   *
   * 未登录时（登录页首屏、健康检查）回落到共享工作区，保证登录流程本身可用。
   */
  const loginUid = sessionUid ?? (options.sessionAuth ? null : getCurrentLoginUid());
  if (loginUid && isValidUid(loginUid)) {
    const userDir = join(resolveUserWorkspaceRoot(), loginUid);
    try {
      // 首次登录后可能还没人调用过 POST /api/user-workspace，这里补建，
      // 否则 agent 以不存在的工作区启动会直接失败。
      mkdirSync(userDir, { recursive: true });
      return [{ path: userDir, label: loginUid }];
    } catch (error) {
      console.warn("[server-info] 创建用户工作区失败，回落到共享工作区:", error);
    }
  }
  // 会话模式下未登录不暴露任何服务器路径；共享工作区只属于旧的单用户部署。
  if (options.sessionAuth) {
    return [];
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(
  options: HttpServerOptions,
  sessionUid?: string | null,
): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired:
      options.authRequired ??
      Boolean(options.sessionAuth || readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options, sessionUid),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";
/** 访问令牌 cookie 有效期：30 天（部署级共享入口，避免每次新开浏览器重输）。 */
const LITE_TOKEN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      // 30 天：访问令牌是部署级共享入口，不应每次新开浏览器都重输。
      // 令牌轮换后旧 cookie 会自然失配，重新用 ?token= 访问即可。
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LITE_TOKEN_COOKIE_MAX_AGE_SECONDS}`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  // 分享链接必须能匿名打开（方案 §4 公开下载、§7.4 无痕窗口验收）：
  // 匿名访问者没有服务端 lite token cookie。访问控制由 share token + 过期 + 口令
  // 在 user-space 路由内完成，这里只放行这一条前缀。
  if (pathname.startsWith("/api/space/shared/")) {
    return false;
  }
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();
  const sessionAuth = options.sessionAuth === true;
  const identityUrl = options.identityUrl?.trim() || resolveIdentityBaseUrl();
  const sessionStore = sessionAuth ? createWebSessionStore() : null;
  const workerRegistry: WebWorkerRegistry | null = sessionAuth
    ? createWebWorkerRegistry({ identityUrl })
    : null;
  const loginRateLimiter = sessionAuth ? createLoginRateLimiter() : null;
  const authLog = (...args: unknown[]) =>
    console.log(formatLogPrefix("zcode-server:web-auth", process.pid), ...args);

  const authToken = sessionAuth ? undefined : options.authToken?.trim();
  if (sessionAuth) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      if (!isSessionProtectedPath(pathname)) {
        await next();
        return;
      }
      if (isCrossSiteMutation(c)) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const session = sessionStore?.get(readWebSessionCookie(c));
      if (!session) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      setWebAuthSession(c, session);
      await next();
    });
  } else if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  if (sessionAuth) {
    app.post("/api/auth/login", async (c) => {
      if (!identityUrl) {
        return c.json({ error: "服务端未配置身份服务" }, 503);
      }
      if (isCrossSiteMutation(c)) {
        return c.json({ error: "Forbidden" }, 403);
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "请求体必须是 JSON" }, 400);
      }
      const body =
        typeof raw === "object" && raw !== null
          ? (raw as { username?: unknown; password?: unknown })
          : {};
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username || !password) {
        return c.json({ error: "请输入账号与密码" }, 400);
      }
      const ip = readClientIp(c);
      const rateKey = `${ip ?? "unknown"}|${username.toLocaleLowerCase()}`;
      if (loginRateLimiter?.isBlocked(rateKey)) {
        return c.json({ error: "登录失败次数过多，请稍后重试" }, 429);
      }
      try {
        const identity = await loginWithIdentity(identityUrl, username, password);
        const uid = identity.user.uid;
        const status = await workerRegistry!.login(uid, username, password);
        if (!status.loggedIn || status.user?.uid !== uid) {
          if (status.loggedIn) {
            await workerRegistry!.logout(uid).catch(() => undefined);
          }
          throw new IdentityLoginError(502, "企业登录身份与网关会话不一致");
        }
        loginRateLimiter?.reset(rateKey);
        const session = sessionStore!.create({
          uid,
          username,
          userAgent: c.req.header("user-agent"),
          ip,
        });
        setWebSessionCookie(c, session.sid, resolveWebSessionTtlSeconds());
        authLog("登录成功", { uid, username });
        return c.json({
          user: { uid, username },
          mustChangePassword: status.user?.mustChangePassword ?? false,
        });
      } catch (error) {
        loginRateLimiter?.recordFailure(rateKey);
        const status = error instanceof IdentityLoginError ? error.status : 502;
        const message =
          error instanceof IdentityLoginError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        authLog("登录失败", { username, error: message });
        const clientStatus = status === 401 || status === 403 ? 401 : 502;
        return c.json(
          { error: clientStatus === 401 ? message : "登录失败，请稍后重试" },
          clientStatus,
        );
      }
    });

    app.get("/api/auth/session", async (c) => {
      const session = sessionStore?.get(readWebSessionCookie(c));
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      try {
        const identity = await workerRegistry!.status(session.uid);
        if (!identity.loggedIn || identity.uid !== session.uid) {
          sessionStore?.revoke(session.sid);
          clearWebSessionCookie(c);
          return c.json({ error: "Unauthorized" }, 401);
        }
      } catch (error) {
        authLog("会话校验无法读取 worker 身份", {
          uid: session.uid,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "Session unavailable" }, 503);
      }
      return c.json({ user: { uid: session.uid, username: session.username } });
    });

    app.post("/api/auth/logout", async (c) => {
      const session: WebSession | null = getWebAuthSession(c);
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      sessionStore?.revoke(session.sid);
      clearWebSessionCookie(c);
      if ((sessionStore?.countActiveForUid(session.uid) ?? 0) === 0) {
        await workerRegistry?.logout(session.uid).catch((error: unknown) => {
          authLog("worker 登出失败（会话已吊销）", {
            uid: session.uid,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        await workerRegistry?.stop(session.uid);
      }
      return c.body(null, 204);
    });
  }

  // server-info 旧字段保持不变（兼容旧客户端），追加 userWorkspaceRoot 与 identityUrl 供前端能力发现。
  // identityUrl 的用途：Web 端登录请求由**本服务端**转发到 identity，用户浏览器不需要可达该地址，
  // 所以真正可用的地址只有服务端知道。下发后登录页会锁定地址并隐藏输入框，
  // 避免把容器内网服务名（如 http://identity:8791）暴露给最终用户去手填。
  app.get("/api/server-info", (c) => {
    const session = sessionAuth ? sessionStore?.get(readWebSessionCookie(c)) : null;
    const info: ServerInfoWithUserWorkspace = {
      ...createServerInfo(options, session?.uid ?? null),
      userWorkspaceRoot: resolveUserWorkspaceRoot(),
      ...(identityUrl ? { identityUrl } : {}),
    };
    return c.json(info);
  });
  app.post("/api/rpc-host-capability", (c) =>
    sessionAuth ? c.json({ error: "disabled" }, 403) : c.json(hostCapabilities.issue()),
  );

  if (options.webWorker) {
    const reactorServer = services.getOptional(IReactorServerService);
    app.post("/api/internal/reactor-login", async (c) => {
      if (!reactorServer) return c.json({ error: "企业服务未装配" }, 503);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "请求体必须是 JSON" }, 400);
      }
      const body =
        typeof raw === "object" && raw !== null
          ? (raw as { username?: unknown; password?: unknown; serverUrl?: unknown })
          : {};
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const serverUrl =
        (typeof body.serverUrl === "string" && body.serverUrl.trim()) ||
        readTrimmedEnv("REACTOR_IDENTITY_URL");
      if (!username || !password || !serverUrl) {
        return c.json({ error: "缺少登录参数" }, 400);
      }
      try {
        return c.json(await reactorServer.login({ serverUrl, username, password }));
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          502,
        );
      }
    });
    app.get("/api/internal/reactor-status", async (c) => {
      if (!reactorServer) return c.json({ error: "企业服务未装配" }, 503);
      try {
        return c.json(await reactorServer.getStatus());
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          502,
        );
      }
    });
    app.get("/api/internal/reactor-identity", async (c) => {
      if (!reactorServer) return c.json({ error: "企业服务未装配" }, 503);
      try {
        const user = await reactorServer.getSessionIdentity();
        return c.json({ loggedIn: Boolean(user), user });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          502,
        );
      }
    });
    app.post("/api/internal/reactor-logout", async (c) => {
      if (!reactorServer) return c.json({ error: "企业服务未装配" }, 503);
      try {
        await reactorServer.logout();
        return c.json({ ok: true });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          502,
        );
      }
    });
  }

  // 每用户工作区（B 方案：单容器多目录 + 应用层软配额）：先在登录成功路径上记录当前 uid，
  // 再挂路由；身份校验的阶段一限制（uid 即身份、显式 uid 可伪造）见 user-workspace.ts。
  if (!sessionAuth) {
    installLoginUidRecorder(services);
  }
  registerUserWorkspaceRoutes(app);
  // 我的空间（方案 §4）：与 user-workspace 共用登录 uid 记录、空间根与配额；
  // 公开分享路由 /api/space/shared/:token 的身份放行见 isTokenProtectedPath。
  app.route("/api/space", createUserSpaceRoutes());

  if (sessionAuth) {
    app.use("/ws", async (c, next) => {
      if (new URL(c.req.url).pathname !== "/ws") {
        await next();
        return;
      }
      const session = getWebAuthSession(c);
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      try {
        await workerRegistry!.ensure(session.uid);
        const status = await workerRegistry!.status(session.uid);
        if (!status.loggedIn || status.uid !== session.uid) {
          sessionStore?.revoke(session.sid);
          clearWebSessionCookie(c);
          return c.json({ error: "Unauthorized" }, 401);
        }
      } catch (error) {
        authLog("worker 启动失败", {
          uid: session.uid,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "worker unavailable" }, 503);
      }
      await next();
    });
    app.get(
      "/ws",
      upgradeWebSocket((c) => {
        const session = getWebAuthSession(c);
        const worker = session ? workerRegistry!.get(session.uid) : undefined;
        if (!session || !worker) {
          return {
            onOpen(_event, ws) {
              ws.close(1011, "worker unavailable");
            },
          };
        }
        let bridge: WorkerWsBridge | null = null;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          bridge?.close();
          workerRegistry!.markConnectionClosed(session.uid);
        };
        return {
          onOpen(_event, ws) {
            workerRegistry!.markConnectionOpened(session.uid);
            bridge = createWorkerWsBridge(ws, worker);
          },
          onMessage(event, _ws) {
            bridge?.send(event.data as string | ArrayBuffer | Uint8Array);
          },
          onClose() {
            release();
          },
          onError() {
            release();
          },
        };
      }),
    );
  } else {
    // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
    // 都不能再把自己提升为 trusted host。
    app.get(
      "/ws",
      upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
        },
      })),
    );
  }

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  if (sessionAuth) {
    app.all("/ws/host", (c) => c.json({ error: "disabled" }, 403));
  } else {
    app.use("/ws/host", async (c, next) => {
      const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
      if (!hostCapabilities.consume(capability)) {
        return c.json({ error: "Invalid or expired host capability" }, 401);
      }
      await next();
    });
    app.get("/ws/host", upgradeTrustedHostWebSocket);
  }

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const session = sessionAuth ? getWebAuthSession(c) : null;
    if (sessionAuth && !session) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, { connection, uid: session?.uid ?? null });

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const entry = remoteConnections.get(id);
          if (!entry) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          if (
            sessionAuth &&
            entry.uid !== getWebAuthSession(c)?.uid
          ) {
            ws.close(4003, "Remote connection does not belong to this session");
            return;
          }
          const { connection } = entry;
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);
  server.on("close", () => {
    sessionStore?.close();
    void workerRegistry?.stopAll();
  });

  return server;
}
