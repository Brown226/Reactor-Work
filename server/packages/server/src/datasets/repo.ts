/**
 * 公共知识库仓储（KB-⑥ 服务端）——建表 + CRUD + 可见性。
 *
 * 依据：`docs/实施计划/个人知识库-实施方案-v1.md` §KB-⑥（执行规格已定稿）。
 *
 * ## 三个关键设计（都不是随手定的）
 *
 * 1. **可见性复用 `visibilitySql`**（`common/scope.ts`）：与 skills / agents 同一口径
 *    （all / role / dept / user 四选一命中即可见），不另立一套。
 *    ⚠️ 该谓词**写死 `$1`=role、`$2`=deptId、`$3`=uid** —— 调用方拼 SQL 时这三者必须排在最前。
 *
 * 2. **向量列双写**：`embedding vector(dim)`（pgvector，供 SQL 侧 ANN）+ `embedding_json JSONB`
 *    （永远存在，是向量的**可携带真源**）。这样：
 *    - 有扩展 ⇒ SQL 侧 `<=>` 排序，快；
 *    - 没扩展 ⇒ 退化为 Node 内余弦（有上限），功能不消失、只是慢，并在 `/health` 如实标注。
 *    若只存 vector 列，一旦镜像退回官方 postgres，**已入库的向量会直接读不出来**。
 *
 * 3. **建表幂等**：`CREATE TABLE IF NOT EXISTS`，无迁移框架（照 `agents/repo.ts`）。
 *    `CREATE EXTENSION` 失败**不抛**（记 `vectorReady=false`）——它需要超级用户权限，
 *    在受限部署里失败是正常状态，不该让整个 identity 服务起不来。
 */

import type { IdentityDb } from "../identity/db.js";
import { visibilitySql, type ResourceScope, type ScopeKind } from "../common/scope.js";
import type { Role } from "../identity/users.js";

/** 请求者视角（与 skills / agents 的 viewer 同形） */
export interface KbViewer {
  readonly uid: string;
  readonly role: Role;
  readonly deptId: number | null;
}

/** 建表/探测结果（供 `/health` 与列表接口如实标注） */
export interface KbSchemaInfo {
  /** pgvector 是否可用（决定向量检索走 SQL 还是 Node 内余弦） */
  readonly vectorReady: boolean;
  /** 向量维度（建表时确定，之后不可变） */
  readonly dim: number;
}

/** 缺省向量维度（bge-m3 / text-embedding-3-* 常见口径；可用 env 覆盖，**只在建表时生效**） */
export const DEFAULT_EMBEDDING_DIM = 1024;

/** Node 内余弦回退的扫描上限（防一次把整库拉进内存） */
export const NODE_COSINE_SCAN_LIMIT = 5000;

export interface KbDatasetRow {
  id: number;
  name: string;
  description: string | null;
  scopeKind: ScopeKind;
  scopeRoles: string[];
  scopeDeptIds: number[];
  scopeUids: string[];
  createdBy: string | null;
  createdAt: string;
}

export interface KbDocumentRow {
  id: number;
  datasetId: number;
  name: string;
  source: string | null;
  addedBy: string | null;
  addedAt: string;
}

/** 检索用片段（含向量真源；`embedding` 为 undefined 表示未向量化） */
export interface KbSearchSegment {
  readonly id: number;
  readonly datasetId: number;
  readonly datasetName: string;
  readonly docName: string;
  readonly position: number;
  readonly content: string;
  readonly embedding?: readonly number[];
}

/** 带 SQL 侧相似度的片段（`score` 仅在 `vectorSearchSql` 里出现） */
export interface KbScoredSegment extends KbSearchSegment {
  readonly score?: number;
}

/** 探测 pgvector 是否可用（缺省 false —— 不假装已启用） */
export async function probeVectorSupport(db: IdentityDb): Promise<boolean> {
  try {
    const { rows } = await db.pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 建表（幂等）。返回向量可用性与维度 —— 调用方应把它透出到 `/health`。
 *
 * 顺序：先尝试装扩展（失败只记不抛）→ 建 4 张表 → 扩展可用时补向量列与 HNSW 索引。
 */
export async function ensureDatasetsSchema(
  db: IdentityDb,
  opts: { dim?: number } = {},
): Promise<KbSchemaInfo> {
  const dim = Number(opts.dim ?? process.env["REACTOR_KB_EMBEDDING_DIM"] ?? DEFAULT_EMBEDDING_DIM);
  const safeDim = Number.isInteger(dim) && dim > 0 && dim <= 4096 ? dim : DEFAULT_EMBEDDING_DIM;

  // ① 扩展：需要超级用户；失败属正常态（受限部署），不抛
  try {
    await db.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch {
    /* 记在返回值里，不阻断启动 */
  }
  const vectorReady = await probeVectorSupport(db);

  // ② 库 / 文档 / 成员（与向量无关，永远建）
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS kb_datasets (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      scope_kind TEXT NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all','role','dept','user')),
      scope_roles TEXT[] NOT NULL DEFAULT '{}',
      scope_dept_ids INT[] NOT NULL DEFAULT '{}',
      scope_uids TEXT[] NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kb_documents (
      id BIGSERIAL PRIMARY KEY,
      dataset_id BIGINT NOT NULL REFERENCES kb_datasets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT,
      added_by TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kb_members (
      dataset_id BIGINT NOT NULL REFERENCES kb_datasets(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reader',
      added_by TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (dataset_id, uid)
    );
    CREATE INDEX IF NOT EXISTS kb_documents_dataset ON kb_documents(dataset_id);
  `);

  // ③ 片段表：向量列按扩展可用性决定（扩展不可用时建普通表，向量真源在 embedding_json）
  if (vectorReady) {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS kb_segments (
        id BIGSERIAL PRIMARY KEY,
        dataset_id BIGINT NOT NULL REFERENCES kb_datasets(id) ON DELETE CASCADE,
        document_id BIGINT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        position INT NOT NULL,
        content TEXT NOT NULL,
        embedding_json JSONB,
        embedding vector(${safeDim}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS kb_segments_dataset ON kb_segments(dataset_id);
    `);
    /**
     * ★ 补列：`CREATE TABLE IF NOT EXISTS` **不会**给已存在的表加列 ——
     * 而"先在没有 pgvector 的镜像上跑过、之后换成 pgvector 镜像"是**真实会发生的路径**
     * （本次就是：表先在官方 postgres 上建好，换镜像后 `embedding` 列不存在，
     * 插入直接 `42703 column "embedding" does not exist`）。
     * 探针 kb-server-smoke 抓到了它。这里用幂等 ALTER 兜住，无需迁移框架。
     */
    await db.pool.query(`ALTER TABLE kb_segments ADD COLUMN IF NOT EXISTS embedding vector(${safeDim})`);
    // HNSW：仅在扩展可用时建（否则语法直接报错）
    try {
      await db.pool.query(
        "CREATE INDEX IF NOT EXISTS kb_segments_hnsw ON kb_segments USING hnsw (embedding vector_cosine_ops)",
      );
    } catch {
      /* 某些 pgvector 版本不支持 hnsw 或数据量不足；退化为顺序扫描，不影响正确性 */
    }
  } else {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS kb_segments (
        id BIGSERIAL PRIMARY KEY,
        dataset_id BIGINT NOT NULL REFERENCES kb_datasets(id) ON DELETE CASCADE,
        document_id BIGINT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        position INT NOT NULL,
        content TEXT NOT NULL,
        embedding_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS kb_segments_dataset ON kb_segments(dataset_id);
    `);
  }

  // ④ 用户侧扩展（v2，2026-09-19「都搬」拍板）：文件上传/标签/广场审核/加入申请。
  //    老库靠幂等 ALTER 补列 —— 与上面 embedding 补列同一纪律。
  await db.pool.query(`
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS stored_path TEXT;
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS file_name TEXT;
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS file_size BIGINT;
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS file_type TEXT;
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'completed';
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS parse_error TEXT;
    ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE kb_datasets  ADD COLUMN IF NOT EXISTS square_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE kb_datasets  ADD COLUMN IF NOT EXISTS square_reject_reason TEXT;
    CREATE TABLE IF NOT EXISTS kb_applications (
      id BIGSERIAL PRIMARY KEY,
      dataset_id BIGINT NOT NULL REFERENCES kb_datasets(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (dataset_id, uid)
    );
    CREATE INDEX IF NOT EXISTS kb_documents_tags ON kb_documents USING gin (tags);
    CREATE TABLE IF NOT EXISTS kb_files (
      id BIGSERIAL PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_size BIGINT NOT NULL,
      file_type TEXT,
      stored_path TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      parse_status TEXT NOT NULL DEFAULT 'completed',
      parse_error TEXT,
      extracted_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  return { vectorReady, dim: safeDim };
}

// ─────────────────────────────────────────────────────────────────────────────
// 可见性（应用层）——与 SQL 层 `visibilitySql` 同一口径的**读集合**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 当前调用者可见的库 id 集合。
 *
 * 为什么要这一层（而不是只靠 SQL）：检索请求带 `datasetIds`，**必须先裁到可见集合**
 * （红线 ①：不合法即剔除并告警）；SQL 层再套一次 `visibilitySql` 做纵深防御（红线 ②）。
 */
export async function visibleDatasetIds(db: IdentityDb, viewer: KbViewer): Promise<number[]> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM kb_datasets d WHERE ${visibilitySql({
      kind: "d.scope_kind",
      roles: "d.scope_roles",
      deptIds: "d.scope_dept_ids",
      uids: "d.scope_uids",
    })}`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows.map((r) => Number(r.id));
}

/** 可见库列表（含统计；管理台列表用） */
export async function listVisibleDatasets(
  db: IdentityDb,
  viewer: KbViewer,
): Promise<Array<KbDatasetRow & { documentCount: number; segmentCount: number }>> {
  const { rows } = await db.pool.query(
    `SELECT d.id, d.name, d.description, d.scope_kind, d.scope_roles, d.scope_dept_ids, d.scope_uids,
            d.created_by, d.created_at,
            COALESCE(dc.n, 0)::int AS document_count,
            COALESCE(sc.n, 0)::int AS segment_count
       FROM kb_datasets d
       LEFT JOIN (SELECT dataset_id, COUNT(*) n FROM kb_documents GROUP BY dataset_id) dc ON dc.dataset_id = d.id
       LEFT JOIN (SELECT dataset_id, COUNT(*) n FROM kb_segments  GROUP BY dataset_id) sc ON sc.dataset_id = d.id
      WHERE ${visibilitySql({
        kind: "d.scope_kind",
        roles: "d.scope_roles",
        deptIds: "d.scope_dept_ids",
        uids: "d.scope_uids",
      })}
      ORDER BY d.id ASC`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows.map(mapDatasetRow);
}

function mapDatasetRow(r: Record<string, unknown>): KbDatasetRow & { documentCount: number; segmentCount: number } {
  return {
    id: Number(r["id"]),
    name: String(r["name"]),
    description: (r["description"] as string | null) ?? null,
    scopeKind: r["scope_kind"] as ScopeKind,
    scopeRoles: (r["scope_roles"] as string[] | null) ?? [],
    scopeDeptIds: (r["scope_dept_ids"] as number[] | null) ?? [],
    scopeUids: (r["scope_uids"] as string[] | null) ?? [],
    createdBy: (r["created_by"] as string | null) ?? null,
    createdAt: toIso(r["created_at"]),
    documentCount: Number(r["document_count"] ?? 0),
    segmentCount: Number(r["segment_count"] ?? 0),
  };
}

/** pg 的 TIMESTAMPTZ 在 node-postgres 里是 Date；统一成 ISO 串（接口层不吐 Date 对象） */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : "";
}

export async function findDataset(db: IdentityDb, id: number): Promise<KbDatasetRow | null> {
  const { rows } = await db.pool.query(
    `SELECT id, name, description, scope_kind, scope_roles, scope_dept_ids, scope_uids, created_by, created_at
       FROM kb_datasets WHERE id = $1`,
    [id],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const mapped = mapDatasetRow({ ...row, document_count: 0, segment_count: 0 });
  return mapped;
}

/** 调用者是否有该库的写权限（平台管理员 / 库 owner） */
export async function canWriteDataset(db: IdentityDb, viewer: KbViewer, datasetId: number): Promise<boolean> {
  if (viewer.role === "platform_admin") return true;
  const { rows } = await db.pool.query<{ role: string }>(
    "SELECT role FROM kb_members WHERE dataset_id = $1 AND uid = $2",
    [datasetId, viewer.uid],
  );
  const role = rows[0]?.role;
  return role === "owner" || role === "writer";
}

// ─────────────────────────────────────────────────────────────────────────────
// 写：库 / 文档 / 成员
// ─────────────────────────────────────────────────────────────────────────────

export async function createDataset(
  db: IdentityDb,
  input: { name: string; description?: string | null; scope: ResourceScope; createdBy: string },
): Promise<number> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO kb_datasets (name, description, scope_kind, scope_roles, scope_dept_ids, scope_uids, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.name,
      input.description ?? null,
      input.scope.kind,
      input.scope.roles,
      input.scope.deptIds,
      input.scope.uids,
      input.createdBy,
    ],
  );
  const id = Number(rows[0]?.id);
  // 创建人 = 天然的 owner 成员：不登记的话，canWriteDataset 会把建库人自己拒之门外
  await db.pool.query(
    `INSERT INTO kb_members (dataset_id, uid, role, added_by) VALUES ($1, $2, 'owner', $2) ON CONFLICT (dataset_id, uid) DO NOTHING`,
    [id, input.createdBy],
  );
  return id;
}

export async function updateDatasetScope(
  db: IdentityDb,
  id: number,
  patch: { name?: string; description?: string | null; scope?: ResourceScope },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  if (patch.scope !== undefined) {
    params.push(patch.scope.kind, patch.scope.roles, patch.scope.deptIds, patch.scope.uids);
    const base = params.length - 3;
    sets.push(`scope_kind = $${base}`, `scope_roles = $${base + 1}`, `scope_dept_ids = $${base + 2}`, `scope_uids = $${base + 3}`);
  }
  if (sets.length === 0) return;
  params.push(id);
  await db.pool.query(`UPDATE kb_datasets SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

export async function deleteDataset(db: IdentityDb, id: number): Promise<boolean> {
  const res = await db.pool.query("DELETE FROM kb_datasets WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * 落一篇文档 + 它的片段（一个事务）。
 *
 * 向量同时写 `embedding_json`（真源）与 `embedding`（可用时）；未向量化时两列都留空 ——
 * 词法检索照样能命中它（与端上「未配置即纯词法」同口径）。
 * `file*`/`storedPath`/`parseStatus` 是**文件上传链路**的字段（贴文本入库时全部缺省）。
 */
export async function addDocument(
  db: IdentityDb,
  input: {
    datasetId: number;
    name: string;
    source?: string | null;
    addedBy: string;
    segments: ReadonlyArray<{ position: number; text: string; embedding?: readonly number[] }>;
    vectorReady: boolean;
    fileName?: string | null;
    fileSize?: number | null;
    fileType?: string | null;
    storedPath?: string | null;
    parseStatus?: "completed" | "failed";
    parseError?: string | null;
  },
): Promise<{ documentId: number; segmentCount: number }> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const doc = await client.query<{ id: string }>(
      `INSERT INTO kb_documents (dataset_id, name, source, added_by, file_name, file_size, file_type, stored_path, parse_status, parse_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        input.datasetId,
        input.name,
        input.source ?? null,
        input.addedBy,
        input.fileName ?? null,
        input.fileSize ?? null,
        input.fileType ?? null,
        input.storedPath ?? null,
        input.parseStatus ?? "completed",
        input.parseError ?? null,
      ],
    );
    const documentId = Number(doc.rows[0]?.id);
    for (const seg of input.segments) {
      const json = seg.embedding === undefined ? null : JSON.stringify(seg.embedding);
      if (input.vectorReady && seg.embedding !== undefined) {
        await client.query(
          `INSERT INTO kb_segments (dataset_id, document_id, position, content, embedding_json, embedding)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)`,
          [input.datasetId, documentId, seg.position, seg.text, json, `[${seg.embedding.join(",")}]`],
        );
      } else {
        await client.query(
          `INSERT INTO kb_segments (dataset_id, document_id, position, content, embedding_json)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [input.datasetId, documentId, seg.position, seg.text, json],
        );
      }
    }
    await client.query("COMMIT");
    return { documentId, segmentCount: input.segments.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function listDocuments(db: IdentityDb, datasetId: number): Promise<KbDocumentRow[]> {
  const { rows } = await db.pool.query(
    `SELECT id, dataset_id, name, source, added_by, added_at FROM kb_documents WHERE dataset_id = $1 ORDER BY id ASC`,
    [datasetId],
  );
  return rows.map((r) => ({
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    name: String(r["name"]),
    source: (r["source"] as string | null) ?? null,
    addedBy: (r["added_by"] as string | null) ?? null,
    addedAt: toIso(r["added_at"]),
  }));
}

export async function deleteDocument(db: IdentityDb, datasetId: number, documentId: number): Promise<boolean> {
  const res = await db.pool.query("DELETE FROM kb_documents WHERE dataset_id = $1 AND id = $2", [datasetId, documentId]);
  return (res.rowCount ?? 0) > 0;
}

export async function listMembers(
  db: IdentityDb,
  datasetId: number,
): Promise<Array<{ uid: string; role: string; addedBy: string | null; addedAt: string }>> {
  const { rows } = await db.pool.query(
    "SELECT uid, role, added_by, added_at FROM kb_members WHERE dataset_id = $1 ORDER BY uid ASC",
    [datasetId],
  );
  return rows.map((r) => ({
    uid: String(r["uid"]),
    role: String(r["role"]),
    addedBy: (r["added_by"] as string | null) ?? null,
    addedAt: toIso(r["added_at"]),
  }));
}

export async function upsertMember(
  db: IdentityDb,
  datasetId: number,
  uid: string,
  role: "owner" | "writer" | "reader",
  addedBy: string,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO kb_members (dataset_id, uid, role, added_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (dataset_id, uid) DO UPDATE SET role = EXCLUDED.role`,
    [datasetId, uid, role, addedBy],
  );
}

export async function removeMember(db: IdentityDb, datasetId: number, uid: string): Promise<boolean> {
  const res = await db.pool.query("DELETE FROM kb_members WHERE dataset_id = $1 AND uid = $2", [datasetId, uid]);
  return (res.rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 读：检索素材
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取候选片段（检索用）。
 *
 * ⚠️ **SQL 层可见性（红线 ②）**：这里除了按 `datasetIds` 过滤，还再套一层 `visibilitySql`
 * —— 纵深防御。应用层已经裁过一次，但那层若有 bug（或将来被绕过），SQL 这层仍然拦得住。
 * 故 role/deptId/uid 必须排在前三个参数位（谓词写死了 `$1~$3`）。
 */
export async function loadSearchSegments(
  db: IdentityDb,
  viewer: KbViewer,
  datasetIds: readonly number[],
  limit = NODE_COSINE_SCAN_LIMIT,
): Promise<KbSearchSegment[]> {
  const { rows } = await db.pool.query(
    `SELECT s.id, s.dataset_id, s.position, s.content, s.embedding_json,
            d.name AS dataset_name, doc.name AS doc_name
       FROM kb_segments s
       JOIN kb_datasets d   ON d.id = s.dataset_id
       JOIN kb_documents doc ON doc.id = s.document_id
      WHERE ${visibilitySql({
        kind: "d.scope_kind",
        roles: "d.scope_roles",
        deptIds: "d.scope_dept_ids",
        uids: "d.scope_uids",
      })}
        AND s.dataset_id = ANY($4::bigint[])
      ORDER BY s.id ASC
      LIMIT $5`,
    [viewer.role, viewer.deptId, viewer.uid, datasetIds, Math.max(1, Math.floor(limit))],
  );
  return rows.map((r) => ({
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    datasetName: String(r["dataset_name"]),
    docName: String(r["doc_name"]),
    position: Number(r["position"]),
    content: String(r["content"]),
    ...(parseEmbeddingJson(r["embedding_json"]) === undefined
      ? {}
      : { embedding: parseEmbeddingJson(r["embedding_json"]) as readonly number[] }),
  }));
}

/** `embedding_json` 可能是 JSONB（已解析对象）或 TEXT（串）——两种都容错 */
function parseEmbeddingJson(v: unknown): readonly number[] | undefined {
  if (v === null || v === undefined) return undefined;
  const arr = typeof v === "string" ? safeParseArray(v) : v;
  if (!Array.isArray(arr)) return undefined;
  const nums = arr.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return nums.length === arr.length && nums.length > 0 ? nums : undefined;
}

function safeParseArray(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * SQL 侧向量检索（pgvector 可用时走这条）。
 *
 * `embedding <=> $n` 是余弦距离（越小越近）⇒ 分数取 `1 - distance`，与 Node 内余弦同向
 * （**越大越相关**，与 `RetrievalHit.score` 的约定一致）。
 */
export async function vectorSearchSql(
  db: IdentityDb,
  viewer: KbViewer,
  datasetIds: readonly number[],
  queryVector: readonly number[],
  topK: number,
): Promise<KbScoredSegment[]> {
  const { rows } = await db.pool.query(
    `SELECT s.id, s.dataset_id, s.position, s.content, s.embedding_json,
            d.name AS dataset_name, doc.name AS doc_name,
            1 - (s.embedding <=> $4::vector) AS score
       FROM kb_segments s
       JOIN kb_datasets d   ON d.id = s.dataset_id
       JOIN kb_documents doc ON doc.id = s.document_id
      WHERE ${visibilitySql({
        kind: "d.scope_kind",
        roles: "d.scope_roles",
        deptIds: "d.scope_dept_ids",
        uids: "d.scope_uids",
      })}
        AND s.dataset_id = ANY($5::bigint[])
        AND s.embedding IS NOT NULL
      ORDER BY s.embedding <=> $4::vector ASC
      LIMIT $6`,
    [viewer.role, viewer.deptId, viewer.uid, `[${queryVector.join(",")}]`, datasetIds, Math.max(1, Math.floor(topK))],
  );
  return rows.map((r) => ({
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    datasetName: String(r["dataset_name"]),
    docName: String(r["doc_name"]),
    position: Number(r["position"]),
    content: String(r["content"]),
    ...(typeof r["score"] === "number" ? { score: r["score"] } : {}),
  }));
}

/** 库统计（列表接口用） */
export async function datasetStats(
  db: IdentityDb,
  datasetId: number,
): Promise<{ documents: number; segments: number }> {
  const { rows } = await db.pool.query<{ documents: string; segments: string }>(
    `SELECT (SELECT COUNT(*) FROM kb_documents WHERE dataset_id = $1) AS documents,
            (SELECT COUNT(*) FROM kb_segments  WHERE dataset_id = $1) AS segments`,
    [datasetId],
  );
  return { documents: Number(rows[0]?.documents ?? 0), segments: Number(rows[0]?.segments ?? 0) };
}

// ═════════════════════════════════════════════════════════════════════════════
// 用户侧扩展（v2「都搬」）：文件上传 / 分页清单 / 批量文档操作 / 标签 / 广场审核 / 申请
//
// 这些查询全部走 `visibilitySql` 或「创建人/成员」判定 —— 治理口径不因为「用户侧」放松：
// 员工能看到的仍然是 scope 允许的那部分，能改的仍然只有自己创建/owner 的库。
// ═════════════════════════════════════════════════════════════════════════════

export interface KbDocumentFullRow {
  id: number;
  datasetId: number;
  name: string;
  source: string | null;
  addedBy: string | null;
  addedAt: string;
  fileName: string | null;
  fileSize: number | null;
  fileType: string | null;
  parseStatus: "completed" | "failed";
  parseError: string | null;
  tags: string[];
  segmentCount: number;
}

function mapDocumentFull(r: Record<string, unknown>): KbDocumentFullRow {
  return {
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    name: String(r["name"]),
    source: (r["source"] as string | null) ?? null,
    addedBy: (r["added_by"] as string | null) ?? null,
    addedAt: toIso(r["added_at"]),
    fileName: (r["file_name"] as string | null) ?? null,
    fileSize: r["file_size"] === null || r["file_size"] === undefined ? null : Number(r["file_size"]),
    fileType: (r["file_type"] as string | null) ?? null,
    parseStatus: (r["parse_status"] as "completed" | "failed") ?? "completed",
    parseError: (r["parse_error"] as string | null) ?? null,
    tags: (r["tags"] as string[] | null) ?? [],
    segmentCount: Number(r["segment_count"] ?? 0),
  };
}

const DOC_SELECT = `
  SELECT d.id, d.dataset_id, d.name, d.source, d.added_by, d.added_at,
         d.file_name, d.file_size, d.file_type, d.parse_status, d.parse_error, d.tags,
         (SELECT COUNT(*) FROM kb_segments s WHERE s.document_id = d.id) AS segment_count
    FROM kb_documents d`;

/** 文档分页清单（带关键词/标签/解析状态过滤 —— 上游无限滚动按页拉） */
export async function listDocumentsPaged(
  db: IdentityDb,
  viewer: KbViewer,
  datasetId: number,
  opts: { page?: number; pageSize?: number; keyword?: string; tag?: string; parseStatus?: string } = {},
): Promise<{ items: KbDocumentFullRow[]; total: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  // 可见性谓词固定占用 $1~$3（见 common/scope.ts），所以本查询自身的过滤条件必须从 **$4** 起编号。
  //
  // ⚠ 这里曾把过滤条件从 $1 编号，而参数数组是 [...visParams, ...params] —— 于是 $1 实际绑成
  //   角色字符串，去和 bigint 的 d.dataset_id 比较，PG 报 42883「operator does not exist:
  //   bigint = text」，文档清单接口 100% 返回 500（kb-server-smoke 在 37 项断言后红在这一步）。
  //   同文件 loadSearchSegments() 一直是正确写法（$4/$5），可作对照。
  const FILTER_BASE = 3;
  const filters: { sql: string; value: unknown }[] = [];
  const addFilter = (render: (ph: number) => string, value: unknown): void => {
    filters.push({ sql: render(filters.length + FILTER_BASE + 1), value });
  };
  addFilter((ph) => `d.dataset_id = $${ph}`, datasetId);
  if (opts.keyword && opts.keyword.trim()) addFilter((ph) => `d.name ILIKE $${ph}`, `%${opts.keyword.trim()}%`);
  if (opts.tag && opts.tag.trim()) addFilter((ph) => `$${ph} = ANY(d.tags)`, opts.tag.trim());
  if (opts.parseStatus === "completed" || opts.parseStatus === "failed") {
    addFilter((ph) => `d.parse_status = $${ph}`, opts.parseStatus);
  }
  // 可见性：文档属于库，库不可见则文档也不可见（复用同一谓词，参数位固定 $1~$3）
  const visParams: unknown[] = [viewer.role, viewer.deptId, viewer.uid];
  const filterValues = filters.map((f) => f.value);
  // 列表与计数共用同一个 WHERE：计数也带可见性谓词 —— 与列表同口径，且守住「SQL 层过滤」
  // 这条红线（路由层已先判库可见；这里再来一层，绕过应用层时 total 也不会泄露不可见库的规模）。
  const whereSql = `WHERE ${filters.map((f) => f.sql).join(" AND ")}
       AND EXISTS (SELECT 1 FROM kb_datasets k WHERE k.id = d.dataset_id AND ${visibilitySql({
         kind: "k.scope_kind",
         roles: "k.scope_roles",
         deptIds: "k.scope_dept_ids",
         uids: "k.scope_uids",
       })})`;
  const { rows } = await db.pool.query(
    `${DOC_SELECT} ${whereSql}
     ORDER BY d.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    [...visParams, ...filterValues],
  );
  const totalRes = await db.pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM kb_documents d ${whereSql}`,
    [...visParams, ...filterValues],
  );
  return { items: rows.map(mapDocumentFull), total: Number(totalRes.rows[0]?.n ?? 0) };
}

export async function getDocumentFull(db: IdentityDb, datasetId: number, documentId: number): Promise<KbDocumentFullRow | null> {
  const { rows } = await db.pool.query(`${DOC_SELECT} WHERE d.id = $1 AND d.dataset_id = $2`, [documentId, datasetId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : mapDocumentFull(row);
}

/** 批量删除文档（含其片段，外键 CASCADE） */
export async function deleteDocumentsBatch(db: IdentityDb, datasetId: number, documentIds: number[]): Promise<number> {
  if (documentIds.length === 0) return 0;
  const res = await db.pool.query("DELETE FROM kb_documents WHERE dataset_id = $1 AND id = ANY($2::bigint[])", [
    datasetId,
    documentIds,
  ]);
  return res.rowCount ?? 0;
}

/** 批量复制文档到另一个库（连同片段一起复制，向量化状态跟随目标库能力） */
export async function copyDocumentsBatch(
  db: IdentityDb,
  fromDatasetId: number,
  toDatasetId: number,
  documentIds: number[],
): Promise<number> {
  if (documentIds.length === 0) return 0;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const docId of documentIds) {
      const doc = await client.query(`SELECT name, source, added_by, file_name, file_size, file_type, parse_status, parse_error, tags
                                        FROM kb_documents WHERE id = $1 AND dataset_id = $2`, [docId, fromDatasetId]);
      const d = doc.rows[0] as Record<string, unknown> | undefined;
      if (d === undefined) continue;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO kb_documents (dataset_id, name, source, added_by, file_name, file_size, file_type, parse_status, parse_error, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [toDatasetId, d["name"], d["source"], d["added_by"], d["file_name"], d["file_size"], d["file_type"], d["parse_status"], d["parse_error"], d["tags"]],
      );
      const newId = Number(inserted.rows[0]?.id);
      await client.query(
        `INSERT INTO kb_segments (dataset_id, document_id, position, content, embedding_json, embedding)
         SELECT $1, $2, position, content, embedding_json, embedding
           FROM kb_segments WHERE document_id = $3`,
        [toDatasetId, newId, docId],
      );
    }
    await client.query("COMMIT");
    return documentIds.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 批量移动 = 复制后删源（同一事务里做，避免半移动状态） */
export async function moveDocumentsBatch(
  db: IdentityDb,
  fromDatasetId: number,
  toDatasetId: number,
  documentIds: number[],
): Promise<number> {
  const n = await copyDocumentsBatch(db, fromDatasetId, toDatasetId, documentIds);
  await deleteDocumentsBatch(db, fromDatasetId, documentIds);
  return n;
}

export async function updateDocumentTags(db: IdentityDb, datasetId: number, documentId: number, tags: string[]): Promise<void> {
  await db.pool.query("UPDATE kb_documents SET tags = $1 WHERE id = $2 AND dataset_id = $3", [
    tags.map((t) => t.trim()).filter(Boolean),
    documentId,
    datasetId,
  ]);
}

export async function batchAddDocumentTags(db: IdentityDb, datasetId: number, documentIds: number[], tags: string[]): Promise<number> {
  if (documentIds.length === 0 || tags.filter(Boolean).length === 0) return 0;
  const res = await db.pool.query(
    `UPDATE kb_documents SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(tags || $1::text[]) AS t)
      WHERE dataset_id = $2 AND id = ANY($3::bigint[])`,
    [tags.map((t) => t.trim()).filter(Boolean), datasetId, documentIds],
  );
  return res.rowCount ?? 0;
}

/** 库内出现过的标签（供筛选下拉） */
export async function listDatasetTags(db: IdentityDb, viewer: KbViewer): Promise<string[]> {
  const { rows } = await db.pool.query(
    `SELECT DISTINCT unnest(d.tags) AS tag
       FROM kb_documents d
       JOIN kb_datasets k ON k.id = d.dataset_id
      WHERE ${visibilitySql({ kind: "k.scope_kind", roles: "k.scope_roles", deptIds: "k.scope_dept_ids", uids: "k.scope_uids" })}
      ORDER BY tag ASC`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows.map((r) => String(r["tag"])).filter(Boolean);
}

/** 广场状态机（none/pending/approved/rejected） */
export async function setSquareStatus(
  db: IdentityDb,
  datasetId: number,
  status: "none" | "pending" | "approved" | "rejected",
  rejectReason?: string | null,
): Promise<void> {
  await db.pool.query("UPDATE kb_datasets SET square_status = $1, square_reject_reason = $2 WHERE id = $3", [
    status,
    rejectReason ?? null,
    datasetId,
  ]);
}

/** 广场清单：只出 approved 的库（分页；scope 过滤仍然生效 —— 上架 ≠ 全员可读） */
export async function listSquareDatasetsPaged(
  db: IdentityDb,
  viewer: KbViewer,
  opts: { page?: number; pageSize?: number; keyword?: string } = {},
): Promise<{ items: Array<KbDatasetRow & { documentCount: number; segmentCount: number }>; total: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  const params: unknown[] = [viewer.role, viewer.deptId, viewer.uid];
  let kw = "";
  if (opts.keyword && opts.keyword.trim()) {
    params.push(`%${opts.keyword.trim()}%`);
    kw = ` AND k.name ILIKE $${params.length}`;
  }
  const vis = visibilitySql({ kind: "k.scope_kind", roles: "k.scope_roles", deptIds: "k.scope_dept_ids", uids: "k.scope_uids" });
  const base = `FROM kb_datasets k
       LEFT JOIN (SELECT dataset_id, COUNT(*) n FROM kb_documents GROUP BY dataset_id) dc ON dc.dataset_id = k.id
       LEFT JOIN (SELECT dataset_id, COUNT(*) n FROM kb_segments  GROUP BY dataset_id) sc ON sc.dataset_id = k.id
      WHERE k.square_status = 'approved' AND ${vis}${kw}`;
  const { rows } = await db.pool.query(
    `SELECT k.id, k.name, k.description, k.scope_kind, k.scope_roles, k.scope_dept_ids, k.scope_uids,
            k.created_by, k.created_at,
            COALESCE(dc.n,0)::int AS document_count, COALESCE(sc.n,0)::int AS segment_count
       ${base} ORDER BY k.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  const total = await db.pool.query<{ n: string }>(`SELECT COUNT(*) AS n ${base}`, params);
  return { items: rows.map(mapDatasetRow), total: Number(total.rows[0]?.n ?? 0) };
}

/** 分页清单：created = 我创建的；team = 我是成员或按部门/角色发给我的（全员的不在此列，在广场） */
export async function listDatasetsPaged(
  db: IdentityDb,
  viewer: KbViewer,
  kind: "created" | "team",
  opts: { page?: number; pageSize?: number; keyword?: string } = {},
): Promise<{ items: Array<KbDatasetRow & { documentCount: number; segmentCount: number }>; total: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  const params: unknown[] = [viewer.role, viewer.deptId, viewer.uid];
  let extra = "";
  if (kind === "created") {
    params.push(viewer.uid);
    extra = ` AND k.created_by = $${params.length}`;
  } else {
    params.push(viewer.uid);
    extra = ` AND (EXISTS (SELECT 1 FROM kb_members m WHERE m.dataset_id = k.id AND m.uid = $${params.length})
               OR k.scope_kind = 'dept' OR k.scope_kind = 'role')`;
  }
  let kw = "";
  if (opts.keyword && opts.keyword.trim()) {
    params.push(`%${opts.keyword.trim()}%`);
    kw = ` AND k.name ILIKE $${params.length}`;
  }
  const vis = visibilitySql({ kind: "k.scope_kind", roles: "k.scope_roles", deptIds: "k.scope_dept_ids", uids: "k.scope_uids" });
  const base = `FROM kb_datasets k
       LEFT JOIN (SELECT dataset_id, COUNT(*) n FROM kb_documents GROUP BY dataset_id) dc ON dc.dataset_id = k.id
       LEFT JOIN (SELECT dataset_id, COUNT(*) n FROM kb_segments  GROUP BY dataset_id) sc ON sc.dataset_id = k.id
      WHERE ${vis}${extra}${kw}`;
  const { rows } = await db.pool.query(
    `SELECT k.id, k.name, k.description, k.scope_kind, k.scope_roles, k.scope_dept_ids, k.scope_uids,
            k.created_by, k.created_at,
            COALESCE(dc.n,0)::int AS document_count, COALESCE(sc.n,0)::int AS segment_count
       ${base} ORDER BY k.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  const total = await db.pool.query<{ n: string }>(`SELECT COUNT(*) AS n ${base}`, params);
  return { items: rows.map(mapDatasetRow), total: Number(total.rows[0]?.n ?? 0) };
}

// ── 加入申请 / 审核 ─────────────────────────────────────────────────────────

export interface KbApplicationRow {
  id: number;
  datasetId: number;
  datasetName?: string;
  uid: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  createdAt: string;
}

function mapApplication(r: Record<string, unknown>): KbApplicationRow {
  return {
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    datasetName: (r["dataset_name"] as string | null) ?? undefined,
    uid: String(r["uid"]),
    reason: (r["reason"] as string | null) ?? null,
    status: r["status"] as "pending" | "approved" | "rejected",
    reviewedBy: (r["reviewed_by"] as string | null) ?? null,
    createdAt: toIso(r["created_at"]),
  };
}

export async function createApplication(db: IdentityDb, datasetId: number, uid: string, reason?: string | null): Promise<void> {
  await db.pool.query(
    `INSERT INTO kb_applications (dataset_id, uid, reason) VALUES ($1, $2, $3)
     ON CONFLICT (dataset_id, uid) DO UPDATE SET status = 'pending', reason = EXCLUDED.reason, reviewed_by = NULL, reviewed_at = NULL`,
    [datasetId, uid, reason ?? null],
  );
}

/** 申请清单：管理员看全部；普通用户只看「自己创建的库」收到的申请（审批权与写权限同源） */
export async function listApplications(
  db: IdentityDb,
  viewer: KbViewer,
  opts: { datasetId?: number; status?: "pending" | "approved" | "rejected" } = {},
): Promise<KbApplicationRow[]> {
  const where: string[] = [];
  const params: unknown[] = [viewer.role, viewer.deptId, viewer.uid];
  if (viewer.role !== "platform_admin") {
    params.push(viewer.uid);
    where.push(`k.created_by = $${params.length}`);
  }
  if (opts.datasetId !== undefined) {
    params.push(opts.datasetId);
    where.push(`a.dataset_id = $${params.length}`);
  }
  if (opts.status !== undefined) {
    params.push(opts.status);
    where.push(`a.status = $${params.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await db.pool.query(
    `SELECT a.id, a.dataset_id, a.uid, a.reason, a.status, a.reviewed_by, a.created_at, k.name AS dataset_name
       FROM kb_applications a JOIN kb_datasets k ON k.id = a.dataset_id ${whereSql} ORDER BY a.id DESC`,
    params,
  );
  return rows.map(mapApplication);
}

/**
 * 审批申请（事务）：批准 = 申请人直接成为成员（reader；要写权限再由 owner 提）。
 * `FOR UPDATE` 防两个管理员同时批同一份申请。
 */
export async function reviewApplication(
  db: IdentityDb,
  applicationId: number,
  approve: boolean,
  reviewer: KbViewer,
): Promise<KbApplicationRow | null> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT a.id, a.dataset_id, a.uid, a.reason, a.status, a.reviewed_by, a.created_at, k.name AS dataset_name
         FROM kb_applications a JOIN kb_datasets k ON k.id = a.dataset_id
        WHERE a.id = $1 FOR UPDATE`,
      [applicationId],
    );
    const row = cur.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      await client.query("ROLLBACK");
      return null;
    }
    const status = approve ? "approved" : "rejected";
    await client.query("UPDATE kb_applications SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3", [
      status,
      reviewer.uid,
      applicationId,
    ]);
    if (approve) {
      await client.query(
        `INSERT INTO kb_members (dataset_id, uid, role, added_by) VALUES ($1, $2, 'reader', $3)
         ON CONFLICT (dataset_id, uid) DO NOTHING`,
        [Number(row["dataset_id"]), String(row["uid"]), reviewer.uid],
      );
    }
    await client.query("COMMIT");
    return mapApplication({ ...row, status });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 退出库（创建人不能退出 —— 会把库变成没人管） */
export async function leaveDataset(db: IdentityDb, datasetId: number, uid: string): Promise<{ ok: boolean; reason?: string }> {
  const ds = await findDataset(db, datasetId);
  if (ds === null) return { ok: false, reason: "数据集不存在" };
  if (ds.createdBy === uid) return { ok: false, reason: "创建人不能退出自己的数据集（请先转让或删除）" };
  const removed = await removeMember(db, datasetId, uid);
  return removed ? { ok: true } : { ok: false, reason: "你本来就不是成员" };
}

/** 存储用量（按创建人归集，上游的配额口径） */
export async function userStorageUsage(db: IdentityDb, uid: string): Promise<{ usedBytes: number; documentCount: number }> {
  const { rows } = await db.pool.query<{ used: string; docs: string }>(
    `SELECT COALESCE(SUM(d.file_size), 0) AS used, COUNT(*) AS docs
       FROM kb_documents d JOIN kb_datasets k ON k.id = d.dataset_id
      WHERE k.created_by = $1`,
    [uid],
  );
  return { usedBytes: Number(rows[0]?.used ?? 0), documentCount: Number(rows[0]?.docs ?? 0) };
}

/** 重试解析/向量化：删旧片段、按新解析结果重建（文件还在磁盘上才能重试） */
export async function replaceDocumentSegments(
  db: IdentityDb,
  datasetId: number,
  documentId: number,
  segments: ReadonlyArray<{ position: number; text: string; embedding?: readonly number[] }>,
  vectorReady: boolean,
): Promise<number> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM kb_segments WHERE document_id = $1", [documentId]);
    for (const seg of segments) {
      const json = seg.embedding === undefined ? null : JSON.stringify(seg.embedding);
      if (vectorReady && seg.embedding !== undefined) {
        await client.query(
          `INSERT INTO kb_segments (dataset_id, document_id, position, content, embedding_json, embedding)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)`,
          [datasetId, documentId, seg.position, seg.text, json, `[${seg.embedding.join(",")}]`],
        );
      } else {
        await client.query(
          `INSERT INTO kb_segments (dataset_id, document_id, position, content, embedding_json) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [datasetId, documentId, seg.position, seg.text, json],
        );
      }
    }
    await client.query("UPDATE kb_documents SET parse_status = $1, parse_error = NULL WHERE id = $2", [
      segments.length > 0 ? "completed" : "failed",
      documentId,
    ]);
    await client.query("COMMIT");
    return segments.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function markDocumentParseFailed(db: IdentityDb, documentId: number, error: string): Promise<void> {
  await db.pool.query("UPDATE kb_documents SET parse_status = 'failed', parse_error = $1 WHERE id = $2", [error, documentId]);
}

export async function getDocumentStoredPath(db: IdentityDb, datasetId: number, documentId: number): Promise<string | null> {
  const { rows } = await db.pool.query<{ stored_path: string | null }>(
    "SELECT stored_path FROM kb_documents WHERE id = $1 AND dataset_id = $2",
    [documentId, datasetId],
  );
  return (rows[0]?.stored_path as string | null) ?? null;
}

// ── 文件暂存（两步式上传的第 1 步产物：先传文件拿 fileId，再建文档） ─────────

export interface KbFileRow {
  id: number;
  fileName: string;
  fileSize: number;
  fileType: string | null;
  parseStatus: "completed" | "failed";
  parseError: string | null;
  storedPath: string;
  uploadedBy: string;
}

export async function createFileRecord(
  db: IdentityDb,
  input: {
    fileName: string;
    fileSize: number;
    fileType: string | null;
    storedPath: string;
    uploadedBy: string;
    parseStatus: "completed" | "failed";
    parseError?: string | null;
    extractedText: string;
  },
): Promise<number> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO kb_files (file_name, file_size, file_type, stored_path, uploaded_by, parse_status, parse_error, extracted_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      input.fileName,
      input.fileSize,
      input.fileType,
      input.storedPath,
      input.uploadedBy,
      input.parseStatus,
      input.parseError ?? null,
      input.extractedText,
    ],
  );
  return Number(rows[0]?.id);
}

export async function getFileRecord(db: IdentityDb, id: number): Promise<KbFileRow & { extractedText: string } | null> {
  const { rows } = await db.pool.query(
    `SELECT id, file_name, file_size, file_type, stored_path, uploaded_by, parse_status, parse_error, extracted_text
       FROM kb_files WHERE id = $1`,
    [id],
  );
  const r = rows[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    id: Number(r["id"]),
    fileName: String(r["file_name"]),
    fileSize: Number(r["file_size"]),
    fileType: (r["file_type"] as string | null) ?? null,
    parseStatus: (r["parse_status"] as "completed" | "failed") ?? "failed",
    parseError: (r["parse_error"] as string | null) ?? null,
    storedPath: String(r["stored_path"]),
    uploadedBy: String(r["uploaded_by"]),
    extractedText: String(r["extracted_text"] ?? ""),
  };
}

// ── 与库对话（会话 + 消息；RAG 流式回答在 routes 里） ────────────────────────

export interface KbConversationRow {
  id: number;
  datasetId: number;
  title: string;
  createdBy: string;
  createdAt: string;
}

export async function ensureConversationTables(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS kb_conversations (
      id BIGSERIAL PRIMARY KEY,
      dataset_id BIGINT NOT NULL REFERENCES kb_datasets(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '新对话',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kb_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL REFERENCES kb_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      usage JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kb_messages_conversation ON kb_messages(conversation_id);
  `);
}

export async function listConversations(db: IdentityDb, datasetId: number, uid: string): Promise<KbConversationRow[]> {
  const { rows } = await db.pool.query(
    "SELECT id, dataset_id, title, created_by, created_at FROM kb_conversations WHERE dataset_id = $1 AND created_by = $2 ORDER BY id DESC",
    [datasetId, uid],
  );
  return rows.map((r) => ({
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    title: String(r["title"]),
    createdBy: String(r["created_by"]),
    createdAt: toIso(r["created_at"]),
  }));
}

export async function createConversation(db: IdentityDb, datasetId: number, uid: string, title: string): Promise<KbConversationRow> {
  const { rows } = await db.pool.query<{ id: string }>(
    "INSERT INTO kb_conversations (dataset_id, title, created_by) VALUES ($1, $2, $3) RETURNING id, dataset_id, title, created_by, created_at",
    [datasetId, title, uid],
  );
  const r = rows[0] as Record<string, unknown>;
  return {
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    title: String(r["title"]),
    createdBy: String(r["created_by"]),
    createdAt: toIso(r["created_at"]),
  };
}

export async function getConversationFor(db: IdentityDb, datasetId: number, conversationId: number, uid: string): Promise<KbConversationRow | null> {
  const { rows } = await db.pool.query(
    "SELECT id, dataset_id, title, created_by, created_at FROM kb_conversations WHERE id = $1 AND dataset_id = $2 AND created_by = $3",
    [conversationId, datasetId, uid],
  );
  const r = rows[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    id: Number(r["id"]),
    datasetId: Number(r["dataset_id"]),
    title: String(r["title"]),
    createdBy: String(r["created_by"]),
    createdAt: toIso(r["created_at"]),
  };
}

export interface KbMessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  usage: Record<string, unknown> | null;
  createdAt: string;
}

export async function listMessages(db: IdentityDb, conversationId: number): Promise<KbMessageRow[]> {
  const { rows } = await db.pool.query(
    "SELECT id, role, content, usage, created_at FROM kb_messages WHERE conversation_id = $1 ORDER BY id ASC",
    [conversationId],
  );
  return rows.map((r) => ({
    id: Number(r["id"]),
    role: r["role"] as "user" | "assistant",
    content: String(r["content"]),
    usage: (r["usage"] as Record<string, unknown> | null) ?? null,
    createdAt: toIso(r["created_at"]),
  }));
}

export async function appendMessage(
  db: IdentityDb,
  conversationId: number,
  role: "user" | "assistant",
  content: string,
  usage?: Record<string, unknown> | null,
): Promise<number> {
  const { rows } = await db.pool.query<{ id: string }>(
    "INSERT INTO kb_messages (conversation_id, role, content, usage) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
    [conversationId, role, content, usage ?? null],
  );
  return Number(rows[0]?.id);
}
