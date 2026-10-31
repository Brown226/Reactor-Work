import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidUid } from "../user-workspace.js";
import { SpaceError } from "./errors.js";
import { SHARE_TOKEN_PATTERN } from "./paths.js";

/**
 * 分享存储（方案 §4 / §5.5）。
 *
 * 落盘在空间根同级的 shares.json（容器内 /data/shares.json），不用数据库：
 * 分享量是几十条规模，且需要和 /data 卷一起备份/迁移。
 *
 * 并发：进程内串行队列保证 read-modify-write 不丢更新；写入走「临时文件 + rename」，
 * 读侧永远看到完整 JSON（进程崩溃也不会留下半截文件）。
 */

export interface ShareRecord {
  token: string;
  uid: string;
  /** 分享时锁定的相对路径；公开下载不允许越出它（§5.6）。 */
  path: string;
  name: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  /** sha256(口令) 的 hex；null 表示无口令。 */
  passwordHash: string | null;
}

interface SharesFile {
  version: 1;
  shares: ShareRecord[];
}

const QUEUED_WRITE_NOTE = "分享索引写入失败";

export function newShareToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSharePassword(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

/** 定长 hex 比较用 timingSafeEqual，避免按字符短路泄露口令信息。 */
function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function verifySharePassword(record: ShareRecord, password: string | undefined): boolean {
  if (!record.passwordHash) {
    return true;
  }
  if (!password) {
    return false;
  }
  return safeEqualHex(record.passwordHash, hashSharePassword(password));
}

export function isShareExpired(record: ShareRecord, now = Date.now()): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now;
}

function isShareRecord(value: unknown): value is ShareRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === "string" &&
    SHARE_TOKEN_PATTERN.test(record.token) &&
    typeof record.uid === "string" &&
    isValidUid(record.uid) &&
    typeof record.path === "string" &&
    record.path.length > 0 &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.size === "number" &&
    Number.isFinite(record.size) &&
    record.size >= 0 &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    (record.passwordHash === null || typeof record.passwordHash === "string")
  );
}

/** 读失败（不存在）视为空；JSON 损坏则显式报错，绝不静默覆盖掉用户已有的分享。 */
export async function readShareRecords(file: string): Promise<ShareRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new SpaceError("分享索引读取失败", 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SpaceError("分享索引损坏，请检查 shares.json", 500);
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as SharesFile).shares)
      ? (parsed as SharesFile).shares
      : null;
  if (!candidates) {
    throw new SpaceError("分享索引格式不正确", 500);
  }
  return candidates.filter(isShareRecord);
}

async function writeShareRecords(file: string, shares: ShareRecord[]): Promise<void> {
  const payload: SharesFile = { version: 1, shares };
  await mkdir(dirname(file), { recursive: true });
  // 临时文件与目标同目录，rename 才是原子的；随机后缀避免并发/崩溃残留互相覆盖。
  const tempFile = join(dirname(file), `.shares-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempFile, file);
  } catch {
    throw new SpaceError(QUEUED_WRITE_NOTE, 500);
  }
}

/**
 * 进程内串行队列。任务失败不能阻断后续任务，所以链上存的是「永远 resolve」的 promise。
 */
let sharesQueue: Promise<unknown> = Promise.resolve();

function withSharesLock<T>(task: () => Promise<T>): Promise<T> {
  const run = sharesQueue.then(task, task);
  sharesQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface CreateShareInput {
  uid: string;
  path: string;
  name: string;
  size: number;
  ttlHours: number;
  passwordHash: string | null;
}

export async function createShareRecord(
  file: string,
  input: CreateShareInput,
): Promise<ShareRecord> {
  const record: ShareRecord = {
    token: newShareToken(),
    uid: input.uid,
    path: input.path,
    name: input.name,
    size: input.size,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + input.ttlHours * 3_600_000).toISOString(),
    passwordHash: input.passwordHash,
  };
  return withSharesLock(async () => {
    const shares = await readShareRecords(file);
    shares.push(record);
    await writeShareRecords(file, shares);
    return record;
  });
}

export async function findShareRecord(file: string, token: string): Promise<ShareRecord | null> {
  if (!SHARE_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const shares = await readShareRecords(file);
  return shares.find((record) => record.token === token) ?? null;
}

/** 只允许创建者撤销自己的分享；返回 false 表示 token 不存在或不属于该 uid。 */
export async function revokeShareRecord(
  file: string,
  uid: string,
  token: string,
): Promise<boolean> {
  return withSharesLock(async () => {
    const shares = await readShareRecords(file);
    const next = shares.filter((record) => !(record.token === token && record.uid === uid));
    if (next.length === shares.length) {
      return false;
    }
    await writeShareRecords(file, next);
    return true;
  });
}

/** 公开下载地址：相对路径，由前端按当前 origin 拼接。 */
export function sharePublicUrl(token: string): string {
  return `/api/space/shared/${token}`;
}
