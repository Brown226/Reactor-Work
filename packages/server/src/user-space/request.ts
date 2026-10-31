import type { Context } from "hono";
import { getCurrentLoginUid, isValidUid } from "../user-workspace.js";
import { SpaceError } from "./errors.js";

/**
 * 身份解析：复用 user-workspace 的「登录成功记录 uid」唯一所有者，不另建状态。
 *
 * **可伪造警告**：显式 `?uid=` 是阶段一联调后门 —— /ws 尚无鉴权（独立 P0），
 * 任何客户端都能报任意 uid 读到别人的空间。这里保留它只为了前端显式传参兜底；
 * 接入会话身份后应改为「uid 必须来自已认证会话」并移除 query 入口。
 */
export function requireRequestUid(c: Context): string {
  const explicit = c.req.query("uid")?.trim();
  const uid = explicit || getCurrentLoginUid();
  if (!uid) {
    throw new SpaceError("无法确定用户身份：请求未携带 uid，且服务端尚无登录成功的用户记录", 401);
  }
  if (!isValidUid(uid)) {
    throw new SpaceError("uid 不合法", 400);
  }
  return uid;
}

/** 请求体必须是 JSON 对象；空 body / 数组 / 原始值统一 400。 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new SpaceError("请求体必须是 JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SpaceError("请求体必须是 JSON 对象");
  }
  return raw as Record<string, unknown>;
}

export function requireStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new SpaceError(`字段 ${key} 必须是字符串`);
  }
  return value;
}

export function requireNumberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SpaceError(`字段 ${key} 必须是数字`);
  }
  return value;
}

/** 批量接口上限：一次请求最多 200 条，避免单请求长时间占用事件循环。 */
const MAX_BATCH_SIZE = 200;

export function requireStringArrayField(
  body: Record<string, unknown>,
  key: string,
  minLength: number,
): string[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new SpaceError(`字段 ${key} 必须是字符串数组`);
  }
  if (value.length < minLength) {
    throw new SpaceError(`字段 ${key} 至少需要 ${minLength} 项`);
  }
  if (value.length > MAX_BATCH_SIZE) {
    throw new SpaceError(`字段 ${key} 一次最多 ${MAX_BATCH_SIZE} 项`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new SpaceError(`字段 ${key} 必须是字符串数组`);
    }
    return item;
  });
}
