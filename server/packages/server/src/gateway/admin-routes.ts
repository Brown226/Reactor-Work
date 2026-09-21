/**
 * 管理台 API（T3-1/T3-4）：模板化密钥 / Provider / Model 双层管理。
 * 鉴权由挂载方（identity authed 中间件）完成，这里仅校验 claims.role=platform_admin。
 * 错误格式与 identity 一致：{error:{code,message}}。
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import { maskFields, openFields, sealFields, sealSecret, secretFieldNames, stripMaskedFields } from "../common/secrets-crypto.js";
import { normalizePricing } from "../common/pricing.js";
import { toCatalogModel } from "./models.js";
import { findModelPreset, listModelPresets, MODEL_PRESET_SOURCE } from "./model-presets.js";
import {
  authHeadersFor,
  boardTestRequestFor,
  embeddingDimFromReply,
  normalizeApi,
  parseHeaders,
  rerankCountFromReply,
  PROVIDER_APIS_COMMON,
  PROVIDER_API_LABELS,
  testRequestFor,
  type ProviderApi,
} from "./provider-api.js";
import { deptsExist, parseScope } from "../common/scope.js";
import { recordAdminAction, resolveActorForClaims, type AdminActionEntry } from "../audit/repo.js";
import { listQuotaAlerts } from "../audit/repo.js";
import { parseVectorDim } from "./vector-dim.js";
import {
  isModelType,
  isModelTypeAvailable,
  MODEL_TYPE_LABEL,
  normalizeModelType,
  type ModelType,
} from "@reactor/shared";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

const iso = (v: Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/* ─────────────────── 配置快照（审计的「改前/删前快照」） ───────────────────
 *
 * 背景（2026-09-19）：供应商/模型的删除与修改**当时没有审计**，2 个供应商被删掉后
 * 既查不到是谁删的、也无从恢复（详见 admin-routes 里 providers.delete 的注释）。
 * 下面这几个小件就是为这个补的：删除存全量、修改存变动字段。
 *
 * ⚠ 两条红线：
 *   ① **密钥/令牌值绝不入快照** —— 供应商只记 `bindSecretId` 引用，不记密钥内容；
 *   ② 快照只记**结构化的业务字段**，不把整个 HTTP 请求体抄进去（里面可能有自定义头等任意内容）。
 */

/** 供应商快照（列名转成 camelCase，直接进 JSONB，事后看得懂也便于恢复） */
const PROVIDER_SNAPSHOT_SQL = `
  SELECT id, code, name, base_url AS "baseUrl", api, headers,
         bind_secret_id AS "bindSecretId", enabled, model_type AS "modelType", sort
    FROM ai_providers WHERE id = $1`;

/** 模型快照（按主键） */
const MODEL_SNAPSHOT_SQL = `
  SELECT id, provider_id AS "providerId", model, display_name AS "displayName",
         model_type AS "modelType", features, max_context AS "maxContext",
         max_output AS "maxOutput", pricing, currency, enabled, sort,
         scope_kind AS "scopeKind", scope_roles AS "scopeRoles",
         scope_dept_ids AS "scopeDeptIds", scope_uids AS "scopeUids"
    FROM ai_models WHERE id = $1`;

/** 模型快照（按供应商）—— 删供应商时用：级联会把它名下模型一起删掉 */
const MODELS_OF_PROVIDER_SNAPSHOT_SQL = MODEL_SNAPSHOT_SQL.replace('WHERE id = $1', 'WHERE provider_id = $1');

interface ProviderSnapshotRow {
  id: number;
  code: string;
  name: string | null;
  baseUrl: string | null;
  api: string | null;
  headers: unknown;
  bindSecretId: number | null;
  enabled: boolean;
  modelType: string | null;
  sort: number;
}

interface ModelSnapshotRow {
  id: number;
  providerId: number;
  model: string;
  displayName: string | null;
  modelType: string;
  features: unknown;
  maxContext: number | null;
  maxOutput: number | null;
  pricing: unknown;
  currency: string | null;
  enabled: boolean;
  sort: number;
  scopeKind: string;
  scopeRoles: string[];
  scopeDeptIds: number[];
  scopeUids: string[];
}

/**
 * 列出「改前→改后」真正变动的字段名（保持传入对象的键序，便于对比时眼睛能找到）。
 *
 * 用 `JSON.stringify` 比较而不是 `!==`：`headers`/`features`/`pricing` 这些是对象/数组，
 * 引用比较永远不等（会把「没改」误报成「改了」）；`bind_secret_id` 等标量走同一条路径也没问题。
 */
function diffFields(before: object | undefined, after: object | undefined): string[] {
  if (!before || !after) return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out.push(k);
  }
  return out;
}

/** 组装修改类审计的 details：只带变动字段的前后值 */
function buildChangeDetails(
  before: object | undefined,
  after: object | undefined,
): { changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = diffFields(before, after);
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const pick = (src: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const k of changed) o[k] = src[k] ?? null;
    return o;
  };
  return { changed, before: pick(b), after: pick(a) };
}

/** pricing 统一结构（四段价，¥/百万 tokens）；见 common/pricing.ts。 */
const normPricing = normalizePricing;

/** 从模板字段定义取敏感字段名（用于判断「密钥值是否变更」，不做值比较以外的事）。 */
const secretFieldNamesOf = (templateFields: unknown): string[] => secretFieldNames(templateFields);

/** 引用校验：给定的 secrets / providers id 必须存在。 */
async function refExists(db: IdentityDb, table: "secrets" | "ai_providers", id: number): Promise<boolean> {
  const { rows } = await db.pool.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  return rows.length > 0;
}

/** 动态拼 PATCH SET 子句（字段名固定白名单，值全部参数化）。 */
function buildPatch(fields: Array<[string, unknown]>): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of fields) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  return { sets, params };
}

/**
 * 解析「某 provider 的上游」：baseUrl + 解密后的 apiKey。
 *
 * 供「连通性测试」与「模型发现」共用，避开两处各写一份解密/校验导致行为漂移。
 * 语义与原连通性测试一致：
 *  - provider 不存在 → status 404（走 err 格式）
 *  - 其余失败 → status 200 + { ok:false, error }（测试/发现失败不是服务端错误，便于前端展示）
 *  - 错误信息脱敏：不回传上游响应体全文，也不回传密钥
 */
type UpstreamResolution =
  | { ok: true; code: string; baseUrl: string; target: URL; apiKey: string; api: ProviderApi; headers: Record<string, string> }
  | { ok: false; status: 404 | 200; code?: string; error: string };

async function resolveProviderUpstream(
  db: IdentityDb,
  providerId: number,
  secretKey: Buffer | null,
  override: { baseUrl?: unknown; bindSecretId?: unknown } = {},
): Promise<UpstreamResolution> {
  const { rows } = await db.pool.query<{
    code: string;
    base_url: string | null;
    api: string | null;
    headers: unknown;
    bind_secret_id: number | null;
    field_values: Record<string, unknown> | null;
    template_fields: unknown;
  }>(
    `SELECT p.code, p.base_url, p.api, p.headers, p.bind_secret_id, s.field_values, t.fields AS template_fields
     FROM ai_providers p
     LEFT JOIN secrets s ON s.id = p.bind_secret_id
     LEFT JOIN secret_templates t ON t.key = s.template_key
     WHERE p.id = $1 LIMIT 1`,
    [providerId],
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Provider 不存在" };

  const fail = (error: string): UpstreamResolution => ({ ok: false, status: 200, code: row.code, error });

  const baseUrl = (typeof override.baseUrl === "string" && override.baseUrl.trim() ? override.baseUrl.trim() : row.base_url) ?? "";
  if (!baseUrl) return fail("未填写 Base URL");
  let target: URL;
  try {
    target = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return fail("Base URL 非法");
  }
  // 只允许 http(s)：避免 file:// 等协议被当成上游地址
  if (target.protocol !== "http:" && target.protocol !== "https:") return fail("Base URL 只支持 http/https");

  // 允许用请求里的 bindSecretId 覆盖（未保存先试）；否则用库中绑定的密钥
  let fieldValues = row.field_values;
  let templateFields = row.template_fields;
  const overrideSecretId = typeof override.bindSecretId === "number" ? override.bindSecretId : undefined;
  if (overrideSecretId !== undefined && overrideSecretId !== row.bind_secret_id) {
    const { rows: srows } = await db.pool.query<{
      field_values: Record<string, unknown> | null;
      template_fields: unknown;
    }>(
      `SELECT s.field_values, t.fields AS template_fields
       FROM secrets s LEFT JOIN secret_templates t ON t.key = s.template_key
       WHERE s.id = $1 LIMIT 1`,
      [overrideSecretId],
    );
    if (srows.length === 0) return fail("指定的密钥不存在");
    fieldValues = srows[0]!.field_values;
    templateFields = srows[0]!.template_fields;
  }

  let apiKey = "";
  try {
    apiKey = String(openFields(fieldValues ?? {}, templateFields, secretKey).apiKey ?? "");
  } catch {
    return fail("密钥解密失败（主密钥不匹配或数据损坏），请重新录入密钥");
  }
  if (!apiKey) return fail("未绑定可用密钥（apiKey 为空），请先到「密钥托管」补全");

  const headersParsed = parseHeaders(row.headers);
  return {
    ok: true,
    code: row.code,
    baseUrl,
    target,
    apiKey,
    api: normalizeApi(row.api),
    headers: "headers" in headersParsed ? headersParsed.headers : {},
  };
}

/** 知识库检索配置（单例行 id=1）；字段见 admin-schema 的 kb_retrieval_config。 */
export interface KbRetrievalConfig {
  embeddingEnabled: boolean;
  embeddingModel: string | null;
  rerankEnabled: boolean;
  rerankModel: string | null;
}

/** 读单例配置。表缺失/行缺失都返回「全关」而不是抛错 —— 管理台不该因为读不到配置整页白屏。 */
export async function readKbRetrievalConfig(db: IdentityDb): Promise<KbRetrievalConfig> {
  try {
    const { rows } = await db.pool.query<{
      embedding_enabled: boolean;
      embedding_model: string | null;
      rerank_enabled: boolean;
      rerank_model: string | null;
    }>(
      `SELECT embedding_enabled, embedding_model, rerank_enabled, rerank_model FROM kb_retrieval_config WHERE id = 1`,
    );
    const r = rows[0];
    if (!r) return { embeddingEnabled: false, embeddingModel: null, rerankEnabled: false, rerankModel: null };
    return {
      embeddingEnabled: r.embedding_enabled,
      embeddingModel: r.embedding_model,
      rerankEnabled: r.rerank_enabled,
      rerankModel: r.rerank_model,
    };
  } catch {
    return { embeddingEnabled: false, embeddingModel: null, rerankEnabled: false, rerankModel: null };
  }
}

/**
 * 库内向量列的**实际**维度（`kb_segments.embedding` 的 `vector(N)`）。
 *
 * 为什么不信 `REACTOR_KB_EMBEDDING_DIM`：那个 env 只在**建表时**生效，
 * 表建好之后改它没有任何作用，读它会给出一个和库不一致的数字（正是要防的误判）。
 * 所以这里直接问 information_schema，拿不到（pgvector 不可用/列不存在）返回 null。
 */
async function currentVectorDim(db: IdentityDb): Promise<number | null> {
  try {
    const { rows } = await db.pool.query<{ full_type: string | null }>(
      // 用 format_type 而不是裸 atttypmod：pgvector 把维度**直接**存在 atttypmod 里
      // （vector(1024) → atttypmod=1024），而 varchar/numeric 那种自带 4 字节头的约定不适用。
      // 第一版写成 atttypmod-4，实测报出 1020，会让正确的 1024 维模型被维度闸门假拒绝。
      `SELECT format_type(atttypid, atttypmod) AS full_type
         FROM pg_attribute
        WHERE attrelid = 'kb_segments'::regclass AND attname = 'embedding' AND NOT attisdropped`,
    );
    return parseVectorDim(rows[0]?.full_type);
  } catch {
    return null;
  }
}

/**
 * 板块归属启发式（2026-09-19）：把从上游拉下来的模型名猜归五个板块。
 *
 * ## 为什么是「建议」而不是「结论」
 *
 * 上游 `/models` **不会**告诉你某个模型是嵌入还是重排（有些连能力字段都没有）。
 * 按名字猜一定会错（例：`gpt-4o-audio-preview` 是**对话**多模态模型，但名字里有 audio），
 * 所以它只用于**给界面一个默认勾选**，界面上标成「按名字推测」，用户可逐条改。
 * 推错也不会造成事故：导入时服务端还会按「供应商的板块」强制对齐（见 import 段）。
 *
 * 判定顺序很重要：先 embedding/rerank（专业词更明确），再 audio/image，
 * 最后落 chat —— 否则 `text-embedding-3-large` 里的 text 会先把 chat 命中。
 */
function suggestModelType(name: string): ModelType {
  const n = name.toLowerCase();
  if (/rerank|re-rank|cross-encoder|bge-reranker/.test(n)) return "rerank";
  if (/embed|bge-m3|text-embedding|(^|[-_/])gte-|-e5-|voyage/.test(n)) return "embedding";
  // audio：只在明确的语音语境命中（`gpt-4o-audio-preview` 那种对话多模态故意不命中）
  if (/(^|[-_/])(tts|asr|whisper|speech|voice|sovits)([-_/]|$)/.test(n)) return "audio";
  if (/dall-?e|stable-diffusion|(^|[-_/])sd[-_]?[0-9x]|flux|imagen|kolors|image-gen/.test(n)) return "image";
  return "chat";
}

export interface AdminRoutesOptions {
  /**
   * 密钥落盘主密钥（REACTOR_SECRET_KEY）。为 null 时降级为明文存储
   * （本地开发兜底；生产必须配置，否则密钥以明文落库）。
   */
  secretKey?: Buffer | null;
}

export function createAdminRoutes(db: IdentityDb, opts: AdminRoutesOptions = {}): Hono<AppEnv> {
  const admin = new Hono<AppEnv>();
  const secretKey = opts.secretKey ?? null;

  /**
   * 管理操作审计（密钥相关）：**谁在何时看过/改过密钥**必须留痕。
   * 摘要只描述动作与对象，**绝不写入密钥值**（值只以「已变更」表述）。
   */
  const audit = async (c: Ctx, entry: AdminActionEntry): Promise<void> => {
    const claims = c.get("claims");
    if (!claims?.sub) return;
    const actor = await resolveActorForClaims(db, claims);
    await recordAdminAction(db, actor, entry);
  };

  /** 取模板字段定义（决定哪些字段是敏感字段）。 */
  const templateFields = async (templateKey: string | null | undefined): Promise<unknown> => {
    if (!templateKey) return [];
    const { rows } = await db.pool.query<{ fields: unknown }>(
      `SELECT fields FROM secret_templates WHERE key = $1 LIMIT 1`,
      [templateKey],
    );
    return rows[0]?.fields ?? [];
  };

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") {
      // 越权尝试也要留痕（安全审计关心「谁试过」，不只是「谁做成了」）
      await audit(c, {
        op: "admin.denied",
        target: c.req.path,
        outcome: "denied",
        summary: `越权尝试：${c.req.method} ${c.req.path}（角色 ${c.get("claims")?.role ?? "未知"}）`,
        errorCode: "403",
      });
      return err(c, 403, "仅平台管理员可操作");
    }
    await next();
  };
  admin.use("/admin/*", requireAdmin);

  // ===== 密钥不再有模板（2026-09-19 用户口径：彻底简化）=====
  //
  // 原来这里有一套「密钥模板」：模板定义字段（哪些是敏感值）、模板可增删改启停、管理台据此渲染表单。
  // 用户口径：**没有必要针对密钥做单独的管理界面，直接集成到供应商配置里填写就行**。
  // 于是：
  //   · 模板的读写端点**全部下线**（本段原来那 5 个）；
  //   · 密钥字段定义退回成**代码里的常量**（见下方 PROVIDER_SECRET_TEMPLATE_KEY），
  //     它不再是「可管理的对象」，只是一个内部存储约定（加密需要知道哪个字段是敏感值）。
  //
  // 保留不动的部分（刻意）：`/admin/secrets` 的 CRUD 与 `secret_templates` 表。
  // 理由是它们是**加密落盘 / 掩码回显 / 密钥使用审计**这三条安全性质的回归网
  // （t34 的 A/A2 段、audit-smoke 都在打），删掉等于把安全网一起拆了；
  // 而它们对用户**不可见**（没有菜单、没有页面），与「不要单独的管理界面」不冲突。

  // ===== 密钥（secrets）=====
  // 读取：敏感字段一律以掩码返回，绝不下发明文/密文（T3-4 安全项）。
  admin.get("/admin/secrets", async (c) => {
    const { rows } = await db.pool.query<{
      id: number;
      name: string;
      template_key: string | null;
      field_values: Record<string, unknown> | null;
      enabled: boolean;
      created_at: Date;
      template_fields: unknown;
    }>(
      `SELECT s.id, s.name, s.template_key, s.field_values, s.enabled, s.created_at, t.fields AS template_fields
       FROM secrets s LEFT JOIN secret_templates t ON t.key = s.template_key
       ORDER BY s.id`,
    );
    // 敏感资源：连「谁看过密钥列表」也留痕（不看值，只记行为）
    await audit(c, { op: "secrets.list", summary: `查看密钥列表（${rows.length} 条，值均为掩码）` });
    return c.json({
      secrets: rows.map((r) => ({
        id: r.id,
        name: r.name,
        templateKey: r.template_key,
        fieldValues: maskFields(r.field_values ?? {}, r.template_fields),
        enabled: r.enabled,
        createdAt: iso(r.created_at),
      })),
    });
  });

  admin.post("/admin/secrets", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      templateKey?: string;
      fieldValues?: Record<string, unknown>;
      enabled?: boolean;
    } | null;
    if (!body?.name || typeof body.fieldValues !== "object" || body.fieldValues === null) {
      return err(c, 400, "name/fieldValues 必填");
    }
    if (body.templateKey) {
      const { rows } = await db.pool.query(`SELECT 1 FROM secret_templates WHERE key = $1 LIMIT 1`, [body.templateKey]);
      if (rows.length === 0) return err(c, 400, "模板不存在");
    }
    const fields = await templateFields(body.templateKey);
    // 敏感字段加密落盘（无主密钥时降级明文）
    const stored = secretKey ? sealFields(body.fieldValues, fields, secretKey) : body.fieldValues;
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO secrets (name, template_key, field_values, enabled) VALUES ($1, $2, $3, $4) RETURNING id`,
      [body.name, body.templateKey ?? null, JSON.stringify(stored), body.enabled ?? true],
    );
    await audit(c, {
      op: "secrets.create",
      target: `secrets:${rows[0]!.id}`,
      summary: `新建密钥「${body.name}」（模板 ${body.templateKey ?? "无"}）`,
    });
    return c.json({ id: rows[0]!.id }, 201);
  });

  admin.patch("/admin/secrets/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      templateKey?: string;
      fieldValues?: Record<string, unknown>;
      enabled?: boolean;
    } | null;
    if (!body) return err(c, 400, "请求体非法");

    let sealedValues: string | undefined;
    let secretValueChanged = false;
    if (body.fieldValues !== undefined) {
      const { rows: cur } = await db.pool.query<{ field_values: Record<string, unknown> | null; template_key: string | null }>(
        `SELECT field_values, template_key FROM secrets WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (cur.length === 0) return err(c, 404, "密钥不存在");
      const fields = await templateFields(body.templateKey ?? cur[0]!.template_key);
      // 客户端回传掩码 = 保持原值（否则掩码会覆盖真密钥）
      const merged = stripMaskedFields(body.fieldValues, cur[0]!.field_values ?? {}, fields);
      sealedValues = JSON.stringify(secretKey ? sealFields(merged, fields, secretKey) : merged);
      // 只判断「密钥值是否变了」，不记录值本身
      const before = (cur[0]!.field_values ?? {}) as Record<string, unknown>;
      const after = JSON.parse(sealedValues) as Record<string, unknown>;
      for (const k of secretFieldNamesOf(fields)) {
        if ((before[k] ?? null) !== (after[k] ?? null)) {
          secretValueChanged = true;
          break;
        }
      }
    }

    const { sets, params } = buildPatch([
      ["name", body.name],
      ["template_key", body.templateKey],
      ["field_values", sealedValues],
      ["enabled", body.enabled],
      ["updated_at", new Date()],
    ]);
    if (sets.length === 0) return err(c, 400, "无可更新字段");
    params.push(id);
    const { rowCount } = await db.pool.query(
      `UPDATE secrets SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
    if (!rowCount) return err(c, 404, "密钥不存在");
    await audit(c, {
      op: "secrets.update",
      target: `secrets:${id}`,
      summary: secretValueChanged
        ? "更新密钥：敏感字段**已变更**（值不记录）"
        : `更新密钥元数据（${body.name ? "名称" : ""}${body.enabled !== undefined ? " 启停" : ""}${body.fieldValues !== undefined ? " 字段" : ""}）`.trim(),
    });
    return c.json({ ok: true });
  });

  admin.delete("/admin/secrets/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const { rows: nameRows } = await db.pool.query<{ name: string }>(`SELECT name FROM secrets WHERE id = $1`, [id]);
    const { rowCount } = await db.pool.query(`DELETE FROM secrets WHERE id = $1`, [id]);
    if (!rowCount) return err(c, 404, "密钥不存在");
    await audit(c, { op: "secrets.delete", target: `secrets:${id}`, summary: `删除密钥「${nameRows[0]?.name ?? id}」` });
    return c.json({ ok: true });
  });

  // ===== Provider（ai_providers）=====
  /** P2：协议选项由服务端下发（前端不硬编一份枚举，避免两边漂移） */
  admin.get("/admin/provider-apis", (c) =>
    // 下发**界面选项**（PROVIDER_APIS_COMMON：auto + 三种常见协议），而不是校验全集 ——
    // 「能用哪些」与「界面提供哪些」是两件事：全集里的 google 保留只为历史行读写。
    c.json({ apis: PROVIDER_APIS_COMMON.map((value) => ({ value, label: PROVIDER_API_LABELS[value] })) }),
  );

  admin.get("/admin/providers", async (c) => {
    const { rows } = await db.pool.query<{
      id: number;
      code: string;
      name: string;
      base_url: string | null;
      api: string | null;
      headers: unknown;
      bind_secret_id: number | null;
      enabled: boolean;
      created_at: Date;
      model_type: string | null;
      sort: number;
    }>(`SELECT id, code, name, base_url, api, headers, bind_secret_id, enabled, created_at, model_type, sort FROM ai_providers ORDER BY model_type, sort, id`);
    return c.json({
      providers: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        baseUrl: r.base_url,
        /** 板块归属（对话/向量/重排…）：每个板块有专属供应商，左列表按它分栏 */
        modelType: normalizeModelType(r.model_type),
        sort: r.sort,
        /** P2：上游协议类型（auto=入站什么形态就发什么形态） */
        api: normalizeApi(r.api),
        /** P2：自定义出站头（已校验；不加密，不放密钥） */
        headers: (() => {
          const p = parseHeaders(r.headers);
          return "headers" in p ? p.headers : {};
        })(),
        bindSecretId: r.bind_secret_id,
        /**
         * 是否已配置 API Key（供界面显示「已配置·留空不改」）。
         *
         * 判据是 `bind_secret_id` 非空 —— 「绑定了密钥记录」即视为已配置，
         * **不去解密**（列表接口不该为了一个布尔值把每个密钥都解一遍，且解密失败时也无从展示）。
         * 代价：历史遗留的空值密钥记录会被报成「已配置」；平台侧实装时一键重填即可，
         * 不为此多查一次 secrets 表。
         */
        hasApiKey: r.bind_secret_id !== null,
        enabled: r.enabled,
        createdAt: iso(r.created_at),
      })),
    });
  });

  /**
   * 供应商 API Key 的**直填存储**（2026-09-19 用户口径：不要单独的密钥管理界面，在供应商里直接填）。
   *
   * ## 存储约定
   *
   * 仍然落 `secrets` 表（**加密落盘 / 掩码回显 / 使用审计**三条安全性质都在那条链路上，不动它），
   * 但 `template_key = NULL` —— 密钥字段定义**不再依赖模板表**：
   * `sealFields` 在字段定义为空时按字段名启发式判定敏感字段（`apiKey` 命中），
   * 所以「删掉模板」与「密钥仍然加密」可以同时成立。
   *
   * 为什么不做 `ai_providers.api_key_enc` 新列：那会多出**两条密钥读取路径**
   * （网关 registry 现在读 bind_secret_id），迁移与回退都要各写一遍；
   * 复用现有链路则改动为零风险，且旧数据（历史 secret）继续可用。
   */
  const saveProviderApiKey = async (
    c: Ctx,
    providerName: string,
    apiKey: string,
    existingSecretId: number | null,
  ): Promise<number> => {
    const sealed = secretKey ? sealSecret(apiKey, secretKey) : apiKey;
    if (existingSecretId !== null) {
      // 已有绑定：就地更新值（保留记录与审计线索，不新建）
      await db.pool.query(`UPDATE secrets SET field_values = $1::jsonb, updated_at = now() WHERE id = $2`, [
        JSON.stringify({ apiKey: sealed }),
        existingSecretId,
      ]);
      await audit(c, {
        op: "providers.apiKey.update",
        target: `providers:${providerName}`,
        summary: "更新供应商 API Key（值不记录）",
      });
      return existingSecretId;
    }
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO secrets (name, template_key, field_values, enabled) VALUES ($1, NULL, $2::jsonb, true) RETURNING id`,
      [`${providerName} · API Key`, JSON.stringify({ apiKey: sealed })],
    );
    await audit(c, {
      op: "providers.apiKey.create",
      target: `providers:${providerName}`,
      summary: "录入供应商 API Key（值不记录）",
    });
    return rows[0]!.id;
  };

  admin.post("/admin/providers", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      code?: string;
      name?: string;
      baseUrl?: string;
      api?: unknown;
      headers?: unknown;
      bindSecretId?: number | null;
      /**
       * API Key **直填**（推荐路径；`bindSecretId` 保留给内部/兼容用法）。
       * 语义：省略或空串 = 不设置；非空 = 录入（服务端加密后落 secrets 表，永不回传明文）。
       */
      apiKey?: unknown;
      enabled?: boolean;
      modelType?: unknown;
      sort?: number;
    } | null;
    if (!body?.code || !body.name || !body.baseUrl) return err(c, 400, "code/name/baseUrl 必填");
    // 板块校验：必须是五枚举之一，且**拒绝预留板块**（生图/语音的网关转发还没做，
    // 允许写入等于让用户配一个永远不生效的东西 —— 与界面上的「预留」标注一致）
    const type = body.modelType === undefined ? "chat" : body.modelType;
    if (!isModelType(type)) return err(c, 400, "modelType 非法（应为 chat/embedding/rerank/image/audio）");
    if (!isModelTypeAvailable(type)) {
      return err(c, 400, `「${MODEL_TYPE_LABEL[type]}」尚未接入（网关无对应转发链路），暂不能配置`);
    }
    if (body.bindSecretId != null && !(await refExists(db, "secrets", body.bindSecretId))) {
      return err(c, 400, "绑定的密钥不存在");
    }
    const headersParsed = parseHeaders(body.headers);
    if ("error" in headersParsed) return err(c, 400, headersParsed.error);
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() !== "" ? body.apiKey.trim() : null;
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO ai_providers (code, name, base_url, api, headers, bind_secret_id, enabled, model_type, sort) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING id`,
      [body.code, body.name, body.baseUrl, normalizeApi(body.api), JSON.stringify(headersParsed.headers), body.bindSecretId ?? null, body.enabled ?? true, type, body.sort ?? 0],
    );
    const providerId = rows[0]!.id;
    // 直填的 Key：供应商已落地，现在把密钥加密写进 secrets 并绑定（见 saveProviderApiKey）
    if (apiKey !== null) {
      const secretId = await saveProviderApiKey(c, body.name, apiKey, null);
      await db.pool.query(`UPDATE ai_providers SET bind_secret_id = $1, updated_at = now() WHERE id = $2`, [secretId, providerId]);
    }
    await audit(c, {
      op: "providers.create",
      target: `providers:${body.code}`,
      summary: `新增供应商（板块=${MODEL_TYPE_LABEL[type]}${apiKey !== null ? "，含 API Key" : ""}）`,
    });
    return c.json({ id: providerId }, 201);
  });

  admin.patch("/admin/providers/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => null)) as {
      code?: string;
      name?: string;
      baseUrl?: string;
      api?: unknown;
      headers?: unknown;
      bindSecretId?: number | null;
      /** API Key 直填：省略/空串 = 不动；非空 = 加密覆盖（见下方注释） */
      apiKey?: unknown;
      enabled?: boolean;
      modelType?: unknown;
      sort?: number;
    } | null;
    if (!body) return err(c, 400, "请求体非法");
    if (body.bindSecretId != null && !(await refExists(db, "secrets", body.bindSecretId))) {
      return err(c, 400, "绑定的密钥不存在");
    }
    // 改板块同样要过校验：否则可以把供应商挪进预留板块，绕过创建时的拦截
    if (body.modelType !== undefined) {
      if (!isModelType(body.modelType)) return err(c, 400, "modelType 非法（应为 chat/embedding/rerank/image/audio）");
      if (!isModelTypeAvailable(body.modelType)) {
        return err(c, 400, `「${MODEL_TYPE_LABEL[body.modelType as ModelType]}」尚未接入（网关无对应转发链路），暂不能配置`);
      }
    }
    let headersJson: string | undefined;
    if (body.headers !== undefined) {
      const parsed = parseHeaders(body.headers);
      if ("error" in parsed) return err(c, 400, parsed.error);
      headersJson = JSON.stringify(parsed.headers);
    }
    const { sets, params } = buildPatch([
      ["code", body.code],
      ["name", body.name],
      ["base_url", body.baseUrl],
      ["api", body.api === undefined ? undefined : normalizeApi(body.api)],
      ["headers", headersJson],
      ["bind_secret_id", body.bindSecretId],
      ["enabled", body.enabled],
      ["model_type", body.modelType === undefined ? undefined : (body.modelType as string)],
      ["sort", body.sort],
      ["updated_at", new Date()],
    ]);
    if (sets.length === 0 && typeof body.apiKey !== "string") return err(c, 400, "无可更新字段");
    /*
     * ⚠ 改前快照必须**在 UPDATE 之前**读。
     * 第一版把它写在了 UPDATE 之后（因为成文顺序，看着很自然）—— 于是 before 拿到的是**改后**的值，
     * `diffFields` 永远为空，`providers.update` 一条审计都不会落。
     * 实测发现：只能看到 create/delete，看不到 update（那正是本次要补的东西）。
     */
    const before = (await db.pool.query<ProviderSnapshotRow>(PROVIDER_SNAPSHOT_SQL, [id])).rows[0];
    let rowCount: number | null | undefined = 0;
    if (sets.length > 0) {
      params.push(id);
      ({ rowCount } = await db.pool.query(
        `UPDATE ai_providers SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params,
      ));
      if (!rowCount) return err(c, 404, "Provider 不存在");
    }
    /*
     * 供应商修改的改后快照（与模型同一口径：只记**变动字段**）：
     * ⚠ 快照里**没有 apiKey**（供应商行只存 `bind_secret_id` 引用）；密钥变更由
     * `providers.apiKey.create/update` 两条独立审计记录，且那两条也从不记值。
     */
    const newKey = typeof body.apiKey === "string" && body.apiKey.trim() !== "" ? body.apiKey.trim() : null;
    if (newKey !== null) {
      const secretId = await saveProviderApiKey(c, before?.name ?? `#${id}`, newKey, before?.bindSecretId ?? null);
      await db.pool.query(`UPDATE ai_providers SET bind_secret_id = $1, updated_at = now() WHERE id = $2`, [secretId, id]);
    }
    const after = (await db.pool.query<ProviderSnapshotRow>(PROVIDER_SNAPSHOT_SQL, [id])).rows[0];
    const changed = diffFields(before, after);
    // 只动过密钥（没有字段变化）时不再记一条「无字段变化」的噪声 —— 上面那条 apiKey 审计已经说明了
    if (changed.length > 0) {
      await audit(c, {
        op: "providers.update",
        target: `providers:${before?.code ?? id}`,
        summary: `修改供应商「${before?.name ?? id}」：${changed.join("/")}`,
        details: buildChangeDetails(before, after),
      });
    }
    return c.json({ ok: true });
  });

  admin.delete("/admin/providers/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    /*
     * 删前快照（2026-09-19）：供应商被删会**级联删掉它名下所有模型**（ai_models.provider_id 是
     * ON DELETE CASCADE），所以快照必须把模型一并存下来 —— 否则用户「只删了个供应商」，
     * 实际上丢的是整张模型表，而事后无从得知丢了什么。
     * 这里刻意记 `bindSecretId` 引用而不记密钥内容（密钥值永不入审计，同一红线）。
     */
    const before = (await db.pool.query<ProviderSnapshotRow>(PROVIDER_SNAPSHOT_SQL, [id])).rows[0];
    const models = (await db.pool.query<ModelSnapshotRow>(MODELS_OF_PROVIDER_SNAPSHOT_SQL, [id])).rows;
    const { rowCount } = await db.pool.query(`DELETE FROM ai_providers WHERE id = $1`, [id]);
    if (!rowCount) return err(c, 404, "Provider 不存在");
    await audit(c, {
      op: "providers.delete",
      target: `providers:${before?.code ?? id}`,
      summary: `删除供应商「${before?.name ?? id}」（连同名下 ${models.length} 个模型）`,
      details: { deleted: before ?? null, deletedModels: models },
    });
    return c.json({ ok: true });
  });

  /**
   * 连通性测试（对应供应商页「测试连接」）：用解密的密钥打一次上游 /models。
   * body 可传 { baseUrl?, bindSecretId? } 覆盖库中值 → 支持「未保存先试」。
   * 设计取舍：测试失败**不是**服务端错误，统一返回 200 + { ok:false, error }，便于前端展示；
   * 错误信息脱敏（不回传上游响应体全文，也不回传密钥）。
   */
  admin.post("/admin/providers/:id/test", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => null)) as {
      baseUrl?: unknown;
      bindSecretId?: unknown;
    } | null;

    const started = Date.now();
    const up = await resolveProviderUpstream(db, id, secretKey, body ?? {});
    if (!up.ok) {
      return up.status === 404
        ? err(c, 404, up.error)
        : c.json({ ok: false, code: up.code, error: up.error, latencyMs: Date.now() - started });
    }
    const { code, target, apiKey } = up;

    // 该接口会用**解密后的密钥**打上游 → 属于密钥使用行为，必须留痕（只记行为，不记值）
    await audit(c, {
      op: "secrets.use",
      target: `providers:${code}`,
      summary: `连通性测试：以解密后的密钥请求 ${target.toString()}`,
    });

    try {
      const res = await fetch(target, {
        // P2：按供应商声明的协议构造鉴权头（anthropic → x-api-key+version；google → x-goog-api-key；其余 Bearer）
        headers: { ...up.headers, ...authHeadersFor(up.api, apiKey), accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return c.json({
          ok: false,
          code,
          error: `上游返回 HTTP ${res.status}（请检查密钥与 Base URL；本次按协议「${up.api}」请求上游 /models）`,
          latencyMs,
        });
      }
      const payload = (await res.json().catch(() => null)) as { data?: unknown } | null;
      const ids = Array.isArray(payload?.data)
        ? payload.data
            .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
            .filter((v): v is string => typeof v === "string")
        : [];
      return c.json({
        ok: true,
        code,
        endpoint: target.toString(),
        modelCount: ids.length,
        sample: ids.slice(0, 8),
        latencyMs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = e instanceof DOMException && e.name === "TimeoutError";
      // 脱敏：只给结论与超时/网络类别，不回传原始错误细节
      console.warn(`[admin] provider#${id} 连通性测试失败：${msg}`);
      return c.json({
        ok: false,
        code,
        error: timeout ? "连接超时（10s）" : "无法连接上游（DNS/网络/证书问题，详见服务端日志）",
        latencyMs: Date.now() - started,
      });
    }
  });

  /**
   * 模型发现（P0）：用解密的密钥打上游 /models，返回**带完整元数据的候选清单**。
   *
   * 关键点：上游 /models 本身就带 context_length / max_completion_tokens /
   * supports_* / 四段价 —— 与运行时的 catalog 映射（models.ts 的 toCatalogModel）**同一函数**，
   * 所以「发现 → 导入」不会把元数据弄丢（而 ai_models 一旦非空，网关就从
   * 「透传上游」切成「以库为准」，元数据丢了会直接影响窗口钳制与计费）。
   *
   * 已入库的模型也返回（imported=true），便于前端展示"已存在"并支持重新拉取刷新元数据。
   */
  admin.post("/admin/providers/:id/discover", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const started = Date.now();
    const up = await resolveProviderUpstream(db, id, secretKey);
    if (!up.ok) {
      return up.status === 404
        ? err(c, 404, up.error)
        : c.json({ ok: false, code: up.code, error: up.error, latencyMs: Date.now() - started });
    }
    const { code, target, apiKey } = up;

    // 同样用了解密后的密钥 → 留痕（与连通性测试同一口径）
    await audit(c, {
      op: "secrets.use",
      target: `providers:${code}`,
      summary: `模型发现：以解密后的密钥请求 ${target.toString()}`,
    });

    try {
      const res = await fetch(target, {
        // P2：按供应商声明的协议构造鉴权头（anthropic → x-api-key+version；google → x-goog-api-key；其余 Bearer）
        headers: { ...up.headers, ...authHeadersFor(up.api, apiKey), accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return c.json({ ok: false, code, error: `上游返回 HTTP ${res.status}（请检查密钥与 Base URL）`, latencyMs });
      }
      const payload = (await res.json().catch(() => null)) as { data?: unknown } | null;
      const raw = Array.isArray(payload?.data) ? payload.data : [];
      const rowsRaw = raw.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object");
      const hasKey = (r: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(r, k);

      /** 上游某个字段“没给”（缺键或 null）时才用内置目录兜底，并记下来源 */
      const pick = <T>(key: string, up: T | null | undefined, pre: T | null, fromPreset: string[]): T | null => {
        if (up !== null && up !== undefined) return up;
        if (pre !== null && pre !== undefined) {
          fromPreset.push(key);
          return pre;
        }
        return null;
      };

      const found = rowsRaw.map((r) => {
        const m = toCatalogModel(r);
        const preset = findModelPreset(m.id);
        const fromPreset: string[] = [];
        const upstreamGaveMeta =
          m.contextWindow != null || m.maxTokens != null || m.inputPricePer1M != null;
        // 能力：上游只要声明过任意一个 supports_* 就以它为准（false 也算“上游说了没有”），
        // 否则用内置目录的能力标记兜底（⚠ 只有真的补上了才算「来自快照」，否则 mock-unknown 这种会被误标）
        const upstreamDeclaresFeatures = ["supports_tools", "supports_reasoning", "supports_anthropic", "supports_vision"].some(
          (k) => hasKey(r, k),
        );
        const features = upstreamDeclaresFeatures
          ? [
              m.supportsTools ? "tools" : "",
              m.supportsReasoning ? "reasoning" : "",
              m.supportsAnthropic ? "anthropic" : "",
              m.supportsVision ? "vision" : "",
            ].filter((f) => f !== "")
          : preset && preset.features.length > 0
            ? (fromPreset.push("能力"), preset.features)
            : [];
        const pricing = {
          inputPer1M: pick("价目", m.inputPricePer1M, preset?.pricing.inputPerM ?? null, fromPreset),
          outputPer1M: pick("价目", m.outputPricePer1M, preset?.pricing.outputPerM ?? null, fromPreset),
          cacheReadPer1M: pick("缓存读价", m.cacheReadPricePer1M, preset?.pricing.cacheReadPerM ?? null, fromPreset),
          cacheWritePer1M: pick("缓存写价", m.cacheWritePricePer1M, preset?.pricing.cacheWritePerM ?? null, fromPreset),
        };
        const metadataSource = upstreamGaveMeta
          ? fromPreset.length > 0
            ? "mixed"
            : "upstream"
          : fromPreset.length > 0
            ? "preset"
            : "none";
        return {
          ...m,
          contextWindow: pick("窗口", m.contextWindow, preset?.contextWindow ?? null, fromPreset),
          maxTokens: pick("最大输出", m.maxTokens, preset?.maxTokens ?? null, fromPreset),
          features,
          currency: pick("币种", m.currency, preset?.currency ?? null, fromPreset),
          inputPricePer1M: pricing.inputPer1M,
          outputPricePer1M: pricing.outputPer1M,
          cacheReadPricePer1M: pricing.cacheReadPer1M,
          cacheWritePricePer1M: pricing.cacheWritePer1M,
          /** upstream=全部来自上游 · mixed=上游缺的部分用内置快照补 · preset=上游什么都没给，全靠快照 · none=都没有 */
          metadataSource,
          presetFilledFields: fromPreset,
          /**
           * 按模型名推测的板块（**建议值**，不是结论）：界面据此默认勾选并标注，
           * 用户可逐条改；落库时仍按「供应商的板块」强制对齐（见 import 段）。
           */
          suggestedType: suggestModelType(m.id),
        };
      }).filter((m) => m.id.length > 0);

      const { rows: existing } = await db.pool.query<{ id: number; model: string; enabled: boolean }>(
        `SELECT id, model, enabled FROM ai_models WHERE provider_id = $1`,
        [id],
      );
      const byName = new Map(existing.map((r) => [r.model, r]));

      const models = found.map((m) => {
        const hit = byName.get(m.id);
        return {
          ...m,
          imported: Boolean(hit),
          rowId: hit?.id ?? null,
          enabled: hit?.enabled ?? null,
        };
      });

      return c.json({
        ok: true,
        code,
        endpoint: target.toString(),
        latencyMs,
        total: models.length,
        importedCount: models.filter((m) => m.imported).length,
        presetSource: MODEL_PRESET_SOURCE,
        models,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = e instanceof DOMException && e.name === "TimeoutError";
      console.warn(`[admin] provider#${id} 模型发现失败：${msg}`);
      return c.json({
        ok: false,
        code,
        error: timeout ? "连接超时（15s）" : "无法连接上游（DNS/网络/证书问题，详见服务端日志）",
        latencyMs: Date.now() - started,
      });
    }
  });

  // ===== Model（ai_models）=====

  /**
   * 内置模型目录（P1）：只读下发，供管理台「一键填充 / 撤销」。
   * 放在服务端是为了**单一事实源** —— 匹配逻辑（去 vendor 前缀、去日期后缀）不前后端各写一份。
   * 快照会过期，所以连 source 一起下发，UI 上会标注「来自内置快照」。
   */
  admin.get("/admin/model-presets", (c) =>
    c.json({
      source: MODEL_PRESET_SOURCE,
      presets: listModelPresets().map((p) => ({
        id: p.id,
        matchKeys: p.matchKeys,
        displayName: p.displayName,
        contextWindow: p.contextWindow,
        maxTokens: p.maxTokens,
        features: p.features,
        pricing: p.pricing,
        currency: p.currency,
      })),
    }),
  );
  admin.get("/admin/models", async (c) => {
    const { rows } = await db.pool.query<{
      id: number;
      provider_id: number;
      model: string;
      display_name: string | null;
      model_type: string;
      features: unknown;
      max_context: number | null;
      max_output: number | null;
      pricing: unknown;
      currency: string | null;
      scope_kind: string | null;
      scope_roles: string[] | null;
      scope_dept_ids: number[] | null;
      scope_uids: string[] | null;
      enabled: boolean;
      sort: number;
      params: unknown;
    }>(
      `SELECT id, provider_id, model, display_name, model_type, features, max_context, max_output, pricing, currency,
              scope_kind, scope_roles, scope_dept_ids, scope_uids, enabled, sort, params
       FROM ai_models ORDER BY sort, id`,
    );
    return c.json({
      models: rows.map((r) => ({
        id: r.id,
        providerId: r.provider_id,
        model: r.model,
        displayName: r.display_name,
        modelType: normalizeModelType(r.model_type),
        features: Array.isArray(r.features) ? r.features : [],
        maxContext: r.max_context,
        maxOutput: r.max_output,
        pricing: normPricing(r.pricing),
        currency: r.currency,
        /** 建库时钉死的参数（rerank 向量维度等）；界面只读展示，避免误改导致向量作废 */
        params: r.params && typeof r.params === "object" ? (r.params as Record<string, unknown>) : {},
        /** P2：可见范围（all/role/dept/user，命中任一即可见；口径同 skills/agents） */
        scope: {
          kind: r.scope_kind ?? "all",
          roles: Array.isArray(r.scope_roles) ? r.scope_roles : [],
          deptIds: Array.isArray(r.scope_dept_ids) ? r.scope_dept_ids : [],
          uids: Array.isArray(r.scope_uids) ? r.scope_uids : [],
        },
        enabled: r.enabled,
        sort: r.sort,
      })),
    });
  });

  admin.post("/admin/models", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      providerId?: number;
      model?: string;
      displayName?: string;
      modelType?: string;
      features?: string[];
      maxContext?: number | null;
      maxOutput?: number | null;
      pricing?: unknown;
      currency?: string | null;
      scope?: unknown;
      enabled?: boolean;
      sort?: number;
    } | null;
    if (!body?.providerId || !body.model) return err(c, 400, "providerId/model 必填");
    if (!(await refExists(db, "ai_providers", body.providerId))) return err(c, 400, "Provider 不存在");
    const sc = parseScope(body.scope);
    if ("error" in sc) return err(c, 400, sc.error);
    if (!(await deptsExist(db, sc.scope.deptIds))) return err(c, 400, "可见范围里的部门不存在");
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO ai_models (provider_id, model, display_name, model_type, features, max_context, max_output, pricing, enabled, sort, currency,
                              scope_kind, scope_roles, scope_dept_ids, scope_uids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14::int[], $15::text[]) RETURNING id`,
      [
        body.providerId,
        body.model,
        body.displayName ?? null,
        body.modelType ?? "chat",
        JSON.stringify(body.features ?? []),
        body.maxContext ?? null,
        body.maxOutput ?? null,
        JSON.stringify(normPricing(body.pricing)),
        body.enabled ?? true,
        body.sort ?? 0,
        typeof body.currency === "string" && body.currency.trim() ? body.currency.trim() : null,
        sc.scope.kind,
        sc.scope.roles,
        sc.scope.deptIds,
        sc.scope.uids,
      ],
    );
    // 新建也要留痕（与删除/修改同一口径）：记下新行快照，事后能看出「这条是什么时候冒出来的」
    const created = (await db.pool.query<ModelSnapshotRow>(MODEL_SNAPSHOT_SQL, [rows[0]!.id])).rows[0];
    await audit(c, {
      op: "models.create",
      target: `models:${rows[0]!.id}`,
      summary: `新增模型「${created?.model ?? body.model}」（供应商 #${body.providerId}）`,
      details: { created: created ?? null },
    });
    return c.json({ id: rows[0]!.id }, 201);
  });

  admin.patch("/admin/models/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => null)) as {
      providerId?: number;
      model?: string;
      displayName?: string;
      modelType?: string;
      features?: string[];
      maxContext?: number | null;
      maxOutput?: number | null;
      pricing?: unknown;
      currency?: string | null;
      scope?: unknown;
      enabled?: boolean;
      sort?: number;
    } | null;
    if (!body) return err(c, 400, "请求体非法");
    if (body.providerId != null && !(await refExists(db, "ai_providers", body.providerId))) {
      return err(c, 400, "Provider 不存在");
    }
    if (body.scope !== undefined) {
      const sc = parseScope(body.scope);
      if ("error" in sc) return err(c, 400, sc.error);
      if (!(await deptsExist(db, sc.scope.deptIds))) return err(c, 400, "可见范围里的部门不存在");
    }
    const { sets, params } = buildPatch([
      ["provider_id", body.providerId],
      ["model", body.model],
      ["display_name", body.displayName],
      ["model_type", body.modelType],
      ["features", body.features === undefined ? undefined : JSON.stringify(body.features)],
      ["max_context", body.maxContext],
      ["max_output", body.maxOutput],
      ["pricing", body.pricing === undefined ? undefined : JSON.stringify(normPricing(body.pricing))],
      ["currency", typeof body.currency === "string" && body.currency.trim() ? body.currency.trim() : undefined],
      ["scope_kind", body.scope === undefined ? undefined : (parseScope(body.scope) as { scope: { kind: string } }).scope.kind],
      ["scope_roles", body.scope === undefined ? undefined : (parseScope(body.scope) as { scope: { roles: string[] } }).scope.roles],
      ["scope_dept_ids", body.scope === undefined ? undefined : (parseScope(body.scope) as { scope: { deptIds: number[] } }).scope.deptIds],
      ["scope_uids", body.scope === undefined ? undefined : (parseScope(body.scope) as { scope: { uids: string[] } }).scope.uids],
      ["enabled", body.enabled],
      ["sort", body.sort],
      ["updated_at", new Date()],
    ]);
    if (sets.length === 0) return err(c, 400, "无可更新字段");
    /*
     * 改前快照（2026-09-19）：先把这一行读出来，改完再把**真正变动的字段**写进审计。
     * 为什么是「改动字段」而不是整行：审计只增不改，把整行反复写会迅速膨胀；
     * 而排查/回滚真正需要的只是「哪个字段从什么变成了什么」。
     */
    const before = (await db.pool.query<ModelSnapshotRow>(MODEL_SNAPSHOT_SQL, [id])).rows[0];
    params.push(id);
    const { rowCount } = await db.pool.query(
      `UPDATE ai_models SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
    if (!rowCount) return err(c, 404, "模型不存在");
    const after = (await db.pool.query<ModelSnapshotRow>(MODEL_SNAPSHOT_SQL, [id])).rows[0];
    await audit(c, {
      op: "models.update",
      target: `models:${id}`,
      summary: `修改模型「${before?.model ?? id}」：${diffFields(before, after).join("/") || "（无字段变化）"}`,
      details: buildChangeDetails(before, after),
    });
    return c.json({ ok: true });
  });

  admin.delete("/admin/models/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    // 删前先取全量快照：删掉之后就只剩这份记录了（人工恢复全靠它）
    const before = (await db.pool.query<ModelSnapshotRow>(MODEL_SNAPSHOT_SQL, [id])).rows[0];
    const { rowCount } = await db.pool.query(`DELETE FROM ai_models WHERE id = $1`, [id]);
    if (!rowCount) return err(c, 404, "模型不存在");
    await audit(c, {
      op: "models.delete",
      target: `models:${id}`,
      summary: `删除模型「${before?.model ?? id}」（供应商 #${before?.providerId ?? "?"}）`,
      details: { deleted: before ?? null },
    });
    return c.json({ ok: true });
  });

  /**
   * 批量导入模型（P0「模型发现」的落盘端）：单事务 upsert，按 (provider_id, model) 幂等。
   *
   * 更新语义（**不覆盖人工编辑**，只补空缺）：
   *  - display_name / max_context / max_output：仅当来值为空时保留库中旧值
   *  - features / pricing：仅当来值为空时保留旧值（非空则刷新，便于上游改了价目后重拉）
   *  - enabled / sort：**完全不动**（人工停用过的模型不会因重拉被重新启用）
   * 上限 500 条/次，避免一次请求写爆（也避免把上游返回的脏清单全量落库）。
   */
  admin.post("/admin/models/import", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      providerId?: unknown;
      models?: unknown;
    } | null;
    const providerId = typeof body?.providerId === "number" ? body.providerId : NaN;
    if (!Number.isInteger(providerId)) return err(c, 400, "providerId 必填");
    if (!Array.isArray(body?.models) || body.models.length === 0) return err(c, 400, "models 不能为空");
    if (body.models.length > 500) return err(c, 400, "一次最多导入 500 个模型");

    const { rows: prows } = await db.pool.query<{ code: string; model_type: string | null }>(
      `SELECT code, model_type FROM ai_providers WHERE id = $1`,
      [providerId],
    );
    const providerCode = prows[0]?.code;
    if (!providerCode) return err(c, 400, "Provider 不存在");
    /**
     * 板块对齐（2026-09-19 重构的关键一条）：**入库类型 = 供应商的类型**，不采信请求里带的 modelType。
     *
     * 为什么在服务端强制：板块是「这条上游干什么用」的属性，一个向量供应商下不可能同时有对话模型
     * （有的话它就该是两条供应商记录）。若采信前端传值，就会出现「对话板块的供应商挂了向量模型」，
     * 而网关按板块解析上游时又找不到它 —— 表现为「配了却用不上」，很难查。
     */
    const providerType = normalizeModelType(prows[0]?.model_type);

    type Incoming = {
      model?: unknown;
      displayName?: unknown;
      /** @deprecated 仅兼容旧调用方；落库一律用 providerType（见上方板块对齐） */
      modelType?: unknown;
      features?: unknown;
      maxContext?: unknown;
      maxOutput?: unknown;
      pricing?: unknown;
      currency?: unknown;
    };
    const items = (body.models as Incoming[]).filter((m) => m && typeof m === "object");
    const invalid = items.find((m) => typeof m.model !== "string" || !m.model.trim());
    if (invalid) return err(c, 400, "每个模型都必须带非空 model 字段");

    const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

    /**
     * 板块对齐的**收尾一步**：把「本供应商下类型 ≠ 本板块」的模型挪到对应的供应商去。
     *
     * 场景：gitee 原本只有一条 chat 供应商，用户从它拉过 Qwen3-Embedding-8B（当时类型是 chat）。
     * 现在拆出「向量板块」并新增一条 gitee(embedding) 后重拉 —— 上面那批 upsert 会先落到
     * **旧的 chat 供应商**（唯一约束是 provider_id+model 双键）。不 reconcile 的话，
     * 这条向量模型会永远躺在对话板块里，而且在向量板块怎么拉都「已入库」。
     *
     * 目标供应商的选取：本板块里**除自己以外**的第一条（按 sort, id）—— 与网关
     * 「板块内取第一条」的解析口径一致。只搬 AI_MODELS，不动供应商本身。
     */
    let added = 0;
    let updated = 0;
    let moved = 0;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");

      let sortCursor = 0;
      for (const m of items) {
        const features = Array.isArray(m.features) ? m.features.filter((f): f is string => typeof f === "string") : [];
        const pricing = normPricing(m.pricing);
        const currency = typeof m.currency === "string" && m.currency.trim() ? m.currency.trim() : null;
        const { rows } = await client.query<{ inserted: boolean }>(
          `INSERT INTO ai_models (provider_id, model, display_name, model_type, features, max_context, max_output, pricing, enabled, sort, currency)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, true, $9, $10)
           ON CONFLICT (provider_id, model) DO UPDATE SET
             display_name = COALESCE(EXCLUDED.display_name, ai_models.display_name),
             model_type   = COALESCE(EXCLUDED.model_type, ai_models.model_type),
             features     = CASE WHEN jsonb_array_length(EXCLUDED.features) > 0 THEN EXCLUDED.features ELSE ai_models.features END,
             max_context  = COALESCE(EXCLUDED.max_context, ai_models.max_context),
             max_output   = COALESCE(EXCLUDED.max_output, ai_models.max_output),
             pricing      = CASE WHEN (EXCLUDED.pricing->>'inputPerM') IS NOT NULL OR (EXCLUDED.pricing->>'outputPerM') IS NOT NULL
                                   OR (EXCLUDED.pricing->>'cacheReadPerM') IS NOT NULL OR (EXCLUDED.pricing->>'cacheWritePerM') IS NOT NULL
                              THEN EXCLUDED.pricing ELSE ai_models.pricing END,
             currency     = COALESCE(EXCLUDED.currency, ai_models.currency),
             updated_at   = now()
           RETURNING (xmax = 0) AS inserted`,
          [
            providerId,
            String(m.model).trim(),
            typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : null,
            providerType,
            JSON.stringify(features),
            numOrNull(m.maxContext),
            numOrNull(m.maxOutput),
            JSON.stringify(pricing),
            sortCursor++,
            currency,
          ],
        );
        if (rows[0]?.inserted) added += 1;
        else updated += 1;
      }

      /**
       * 板块对齐的**收尾一步**（必须在 upsert 之后）：清掉「同一个模型名、却留在别的板块」的陈旧行。
       *
       * 场景：gitee 原本只有 chat 一条供应商，用户从它拉过 Qwen3-Embedding-8B（当时类型 chat）。
       * 现在拆出「向量板块」并新增 gitee(embedding)，再从向量板块拉同一个模型 ——
       * upsert 的键是 (provider_id, model)，所以它会**新建**到本条供应商下（正确，在向量板块）；
       * 但旧的 chat 那份还在，于是向量模型同时出现在两个板块、且网关在对话链路上也可能选中它。
       *
       * 处置：当本板块还有**另一条**同类型供应商时，把别处（且类型不同的）同名行删掉，
       * 让「一个模型只归一个板块」。没有另一条同类型供应商时不删（那条就是唯一去处，删了就丢了）。
       */
      const names = items.map((m) => String(m.model).trim()).filter((n) => n.length > 0);
      if (names.length > 0) {
        const { rows: sameType } = await client.query<{ id: number }>(
          `SELECT id FROM ai_providers WHERE model_type = $1 AND id <> $2 ORDER BY sort, id LIMIT 1`,
          [providerType, providerId],
        );
        if (sameType.length > 0) {
          const { rowCount } = await client.query(
            `DELETE FROM ai_models m
                   USING ai_providers p
                   WHERE p.id = m.provider_id
                     AND m.model = ANY($1::text[])
                     AND m.provider_id <> $2
                     AND p.model_type <> $3`,
            [names, providerId, providerType],
          );
          moved = rowCount ?? 0;
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    await audit(c, {
      op: "models.import",
      target: `providers:${providerCode}`,
      summary: `批量导入模型（${MODEL_TYPE_LABEL[providerType]}）：新增 ${added} / 更新 ${updated}${moved > 0 ? ` / 归位 ${moved}` : ""}（共 ${items.length}）`,
    });
    return c.json({ ok: true, added, updated, moved, total: items.length });
  });

  /**
   * 单模型连通性测试（P1）：用该模型所属供应商的解密密钥，**发起一次最小真实调用**
   * （OpenAI 兼容 `/chat/completions`，\`max_tokens: 1\`）——它比「上游 /models 里有没有这个名字」
   * 更有意义：能真正暴露「密钥无效 / 模型名不对 / 上游不支持该形态 / 上游限流」。
   *
   * 取舍（写清以免被误用）：
   *  - 会**真实消耗少量 token**（约几个），UI 上会提示
   *  - Reactor 的 provider 不存「协议类型」字段（见 P2），这里固定按 OpenAI 兼容形态调；
   *    若上游只接受 anthropic-messages，会返回上游的 4xx，并在提示里说清本次用的形态
   *  - 失败同样返回 200 + { ok:false }（与供应商级测试同口径），错误信息脱敏：不回传上游响应体
   */
  admin.post("/admin/models/:id/test", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const { rows } = await db.pool.query<{
      model: string;
      provider_id: number | null;
      provider_code: string | null;
      model_type: string | null;
    }>(
      `SELECT m.model, m.provider_id, p.code AS provider_code, m.model_type
       FROM ai_models m LEFT JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.id = $1 LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) return err(c, 404, "模型不存在");
    const started = Date.now();
    if (!row.provider_id) {
      return c.json({ ok: false, model: row.model, error: "该模型未绑定供应商，无法测试", latencyMs: 0 });
    }

    const up = await resolveProviderUpstream(db, row.provider_id, secretKey);
    if (!up.ok) {
      return up.status === 404
        ? err(c, 404, up.error)
        : c.json({ ok: false, model: row.model, code: up.code, error: up.error, latencyMs: Date.now() - started });
    }
    /**
     * 按**板块**决定测试方式（2026-09-19）：
     *   · embedding → POST /embeddings（顺带实测向量维度）
     *   · rerank    → POST /rerank
     *   · 其它      → 走聊天的 testRequestFor（按供应商声明的协议选端点/形态）
     *
     * 不能一律用 chat 形态试：那会让向量/重排模型「测试必失败」，看起来像配错了。
     */
    const board = normalizeModelType(row.model_type);
    const isBoardSpecific = board === "embedding" || board === "rerank";
    const req_ = isBoardSpecific
      ? (() => {
          const r = boardTestRequestFor(board, up.baseUrl, row.model);
          return r.ok ? { ...r, shape: board === "embedding" ? "openai-embeddings" : "cohere-rerank" } : r;
        })()
      : testRequestFor(up.api, up.baseUrl, row.model);
    if (!req_.ok) {
      return c.json({ ok: false, model: row.model, code: up.code, providerApi: up.api, error: req_.reason, latencyMs: Date.now() - started });
    }
    const endpoint = req_.endpoint;

    await audit(c, {
      op: "secrets.use",
      target: `providers:${up.code}`,
      summary: `模型测试：以解密后的密钥请求 ${endpoint.toString()}（model=${row.model}）`,
    });

    const fail = (message: string, httpStatus?: number): Response =>
      c.json({
        ok: false,
        model: row.model,
        code: up.code,
        endpoint: endpoint.toString(),
        providerApi: up.api,
        shape: req_.shape,
        httpStatus,
        error: message,
        latencyMs: Date.now() - started,
      });

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${up.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(req_.body),
        signal: AbortSignal.timeout(20_000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        // 脱敏：只给状态码与可能原因，不回传上游响应体（可能含内部域名/额度信息）
        await res.text().catch(() => "");
        return fail(
          res.status === 401 || res.status === 403
            ? `上游返回 HTTP ${res.status}：密钥无效或无权限`
            : res.status === 404
              ? `上游返回 HTTP ${res.status}：模型名不存在或端点形态不对（本次按协议「${up.api}」打到 ${req_.endpoint.pathname}）`
              : `上游返回 HTTP ${res.status}（本次按协议「${up.api}」打到 ${req_.endpoint.pathname}）`,
          res.status,
        );
      }
      const payload = (await res.json().catch(() => null)) as { usage?: unknown; choices?: unknown; content?: unknown } | null;
      // 板块专用测试要回报「只能实测才知道的事实」
      const embeddingDim = board === "embedding" ? embeddingDimFromReply(payload) : null;
      const rerankCount = board === "rerank" ? rerankCountFromReply(payload) : null;
      const replied =
        board === "embedding"
          ? embeddingDim !== null && embeddingDim > 0
          : board === "rerank"
            ? rerankCount !== null
            : Array.isArray(payload?.choices)
              ? payload.choices.length > 0
              : Array.isArray(payload?.content)
                ? payload.content.length > 0
                : false;
      return c.json({
        ok: true,
        model: row.model,
        code: up.code,
        providerApi: up.api,
        endpoint: endpoint.toString(),
        shape: req_.shape,
        latencyMs,
        usage: payload?.usage ?? null,
        replied,
        /** 向量维度（embedding 测试才有）：落库前用它做「与库内维度是否一致」的判定 */
        ...(embeddingDim !== null ? { embeddingDim } : {}),
        ...(rerankCount !== null ? { rerankCount } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = e instanceof DOMException && e.name === "TimeoutError";
      console.warn(`[admin] model#${id} 连通性测试失败：${msg}`);
      return fail(timeout ? "连接超时（20s）" : "无法连接上游（DNS/网络/证书问题，详见服务端日志）");
    }
  });

  /**
   * 批量修改模型（P1）：启用/停用 + 改价（四段价/币种），也可改类型、能力、窗口。
   *
   * 约束（避免“批量”变成事故）：
   *  - 只允许改**安全字段**；不允许批量改 provider_id / model（改归属或改名请逐条做）
   *  - 单次最多 500 条；未传的字段=不改（不会把其它字段置空）
   *  - 单条 SQL 单事务完成，返回真实影响行数，并写 models.bulk_update 审计
   */
  admin.post("/admin/models/bulk-patch", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      ids?: unknown;
      enabled?: unknown;
      modelType?: unknown;
      features?: unknown;
      maxContext?: unknown;
      maxOutput?: unknown;
      pricing?: unknown;
      currency?: unknown;
    } | null;

    const ids = Array.isArray(body?.ids)
      ? (body.ids as unknown[]).filter((v): v is number => typeof v === "number" && Number.isInteger(v))
      : [];
    if (!body) return err(c, 400, "请求体非法");
    if (ids.length === 0) return err(c, 400, "ids 不能为空");
    if (ids.length > 500) return err(c, 400, "一次最多批量修改 500 条");

    const changed: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown, label: string): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
      changed.push(label);
    };

    if (typeof body.enabled === "boolean") push("enabled", body.enabled, body.enabled ? "启用" : "停用");
    if (typeof body.modelType === "string" && body.modelType.trim()) push("model_type", body.modelType.trim(), "类型");
    if (Array.isArray(body.features)) {
      push("features", JSON.stringify((body.features as unknown[]).filter((f): f is string => typeof f === "string")), "能力");
    }
    if (typeof body.maxContext === "number" || body.maxContext === null) push("max_context", body.maxContext ?? null, "窗口");
    if (typeof body.maxOutput === "number" || body.maxOutput === null) push("max_output", body.maxOutput ?? null, "最大输出");
    if (body.pricing !== undefined) {
      // 批量改价是**部分更新**：只合并传进来的段，未传的段保持原值
      // （用 JSONB || 合并而不是整段替换，否则「只改输入价」会把其它三段抹成 null）
      params.push(JSON.stringify(body.pricing ?? {}));
      sets.push(`pricing = COALESCE(ai_models.pricing, '{}'::jsonb) || $${params.length}::jsonb`);
      changed.push("价目");
    }
    if (typeof body.currency === "string" && body.currency.trim()) push("currency", body.currency.trim(), "币种");

    if (sets.length === 0) return err(c, 400, "没有要修改的字段");

    params.push(ids);
    const { rowCount } = await db.pool.query(
      `UPDATE ai_models SET ${sets.join(", ")}, updated_at = now() WHERE id = ANY($${params.length}::int[])`,
      params,
    );

    await audit(c, {
      op: "models.bulk_update",
      target: `models:${ids.length} 条`,
      summary: `批量修改模型：${changed.join("/")}（实际影响 ${rowCount ?? 0} 条）`,
    });
    return c.json({ ok: true, updated: rowCount ?? 0, changed });
  });

  // ===== 额度告警（M9）=====
  admin.get("/admin/quota-alerts", async (c) => {
    const period = c.req.query("period") ?? undefined;
    const data = await listQuotaAlerts(db, period);
    return c.json({ ...data, webhookConfigured: Boolean(process.env.REACTOR_QUOTA_WEBHOOK_URL) });
  });

  // ===== 知识库检索配置（KB 打通 · 2026-09-19）=====

  /** 读：当前生效的向量化/重排模型 + 实际来源（库配置 / env / 未配置） */
  admin.get("/admin/kb-retrieval", async (c) => {
    const cfg = await readKbRetrievalConfig(db);
    c.header("cache-control", "no-store"); // 单例配置：别让浏览器缓存住「改了没生效」的假象
    return c.json({
      /** 库里的配置原文（开关 + 模型名）；空模型表示「还没选」 */
      config: cfg,
      /**
       * 环境变量兜底值：库里没配时实际用的是它。
       * 界面上必须显示，否则会再次出现「管理台配了但没生效、也看不出为什么」。
       */
      env: {
        embeddingModel: process.env["REACTOR_KB_EMBED_MODEL"]?.trim() || null,
        rerankModel: process.env["REACTOR_KB_RERANK_MODEL"]?.trim() || null,
        gatewayConfigured: Boolean(
          (process.env["REACTOR_GATEWAY_TOKEN"] ?? process.env["REACTOR_DEV_TOKEN"])?.trim(),
        ),
      },
      /**
       * 生效值 = 库开关开且有模型 ? 库模型 : env。界面据此显示「在用」徽标。
       * ⚠ 装配是**启动时**完成的（embedder 在进程启动时构造），所以改完库配置需要
       * 重启 identity 才生效 —— 这一点在这里如实返回，不让界面假装热生效。
       */
      effective: {
        embeddingModel:
          cfg.embeddingEnabled && cfg.embeddingModel
            ? cfg.embeddingModel
            : process.env["REACTOR_KB_EMBED_MODEL"]?.trim() || null,
        rerankModel:
          cfg.rerankEnabled && cfg.rerankModel
            ? cfg.rerankModel
            : process.env["REACTOR_KB_RERANK_MODEL"]?.trim() || null,
        requiresRestart: true,
      },
      /** 建库时钉死的向量维度（kb_segments.embedding 的 vector(N)）：换模型维度不一致会作废整个库 */
      dim: await currentVectorDim(db),
    });
  });

  /**
   * 写：保存知识库检索配置。
   *
   * 校验（fail-closed，逐条都有理由）：
   *  ① 开关打开时**必须**选模型 —— 否则等于「开了但不知道用哪个」，会退回 env 造成困惑；
   *  ② 模型必须真实存在于**对应板块**的目录里（chat 模型不能拿来向量化）；
   *  ③ 换向量模型时**维度必须与库内一致** —— 维度不同意味着已入库向量全部作废，
   *     绝不能「保存成功、检索悄悄变差」。要么拒绝，要么提示需要重建（本轮选择拒绝）。
   */
  admin.patch("/admin/kb-retrieval", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      embeddingEnabled?: unknown;
      embeddingModel?: unknown;
      rerankEnabled?: unknown;
      rerankModel?: unknown;
      /** 维度实测值（由前端先调模型「测试」拿到 embeddingDim 再提交）：用于维度比对 */
      embeddingDim?: unknown;
    } | null;
    if (!body) return err(c, 400, "请求体非法");

    const embeddingEnabled = body.embeddingEnabled === true;
    const rerankEnabled = body.rerankEnabled === true;
    const embeddingModel = typeof body.embeddingModel === "string" && body.embeddingModel.trim() ? body.embeddingModel.trim() : null;
    const rerankModel = typeof body.rerankModel === "string" && body.rerankModel.trim() ? body.rerankModel.trim() : null;

    if (embeddingEnabled && embeddingModel === null) return err(c, 400, "启用向量化时必须选择一个向量模型");
    if (rerankEnabled && rerankModel === null) return err(c, 400, "启用重排序时必须选择一个重排序模型");

    // ② 模型必须在对应板块（跨板块会得到一个「配了却不生效」的库）
    if (embeddingModel !== null) {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ai_models WHERE model = $1 AND model_type = 'embedding'`,
        [embeddingModel],
      );
      if ((rows[0]?.n ?? 0) === 0) return err(c, 400, `「${embeddingModel}」不在向量模型目录里（请先在向量板块登记）`);
    }
    if (rerankModel !== null) {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ai_models WHERE model = $1 AND model_type = 'rerank'`,
        [rerankModel],
      );
      if ((rows[0]?.n ?? 0) === 0) return err(c, 400, `「${rerankModel}」不在重排序模型目录里（请先在重排序板块登记）`);
    }

    // ③ 维度闸门：换向量模型时必须与库内实际维度一致
    if (embeddingEnabled && embeddingModel !== null) {
      const dim = await currentVectorDim(db);
      const reported = typeof body.embeddingDim === "number" && Number.isInteger(body.embeddingDim) ? body.embeddingDim : null;
      if (dim !== null && reported !== null && reported !== dim) {
        return err(
          c,
          409,
          `该模型实测向量维度为 ${reported}，而知识库现有向量是 ${dim} 维 —— 直接切换会让已入库的向量全部不可用。` +
            `请改用 ${dim} 维的模型，或先重建向量列并重新向量化（属运维操作，本轮不在界面提供）。`,
        );
      }
    }

    await db.pool.query(
      `UPDATE kb_retrieval_config
          SET embedding_enabled = $1, embedding_model = $2, rerank_enabled = $3, rerank_model = $4,
              updated_at = now(), updated_by = $5
        WHERE id = 1`,
      [embeddingEnabled, embeddingModel, rerankEnabled, rerankModel, c.get("claims")?.sub ?? null],
    );
    await audit(c, {
      op: "kb.retrieval.update",
      target: "kb_retrieval_config:1",
      summary: `知识库检索配置：向量=${embeddingEnabled ? (embeddingModel ?? "-") : "关"} · 重排=${rerankEnabled ? (rerankModel ?? "-") : "关"}（需重启 identity 生效）`,
    });
    return c.json({ ok: true, requiresRestart: true });
  });

  return admin;
}
