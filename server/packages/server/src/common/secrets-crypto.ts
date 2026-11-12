/**
 * 密钥落盘加密（T3-4 安全前置）：secrets.field_values 中标为 secret 的字段以 AES-256-GCM 加密存储。
 *
 * 主密钥来自环境变量 REACTOR_SECRET_KEY（32 字节：64 位十六进制或 base64）；
 * 未配置时**不加密**（写入明文 + 启动告警），以保证本地开发可跑——生产必须配置。
 *
 * 存储形态：enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * 无前缀的历史明文值在读取时原样返回（向后兼容），由迁移步骤负责就地加密。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 密文前缀（含版本号，便于日后换算法）。 */
export const SEALED_PREFIX = "enc:v1:";

/**
 * 掩码占位值：GET 接口对 secret 字段返回此值。
 * 客户端回传该值时一律视为「不修改」，绝不写库（防掩码覆盖真密钥）。
 */
export const SECRET_MASK = "********";

/** 主密钥长度（AES-256）。 */
const KEY_BYTES = 32;

/** 从环境读取主密钥；未配置返回 null（调用方决定降级行为）。 */
export function loadSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.REACTOR_SECRET_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(`REACTOR_SECRET_KEY 必须是 32 字节（64 位十六进制或 base64），当前解出 ${buf.length} 字节`);
  }
  return buf;
}

/** 是否为已加密值。 */
export function isSealed(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SEALED_PREFIX);
}

/** 明文 → 密文。空串直接返回空串（空值无秘密可言，且便于「未配置」护栏判断）。 */
export function sealSecret(plain: string, key: Buffer): string {
  if (plain === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEALED_PREFIX + [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

/** 密文 → 明文；历史明文原样返回。密钥缺失或篡改（认证标签校验失败）则抛错。 */
export function openSecret(stored: string, key: Buffer | null): string {
  if (!isSealed(stored)) return stored;
  if (!key) throw new Error("遇到加密密钥但未配置 REACTOR_SECRET_KEY，无法解密");
  const parts = stored.slice(SEALED_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("密钥密文格式非法");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** 从模板 fields 定义中取出标为 secret 的字段名。 */
export function secretFieldNames(templateFields: unknown): string[] {
  if (!Array.isArray(templateFields)) return [];
  const names: string[] = [];
  for (const f of templateFields) {
    const o = (f ?? {}) as Record<string, unknown>;
    if (o.secret === true && typeof o.key === "string" && o.key) names.push(o.key);
  }
  return names;
}

/** 模板未定义时的兜底判定：字段名像密钥的按密文处理。 */
export function looksLikeSecretField(name: string): boolean {
  return /key|token|secret|password|passwd|pwd|credential/i.test(name);
}

/** 给定模板字段定义，加密 values 中的敏感字段（其余原样）。 */
export function sealFields(
  values: Record<string, unknown>,
  templateFields: unknown,
  key: Buffer,
): Record<string, unknown> {
  const names = secretFieldNames(templateFields);
  const out: Record<string, unknown> = { ...values };
  for (const [k, v] of Object.entries(out)) {
    const sensitive = names.length > 0 ? names.includes(k) : looksLikeSecretField(k);
    // 已是密文的不要二次加密（PATCH 保留原值的场景）
    if (sensitive && typeof v === "string" && v !== "" && !isSealed(v)) out[k] = sealSecret(v, key);
  }
  return out;
}

/** 解密 values 中的敏感字段（供网关等内部消费方使用）。 */
export function openFields(
  values: Record<string, unknown>,
  templateFields: unknown,
  key: Buffer | null,
): Record<string, unknown> {
  const names = secretFieldNames(templateFields);
  const out: Record<string, unknown> = { ...values };
  for (const [k, v] of Object.entries(out)) {
    if (!isSealed(v)) continue;
    const sensitive = names.length > 0 ? names.includes(k) : looksLikeSecretField(k);
    if (sensitive) out[k] = openSecret(v as string, key);
  }
  return out;
}

/** 给定模板字段定义，把敏感字段替换为掩码（供管理台读取接口使用）。 */
export function maskFields(values: Record<string, unknown>, templateFields: unknown): Record<string, unknown> {
  const names = secretFieldNames(templateFields);
  const out: Record<string, unknown> = { ...values };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string" || v === "") continue;
    const sensitive = names.length > 0 ? names.includes(k) : looksLikeSecretField(k);
    if (sensitive) out[k] = SECRET_MASK;
  }
  return out;
}

/** PATCH 语义：入参中等于掩码的敏感字段视为「保持原值」，从更新对象里剔除。 */
export function stripMaskedFields(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
  templateFields: unknown,
): Record<string, unknown> {
  const names = secretFieldNames(templateFields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const sensitive = names.length > 0 ? names.includes(k) : looksLikeSecretField(k);
    if (sensitive && v === SECRET_MASK) {
      if (k in existing) out[k] = existing[k]; // 保留原（密）值
      continue;
    }
    out[k] = v;
  }
  return out;
}
