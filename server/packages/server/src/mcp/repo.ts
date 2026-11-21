/**
 * 托管 MCP 注册表（治理平面 P0）：**SQL 层**。路由层管 HTTP，本文件只管 SQL——
 * 全参数化，跨模块（audit 组装、desktop/policy 下发）只从 `index.ts` 公开入口导入。
 *
 * 归属与写入者：唯一写入者是 identity 进程（管理台路由 + 手动同步）；
 * relay 只读（getRelayTarget）。服务端无多空间，表不带 workspace 维度（spec §2）。
 */

import { randomUUID } from "node:crypto";
import type { ManagedMcpServer } from "@reactor/shared";
import type { IdentityDb } from "../identity/db.js";
import { normalizeToolPolicy, type McpToolPolicy, type McpToolSnapshotEntry } from "./catalog.js";

/** 服务名与正则约束（schema 层 CHECK 的路由层前置，给可读文案）。 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** 库行形状（snake_case，与列一一对应）。 */
interface McpServerRow {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  url: string;
  auth: string;
  headers_ciphertext: Record<string, string> | null;
  header_names: Array<{ name: string; last4: string }> | null;
  enabled: boolean;
  tools_snapshot: unknown;
  tool_policy: unknown;
  synced_at: Date | null;
  sync_error: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/** 域内完整形状（camelCase；headers_ciphertext 只在服务端内存流转，绝不外出）。 */
export interface McpServerRecord {
  id: string;
  name: string;
  displayName: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  headersCiphertext: Record<string, string>;
  headerNames: Array<{ name: string; last4: string }>;
  enabled: boolean;
  toolsSnapshot: McpToolSnapshotEntry[];
  toolPolicy: Record<string, McpToolPolicy>;
  syncedAt: string | null;
  syncError: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

function rowToRecord(row: McpServerRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? "",
    type: row.type === "sse" ? "sse" : "http",
    url: row.url,
    auth: row.auth === "shared" ? "shared" : "none",
    headersCiphertext: isRecordMap(row.headers_ciphertext) ? row.headers_ciphertext : {},
    headerNames: Array.isArray(row.header_names)
      ? row.header_names.filter(
          (entry): entry is { name: string; last4: string } =>
            typeof entry?.name === "string" && typeof entry?.last4 === "string",
        )
      : [],
    enabled: row.enabled,
    toolsSnapshot: Array.isArray(row.tools_snapshot) ? (row.tools_snapshot as McpToolSnapshotEntry[]) : [],
    // 策略值逐项归一：脏值一律 ask（fail-closed，多问一次好过放行）
    toolPolicy: isRecordMap(row.tool_policy)
      ? Object.fromEntries(Object.entries(row.tool_policy).map(([k, v]) => [k, normalizeToolPolicy(v)]))
      : {},
    syncedAt: row.synced_at ? row.synced_at.toISOString() : null,
    syncError: row.sync_error,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function isRecordMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 管理台回显形状（无密文、无明文；headers 只回 名字+末四位）。 */
export interface McpServerPublic {
  id: string;
  name: string;
  displayName: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  headerNames: Array<{ name: string; last4: string }>;
  enabled: boolean;
  toolsSnapshot: McpToolSnapshotEntry[];
  toolPolicy: Record<string, McpToolPolicy>;
  syncedAt: string | null;
  syncError: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

function toPublic(record: McpServerRecord): McpServerPublic {
  const { headersCiphertext: _headers, ...rest } = record;
  return rest;
}

export async function listMcpServers(db: IdentityDb): Promise<McpServerPublic[]> {
  const { rows } = await db.pool.query<McpServerRow>(
    `SELECT * FROM mcp_server ORDER BY name ASC`,
  );
  return rows.map((row) => toPublic(rowToRecord(row)));
}

export async function getMcpServer(db: IdentityDb, id: string): Promise<McpServerRecord | null> {
  const { rows } = await db.pool.query<McpServerRow>(`SELECT * FROM mcp_server WHERE id = $1`, [id]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function getMcpServerByName(db: IdentityDb, name: string): Promise<McpServerRecord | null> {
  const { rows } = await db.pool.query<McpServerRow>(`SELECT * FROM mcp_server WHERE name = $1`, [name]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface McpServerCreateInput {
  name: string;
  displayName: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  /** 已封存的 header 值（调用方先用 sealSecret 封好；本层不接触明文） */
  headersCiphertext: Record<string, string>;
  headerNames: Array<{ name: string; last4: string }>;
  toolsSnapshot: McpToolSnapshotEntry[];
  toolPolicy: Record<string, McpToolPolicy>;
  createdBy: string;
}

export async function createMcpServer(db: IdentityDb, input: McpServerCreateInput): Promise<McpServerRecord> {
  const id = randomUUID();
  const { rows } = await db.pool.query<McpServerRow>(
    `INSERT INTO mcp_server
       (id, name, display_name, type, url, auth, headers_ciphertext, header_names,
        enabled, tools_snapshot, tool_policy, synced_at, sync_error, created_by, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, true, $9::jsonb, $10::jsonb, now(), NULL, $11, $11, now())
     RETURNING *`,
    [
      id,
      input.name,
      input.displayName,
      input.type,
      input.url,
      input.auth,
      JSON.stringify(input.headersCiphertext),
      JSON.stringify(input.headerNames),
      JSON.stringify(input.toolsSnapshot),
      JSON.stringify(input.toolPolicy),
      input.createdBy,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("mcp_server 插入后未返回行");
  return rowToRecord(row);
}

export interface McpServerPatchInput {
  displayName?: string;
  type?: "http" | "sse";
  url?: string;
  auth?: "none" | "shared";
  /** 已封存的 header 值；undefined = 不修改（掩码语义在路由层处理） */
  headersCiphertext?: Record<string, string>;
  headerNames?: Array<{ name: string; last4: string }>;
  enabled?: boolean;
  updatedBy: string;
}

/** PATCH 用 COALESCE 语义：只有传入的字段被更新（url/auth 变化触发重新 probe 的判断在路由层）。 */
export async function patchMcpServer(
  db: IdentityDb,
  id: string,
  input: McpServerPatchInput,
): Promise<McpServerRecord | null> {
  const { rows } = await db.pool.query<McpServerRow>(
    `UPDATE mcp_server SET
       display_name = COALESCE($2, display_name),
       type         = COALESCE($3, type),
       url          = COALESCE($4, url),
       auth         = COALESCE($5, auth),
       headers_ciphertext = COALESCE($6::jsonb, headers_ciphertext),
       header_names       = COALESCE($7::jsonb, header_names),
       enabled      = COALESCE($8, enabled),
       updated_by   = $9,
       updated_at   = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.displayName ?? null,
      input.type ?? null,
      input.url ?? null,
      input.auth ?? null,
      input.headersCiphertext ? JSON.stringify(input.headersCiphertext) : null,
      input.headerNames ? JSON.stringify(input.headerNames) : null,
      input.enabled ?? null,
      input.updatedBy,
    ],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function deleteMcpServer(db: IdentityDb, id: string): Promise<boolean> {
  const { rowCount } = await db.pool.query(`DELETE FROM mcp_server WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** 手动同步 / 登记时落快照与策略；成功清 sync_error，失败只记 sync_error（保旧快照）。 */
export async function saveSnapshot(
  db: IdentityDb,
  id: string,
  snapshot: McpToolSnapshotEntry[],
  policy: Record<string, McpToolPolicy>,
  syncError: string | null,
): Promise<void> {
  await db.pool.query(
    `UPDATE mcp_server SET
       tools_snapshot = $2::jsonb,
       tool_policy    = $3::jsonb,
       synced_at      = CASE WHEN $4::text IS NULL THEN now() ELSE synced_at END,
       sync_error     = $4,
       updated_at     = now()
     WHERE id = $1`,
    [id, JSON.stringify(snapshot), JSON.stringify(policy), syncError],
  );
}

/** 整体替换三档策略表（PUT 语义）；顺带清掉对应工具的 isNew（管理员改过即固化）。 */
export async function putToolPolicy(
  db: IdentityDb,
  id: string,
  policy: Record<string, McpToolPolicy>,
  updatedBy: string,
): Promise<McpServerRecord | null> {
  const { rows } = await db.pool.query<McpServerRow>(
    `UPDATE mcp_server SET
       tool_policy = $2::jsonb,
       tools_snapshot = CASE
         WHEN $2::jsonb = '{}'::jsonb THEN tools_snapshot
         ELSE (
           SELECT jsonb_agg(
             CASE
               WHEN entry->>'name' IS NOT NULL AND $2::jsonb ? entry->>'name'
                 THEN entry || '{"isNew": false}'::jsonb
                 ELSE entry
               END
             ORDER BY ord
           )
           FROM jsonb_array_elements(tools_snapshot) WITH ORDINALITY AS t(entry, ord)
         )
       END,
       updated_by = $3,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(policy), updatedBy],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function setMcpServerEnabled(
  db: IdentityDb,
  id: string,
  enabled: boolean,
  updatedBy: string,
): Promise<McpServerRecord | null> {
  const { rows } = await db.pool.query<McpServerRow>(
    `UPDATE mcp_server SET enabled = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, enabled, updatedBy],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * 下发形状（`GET /desktop/policy` 的 `managedMcp.servers[]`）。
 * 红线：**不含凭据、不含上游 url** —— 端侧只经 relay 调用（spec §3）。
 */
export function toManagedServer(record: McpServerRecord): ManagedMcpServer {
  return {
    id: record.id,
    name: record.name,
    ...(record.displayName ? { displayName: record.displayName } : {}),
    type: record.type,
    enabled: record.enabled,
    toolPolicy: record.toolPolicy,
    defaultToolPolicy: "ask",
    updatedAt: record.updatedAt,
  };
}

/** 下发面：全部托管服务（含停用的——端侧据 enabled 裁决，服务端不做第二套口径）。 */
export async function listManagedServers(db: IdentityDb): Promise<ManagedMcpServer[]> {
  const { rows } = await db.pool.query<McpServerRow>(`SELECT * FROM mcp_server ORDER BY name ASC`);
  return rows.map((row) => toManagedServer(rowToRecord(row)));
}

/** relay 目标（内部消费）：含封存 headers，只在 identity 进程内存解密。 */
export interface McpRelayTarget {
  record: McpServerRecord;
}

export async function getRelayTarget(db: IdentityDb, id: string): Promise<McpServerRecord | null> {
  return getMcpServer(db, id);
}
