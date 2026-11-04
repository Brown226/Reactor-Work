#!/usr/bin/env node
/**
 * 旧共享 Web 数据 → 指定企业用户的 per-uid home。
 *
 * 旧 tasks 表没有 uid 列，无法自动判断归属；本脚本要求管理员显式指定 --uid，
 * 只复制、不删除旧库。执行前请停止 web 容器，避免复制到写了一半的 SQLite。
 *
 * 用法：
 *   node scripts/migrate-web-user-data.mjs --uid alice
 *   node scripts/migrate-web-user-data.mjs --uid alice --source /data/.reactor/cli/db
 *   node scripts/migrate-web-user-data.mjs --uid alice --workspace /data/workspace --dry-run
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

function fail(message) {
  console.error(`[migrate-web-user-data] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    uid: "",
    source: process.env.REACTOR_LEGACY_CLI_DB?.trim() || "/data/.reactor/cli/db",
    workspace: "",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--uid") options.uid = argv[++index]?.trim() ?? "";
    else if (arg === "--source") options.source = argv[++index]?.trim() ?? "";
    else if (arg === "--workspace") options.workspace = argv[++index]?.trim() ?? "";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法: node scripts/migrate-web-user-data.mjs --uid <uid> [--source <旧库>] [--workspace <旧工作区>] [--dry-run]",
      );
      process.exit(0);
    } else {
      fail(`未知参数: ${arg}`);
    }
  }
  if (!options.uid) fail("必须通过 --uid 指定归属企业账号");
  return options;
}

function readUidMap() {
  const file =
    process.env.REACTOR_WEB_UID_MAP_FILE?.trim() ||
    join(process.env.REACTOR_WEB_DATA_ROOT?.trim() || "/data/.reactor", "web-user-uid-map.json");
  if (!existsSync(file)) {
    fail(`找不到 UID 映射 ${file}；请先让该账号登录一次，再执行迁移`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed?.users || typeof parsed.users !== "object") {
    fail(`UID 映射格式不正确: ${file}`);
  }
  return { file, map: parsed };
}

function assertInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    fail(`目标越界: ${target}`);
  }
}

function backupIfExists(target, dryRun) {
  if (!existsSync(target)) return;
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`[migrate-web-user-data] 备份 ${target} -> ${backup}`);
  if (!dryRun) renameSync(target, backup);
}

function copyTree(source, target, dryRun) {
  console.log(`[migrate-web-user-data] 复制 ${source} -> ${target}`);
  if (dryRun) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

function chownTree(target, uid, dryRun) {
  if (dryRun || !existsSync(target)) return;
  execFileSync("chown", ["-R", "-h", `${uid}:${uid}`, target], { stdio: "inherit" });
}

const options = parseArgs(process.argv.slice(2));
const { map, file: uidMapFile } = readUidMap();
const numericUid = map.users[options.uid];
if (!Number.isInteger(numericUid)) {
  fail(`账号 ${options.uid} 尚无数字 UID 映射（${uidMapFile}）；请先登录一次`);
}

if (!existsSync(options.source)) {
  fail(`旧会话库不存在: ${options.source}`);
}

const homesRoot = process.env.REACTOR_WEB_HOMES_ROOT?.trim() || "/data/homes";
const usersRoot = process.env.REACTOR_WEB_USERS_ROOT?.trim() || "/data/users";
const sessionsTarget = join(homesRoot, String(numericUid), ".reactor", "cli", "db");
assertInside(homesRoot, sessionsTarget);

console.log(
  `[migrate-web-user-data] uid=${options.uid} numericUid=${numericUid} dryRun=${options.dryRun}`,
);

backupIfExists(sessionsTarget, options.dryRun);
if (statSync(options.source).isDirectory()) {
  copyTree(options.source, sessionsTarget, options.dryRun);
} else {
  // 单文件 SQLite：保留同目录的 -wal / -shm，避免只复制主库丢最近事务。
  const sourceDir = dirname(options.source);
  const sourceName = basename(options.source);
  copyTree(options.source, join(sessionsTarget, sourceName), options.dryRun);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = join(sourceDir, `${sourceName}${suffix}`);
    if (existsSync(sidecar)) {
      copyTree(sidecar, join(sessionsTarget, `${sourceName}${suffix}`), options.dryRun);
    }
  }
}
chownTree(join(homesRoot, String(numericUid)), numericUid, options.dryRun);

if (options.workspace) {
  if (!existsSync(options.workspace)) {
    fail(`旧工作区不存在: ${options.workspace}`);
  }
  const workspaceTarget = join(usersRoot, options.uid);
  assertInside(usersRoot, workspaceTarget);
  backupIfExists(workspaceTarget, options.dryRun);
  copyTree(options.workspace, workspaceTarget, options.dryRun);
  chownTree(workspaceTarget, numericUid, options.dryRun);
}

console.log("[migrate-web-user-data] 完成；旧库未删除，确认无误后由管理员自行清理");
