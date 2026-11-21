/**
 * 审计落盘脱敏管道（治理吸收第二批，spec 见 docs/未完成-审计脱敏与审批版本联动-方案-v1.md §1A）。
 *
 * 为什么要有它：NFR-P-01（正文不落服务端）此前只靠「各域手写埋点自觉守红线」——
 * 调用方误把含密钥的快照粘进 details、或 summary 里带了 Bearer 令牌，都会原样落库。
 * 本管道在**唯一写入入口**（recordAdminAction / insertAuditBatch）机械执行：
 *   · 键名像凭据的项：键保留、值替换为占位符（保结构便于对照「哪个字段改了」）；
 *   · 值长得像凭据的（Bearer/sk-/JWT/PEM）：与键名无关，一律替换；
 *   · 字符串限长、顶层键限数、整体超限整体截断——审计行不该变成大对象仓库。
 *
 * 刻意不做深递归：details 的业务形状是 { changed/before/after/deleted } + 两层内的值，
 * 递归清洗既慢又可能把有意保留的结构打碎；两层深度覆盖现有全部调用方。
 */

/** 值里出现即脱敏的凭据形态（不区分键名——误传到任何字符串字段都不该落库）。 */
const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /sk-[A-Za-z0-9]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._~+/=-]{8,}/g, // JWT 三段式
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 键名命中即脱敏（大小写不敏感；覆盖 password/token/secret/credential/api-key/authorization 家族）。 */
const SENSITIVE_KEY_PATTERN = /password|passwd|token|secret|credential|api[_-]?key|authorization/i;

const MASKED = "[已脱敏]";
const VALUE_MAX_CHARS = 256;
const TOP_LEVEL_KEYS_MAX = 16;
const DETAILS_JSON_MAX_CHARS = 64 * 1024;

/** 字符串值脱敏 + 限长。 */
function sanitizeString(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    out = out.replace(pattern, MASKED);
  }
  if (out.length > VALUE_MAX_CHARS) {
    out = `${out.slice(0, VALUE_MAX_CHARS)}…`;
  }
  return out;
}

/** 键名是否命中凭据家族。 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** 二层内对象：逐键清洗（键命中→值打码；字符串值→脱敏限长；嵌套对象不再下钻，只做 JSON 限长）。 */
function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSensitiveKey(key)) {
      out[key] = MASKED;
      continue;
    }
    out[key] = sanitizeValue(value);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    return value.slice(0, TOP_LEVEL_KEYS_MAX).map((item) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? sanitizeRecord(item as Record<string, unknown>)
        : sanitizeValue(item),
    );
  }
  if (typeof value === "object" && value !== null) {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

/**
 * 清洗管理操作审计的 details：顶层键 ≤16 项，二层逐键清洗；
 * 序列化超限（>64KB）整体截断为 `{ truncated: true }`——审计行不背大对象。
 */
export function sanitizeAuditDetails(details: unknown): unknown {
  if (details === undefined || details === null) return details;
  let cleaned: unknown;
  if (typeof details !== "object" || details === null) {
    cleaned = sanitizeValue(details);
  } else {
    const record = details as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record).slice(0, TOP_LEVEL_KEYS_MAX)) {
      if (isSensitiveKey(key)) {
        out[key] = MASKED;
        continue;
      }
      out[key] = sanitizeValue(value);
    }
    cleaned = out;
  }
  try {
    if (JSON.stringify(cleaned).length > DETAILS_JSON_MAX_CHARS) {
      return { truncated: true };
    }
  } catch {
    return { truncated: true };
  }
  return cleaned;
}

/** summary 脱敏：只做值形态替换（summary 本身有 200 字硬校验，不需再限长）。 */
export function sanitizeAuditSummary(summary: string): string {
  return sanitizeString(summary);
}
