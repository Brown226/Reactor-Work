import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";

/**
 * Web 宿主（单容器）的每用户 UID 沙箱。
 *
 * 仅 Web 镜像启用（`ZCODE_WEB_USER_SANDBOX=1`）：
 * - 每个企业账号映射到独立 UID/GID（20000 起，持久化在 /data/.reactor/web-user-uid-map.json）；
 * - agent 子进程与终端 PTY 以该 UID 启动，HOME/TMPDIR/ZCODE_DATA_BASE_DIR 都指向
 *   /data/homes/<uid>；
 * - 工作区 chown 给该 UID，并设置默认 ACL，保证 Web 宿主（root）后续上传/写入的文件
 *   对该用户可读写；
 * - /data/users 设 711、/data/.reactor 设 700，用户之间不可列目录/读取凭据。
 *
 * 这不是 namespace 级沙箱（bwrap 在默认 Docker seccomp 下无法建 user namespace），
 * 但利用 Unix UID + 文件权限形成真实边界：越权读其他用户/凭据会 EACCES，
 * 越权删 /data、/app 也是 EACCES。宿主进程仍是 root，负责 RPC/文件 API 的
 * 路径策略；agent 执行面（Bash/MCP/终端）全部落在这个 UID 下。
 */
export interface WebUserSandbox {
  uid: number;
  gid: number;
  home: string;
  workspace: string;
  tmpdir: string;
  userName: string;
}

const WEB_USERS_ROOT = "/data/users";
const WEB_HOMES_ROOT = "/data/homes";
const WEB_UID_MAP_FILE = "/data/.reactor/web-user-uid-map.json";
const WEB_UID_MIN = 20000;
const WEB_UID_MAX = 49999;

interface WebUidMapFile {
  version: 1;
  nextUid: number;
  users: Record<string, number>;
}

export function isWebUserSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "linux" && env.ZCODE_WEB_USER_SANDBOX?.trim() === "1";
}

function readUidMap(): WebUidMapFile {
  try {
    const parsed = JSON.parse(readFileSync(WEB_UID_MAP_FILE, "utf8")) as WebUidMapFile;
    if (
      parsed?.version === 1 &&
      Number.isInteger(parsed.nextUid) &&
      parsed.users &&
      typeof parsed.users === "object"
    ) {
      return parsed;
    }
  } catch {
    // 首次启动/文件损坏：重新分配；已有工作区目录信息仍可由路径推导用户名，
    // UID 变化只会影响旧文件 ACL，下一次 prepare 会重新 chown/ACL。
  }
  return { version: 1, nextUid: WEB_UID_MIN, users: {} };
}

function writeUidMap(map: WebUidMapFile): void {
  const tmp = `${WEB_UID_MAP_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, WEB_UID_MAP_FILE);
}

function allocateUid(userName: string): { uid: number; map: WebUidMapFile } {
  mkdirSync("/data/.reactor", { recursive: true, mode: 0o700 });
  const map = readUidMap();
  const existing = map.users[userName];
  if (existing) return { uid: existing, map };
  // 防御：map 里已有但范围外的值（手工编辑）重新分配。
  let uid = Math.max(WEB_UID_MIN, map.nextUid);
  while (uid <= WEB_UID_MAX) {
    if (!Object.values(map.users).includes(uid)) break;
    uid += 1;
  }
  if (uid > WEB_UID_MAX) throw new Error("Web 用户 UID 池已耗尽（20000-49999）");
  map.users[userName] = uid;
  map.nextUid = uid + 1;
  writeUidMap(map);
  return { uid, map };
}

function ensureDir(path: string, mode: number, uid?: number, gid?: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  if (uid !== undefined) chownSync(path, uid, gid ?? uid);
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "ignore" });
}

/**
 * 给工作区加「用户可读写 + 新文件继承」ACL。Web 宿主以 root 上传/写文件，
 * 没有默认 ACL 时新文件是 root:root 0600，沙箱用户读不到。
 */
function applyWorkspaceAcl(workspace: string, uid: number): void {
  try {
    // -P：不跟随符号链接；-R：递归。默认 ACL 只对目录生效，用 find 限定。
    run("setfacl", ["-R", "-P", "-m", `u:${uid}:rwx`, workspace]);
    const dirs = execFileSync("find", [workspace, "-type", "d", "-print0"], { encoding: "buffer" });
    for (const dir of dirs.toString("utf8").split("\0")) {
      if (!dir) continue;
      run("setfacl", ["-m", "-d", "-m", `u:${uid}:rwx`, dir]);
    }
  } catch {
    // 镜像未装 acl 时退回：至少已有文件由 chown 保证；新文件读不到会在附件
    // 读取时以 EACCES 暴露。Dockerfile 已安装 acl，这里只做降级不静默失败。
  }
}

/** 工作区所有权 + 权限：目录 700、文件 600，符号链接只改自身不跟随。 */
function hardenWorkspace(workspace: string, uid: number, gid: number): void {
  run("chown", ["-R", "-h", `${uid}:${gid}`, workspace]);
  const entries = readdirSync(workspace, { withFileTypes: true });
  chmodSync(workspace, 0o700);
  for (const entry of entries) {
    const full = join(workspace, entry.name);
    if (entry.isDirectory()) {
      hardenWorkspace(full, uid, gid);
    } else if (entry.isFile()) {
      chmodSync(full, 0o600);
    }
  }
}

function copyProviderConfig(home: string, uid: number): void {
  const sourceDir = "/data/.reactor/v2";
  const source = join(sourceDir, "provider_config.json");
  if (!existsSync(source)) return;
  const targetDir = join(home, ".reactor", "v2");
  const target = join(targetDir, "provider_config.json");
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    chownSync(targetDir, uid, uid);
    chownSync(target, uid, uid);
    chmodSync(target, 0o600);
    // CLI 还需要 host 侧的 bundled built-in release；不复制会让 agent 启动时报
    //「Bundled 与 Active ZCode Built-in Release 均不可用」直接退出。
    const runtimeSource = join(sourceDir, "runtime");
    if (existsSync(runtimeSource)) {
      const runtimeTarget = join(targetDir, "runtime");
      cpSync(runtimeSource, runtimeTarget, { recursive: true });
      run("chown", ["-R", "-h", `${uid}:${uid}`, runtimeTarget]);
      run("chmod", ["-R", "u=rwX,go=", runtimeTarget]);
    }
  } catch {
    // 配置复制失败不阻断 spawn：host 仍会在握手时下发 provider config。
  }
}

const preparedWorkspaces = new Set<string>();

/**
 * 把 host 解析出的 provider 运行时文件复制到用户 home，并返回该用户可读的路径。
 *
 * 为什么必须重写：host 在 spawn env 里下发的是 `/data/.reactor/...` 绝对路径，
 * 而 /data/.reactor 对沙箱用户是 700 root；子进程直接读会 EACCES，启动即报
 *「Bundled 与 Active ZCode Built-in Release 均不可用」。
 */
export function materializeWebUserProviderPaths(
  sandbox: WebUserSandbox,
  env: NodeJS.ProcessEnv = process.env,
): { builtin: string; personal: string } {
  const personalTarget = join(sandbox.home, ".reactor", "v2", "provider_config.json");
  const builtinTargetDir = join(sandbox.home, ".reactor", "v2", "runtime", "provider", "active");
  const builtinTarget = join(builtinTargetDir, "zcode-builtin.json");

  const copyIfReadable = (source: string | undefined, target: string): boolean => {
    if (!source?.trim() || !existsSync(source)) return false;
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      chownSync(target, sandbox.uid, sandbox.gid);
      chmodSync(target, 0o600);
      return true;
    } catch {
      return false;
    }
  };

  const personalSource = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  if (!copyIfReadable(personalSource, personalTarget)) {
    // 没有 host personal 路径时，copyProviderConfig 已放了 provider_config.json。
  }
  const builtinSource = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  copyIfReadable(builtinSource, builtinTarget);
  return { builtin: builtinTarget, personal: personalTarget };
}
/**
 * 解析工作区所属用户并完成沙箱准备；非 Web 沙箱或工作区不在 /data/users 下返回 null。
 * 必须在 spawn 子进程前调用（host 为 root）。
 */
export function prepareWebUserSandbox(workspacePath: string): WebUserSandbox | null {
  if (!isWebUserSandboxEnabled()) return null;
  const resolved = join(workspacePath);
  const rel = relative(WEB_USERS_ROOT, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const userName = rel.split(/[\\/]/)[0] ?? "";
  if (!userName) return null;

  const { uid } = allocateUid(userName);
  const userRoot = join(WEB_USERS_ROOT, userName);
  const home = join(WEB_HOMES_ROOT, String(uid));
  const tmpdir = join(home, "tmp");

  // 父目录语义：/data/users 711（可穿过、不可列）；/data/.reactor 700（凭据/会话库 root only）。
  try {
    chmodSync(WEB_USERS_ROOT, 0o711);
  } catch {
    // 目录不存在等由下面 mkdir 兜底
  }
  ensureDir(home, 0o700, uid, uid);
  ensureDir(join(home, ".reactor"), 0o700, uid, uid);
  ensureDir(tmpdir, 0o700, uid, uid);
  try {
    chmodSync("/data/.reactor", 0o700);
  } catch {
    // ignore
  }
  if (existsSync(userRoot)) {
    if (!preparedWorkspaces.has(userRoot)) {
      hardenWorkspace(userRoot, uid, uid);
      applyWorkspaceAcl(userRoot, uid);
      preparedWorkspaces.add(userRoot);
    }
  } else {
    ensureDir(userRoot, 0o700, uid, uid);
  }
  // 每次 spawn 都刷新一份只读 provider 配置：host 同步完供应商后，子进程下次启动即可见。
  copyProviderConfig(home, uid);
  if (!existsSync(resolved)) {
    ensureDir(resolved, 0o700, uid, uid);
  }

  return {
    uid,
    gid: uid,
    home,
    workspace: resolved,
    tmpdir,
    userName,
  };
}

/** 生产态诊断用：不打印用户名以外的敏感信息。 */
export function describeWebUserSandbox(sandbox: WebUserSandbox): string {
  const digest = createHash("sha256").update(sandbox.userName).digest("hex").slice(0, 8);
  return `uid=${sandbox.uid} user=${digest}`;
}
