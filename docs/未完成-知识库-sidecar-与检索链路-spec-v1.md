# 知识库 · Python Sidecar 与检索链路 Spec

状态：P0-a / P0-b / P0-c / P0-d 已落地｜适用范围：文档知识库（解析 / 分块 / 索引 / 检索 / 问答）｜维护者：待定
设计来源：EvoFlow `backend/packages/harness/evoflow/knowledge/`（PolyForm Noncommercial，
仅作设计参考，代码按需自行实现）；sidecar 分发机制复用本仓 `office-engines` 与 `dwg-tools` 先例。

> **许可提醒**：EvoFlow 主体是 PolyForm Noncommercial，商用需授权。本文档只借鉴其**架构与
> 数据结构**，不逐字复制代码。若要复用具体实现，需先确认许可边界（其 vendored 的
> `evopanel/src/zcode-*` 才是 Apache-2.0，`backend/` 不是）。

## 1. 背景与缺口

内网审查 / 技术文档场景的输入是大量 PDF、Word、标准规范。现状：

| 能力 | 现状 | 问题 |
| --- | --- | --- |
| 规则下发 | `knowledgeSyncService.ts`（352 行）拉企业规则库到本地 | 只有「同步 + 缓存」，无检索 |
| 文档检索 | 无 | Agent 只能靠 grep 全文扫，长文档命中率低 |
| 向量检索 | 无 | 同义表述、跨语言检索完全不可用 |
| 重排序 | 无 | 召回结果只按字面或向量距离排，精度不足 |
| 知识库产品面 | 无 | 无建库、上传、文件夹、Wiki、图谱 |

与现有模块的边界：

1. **审查板块**（`review/`）= 对被审文件出问题清单并定位，owner 是 `report-review-issues`。
   它消费 `knowledgeSyncService` 下发的规则库，**不消费本文档的知识库检索**。
2. **知识库**（本文档）= 对「用户上传的资料」做解析、索引、检索、问答。
   与审查板块共用「本地缓存 + 离线可用」纪律，但数据与索引独立。
3. **记忆 / 资产中心**（若将来做）= 关于用户的小事实；知识库是用户主动上传的资料。两者不混。

## 2. 目标与非目标

### 2.1 目标（P0）

1. **离线可用**：断网环境下检索、问答全部可用（模型服务走内网）。
2. **混合检索**：FTS5 关键词 + 向量语义 + 标题匹配，RRF 融合。
3. **模型重排**：用本地 rerank 服务对融合结果精排（优于纯词面启发式）。
4. **中文友好**：jieba 分词进 FTS5，解决中文无空格切分问题。
5. **文档解析**：PDF / Word / Excel / PPT / Markdown / 纯文本 → Markdown 正文。
6. **分块保结构**：表格、代码块、图片不被切断。
7. **Agent 接线**：`knowledge` 工具（search / read / docs / list）+ 检索结果自动注入。

### 2.2 非目标（P0 明确不做）

- **本地嵌入模型打包**：用内网已有的 embedding 服务，不打包 PyTorch（-400MB）。
- **Wiki 生成 / 三张图谱**：P1 再评估。P0 只做检索。
- **多租户知识库可见性**：P0 单用户本地库，权限收敛留 P1。
- **内置库随版本同步**：P0 不做，等 P1。
- **前端完整知识库 UI**：P0 只做最小检索面板 + 工具卡，完整 UI 留 P1。

## 3. 分层与状态所有权

```text
┌──────────────────────────────────────────────────────────┐
│  Renderer / UI（React）                                   │
│  · 知识库列表 / 上传 / 检索面板                            │
│  · 工具卡 knowledge.tsx                                   │
│        │ 只通过 services 访问，不碰文件、不碰 DB            │
│        ▼                                                  │
│  packages/services/src/knowledge/                         │
│  · knowledgeClient.ts   —— sidecar 生命周期 + RPC 客户端   │
│  · knowledgeService.ts  —— 业务编排（建库/上传/检索）       │
│  · 唯一 owner：库元数据、索引状态的**业务投影**             │
│        │  stdio JSON-RPC（NDJSON）                        │
│        ▼                                                  │
│  knowledge-sidecar（Python，常驻）                         │
│  · 唯一 owner：SQLite 文件、分块、向量、索引任务           │
│  · 不做权限判断，只执行；权限在 services 层                │
│        │  HTTP（内网）                                     │
│        ▼                                                  │
│  embedding 服务 / rerank 服务（已有，非本项目）             │
└──────────────────────────────────────────────────────────┘
```

**状态所有权铁律**：

| 状态 | 唯一 owner | 说明 |
| --- | --- | --- |
| SQLite 文件（`owned.sqlite` + 每库 `kb_<id>.sqlite`） | sidecar | Node 侧不直接读写 |
| 文档解析状态 / 索引进度 | sidecar | services 只做投影缓存 |
| 库的业务元数据（名称/描述/向量模型配置） | services | sidecar 存原始，services 做校验与展示 |
| 权限与可见性 | services | sidecar 不感知 principal |
| 检索结果的最终排序 | sidecar | 但 rerank 服务由 sidecar 调用 |

## 4. Sidecar 进程管理

### 4.1 生命周期

```text
services 启动
   ↓
首次知识库操作时懒启动（不在 app 启动时拉起，避免拖慢冷启动）
   ↓
spawn knowledge-sidecar
   ↓
握手：等待 stdout 出现 {"type":"ready","version":"1"}（超时 10s）
   ↓
常驻：NDJSON 请求/响应
   ↓
空闲 5 分钟无请求 → 优雅退出（SIGTERM，等待 3s，超时 SIGKILL）
   ↓
下次操作重新启动
```

**为什么常驻而非一次性 spawn**：知识库检索是高频操作（每次对话可能触发多次）。
Python 解释器启动 + SQLite 打开约 300-800ms，一次性 spawn 会显著拖慢对话。
对照 `ocr-tools` 的一次性 spawn 是合理的（OCR 低频），但知识库不同。

### 4.2 通信协议（NDJSON over stdio）

请求（Node → sidecar）：

```json
{"id":"req-1","method":"kb.search","params":{"kbId":"kb_abc","query":"标准引用","topK":10,"mode":"hybrid"}}
```

响应（sidecar → Node）：

```json
{"id":"req-1","ok":true,"result":{"hits":[...]}}
{"id":"req-1","ok":false,"error":{"code":"KB_NOT_FOUND","message":"..."}}
```

**协议约束**：

- 一行一个 JSON，`\n` 分隔。**stdout 只输出协议行**，日志一律走 stderr。
  （`dwg-tools` 踩过这个坑：stdout 混日志会让解析失败。）
- 请求可并发：sidecar 内部用 asyncio，按 `id` 回包，**不保证顺序**。
- 单请求超时 120s（嵌入可能慢）；超时 Node 侧取消，sidecar 收到 `kb.cancel` 后尽力中断。
- 大结果不内联：单次返回 ≤ 64KB，超出走 `kb.fetchPage` 分页。

### 4.3 方法清单（P0）

| 方法 | 用途 | 关键参数 |
| --- | --- | --- |
| `kb.ping` | 健康检查 | — |
| `kb.list` | 列出所有库 | — |
| `kb.create` | 建库 | `name` `description` `embeddingModel` `embeddingDim` |
| `kb.update` | 改库设置 | `kbId` + 可改字段 |
| `kb.delete` | 删库（含文档与索引） | `kbId` |
| `kb.upload` | 上传文件（走文件路径，不走 base64） | `kbId` `filePath` `relPath` |
| `kb.listDocs` | 列文档 + 状态 | `kbId` |
| `kb.deleteDoc` | 删文档 | `kbId` `docId` |
| `kb.retryDoc` | 重试失败文档 | `kbId` `docId` |
| `kb.search` | 检索 | `kbId` `query` `topK` `mode`(hybrid/keyword/vector) |
| `kb.readDoc` | 读文档正文 | `kbId` `docId` `maxChars` |
| `kb.stats` | 库统计（文档数/向量维度/健康度） | `kbId` |
| `kb.reindex` | 整库重建索引 | `kbId` |

**P1 预留**（接口先留空实现）：`kb.wiki.generate`、`kb.graph.entities`、`kb.folder.*`。

### 4.4 失败语义

| 场景 | 行为 |
| --- | --- |
| sidecar 启动失败 | 返回 `KNOWLEDGE_UNAVAILABLE`，UI 提示「知识库引擎不可用」，**不阻塞对话** |
| 嵌入服务不可达 | 文档索引标记 `embedding_failed`，但**关键词检索仍可用**（降级为 keyword 模式） |
| 向量维度不匹配（换模型） | 拒绝写入，提示需重建索引；不静默混用两种维度 |
| sidecar 崩溃 | Node 侧检测到 exit，标记不可用，**自动重启一次**；再失败则降级 |
| SQLite 锁冲突 | 重试 3 次（退避 100/300/900ms），仍失败则报 `KB_BUSY` |

## 5. 数据模型（SQLite）

### 5.1 库结构

```text
<userData>/knowledge/
├── owned.sqlite              # 中心库：所有库的元数据 + mem:* 图谱
└── kb_<kbId>/
    ├── kb.sqlite             # 该库的文档/分块/向量/任务
    └── blobs/                # 原始文件（按 docId 分目录）
```

**为什么每库一个 SQLite**：库可独立备份/删除/重建；单库索引损坏不影响其他库；
向量表按库隔离，换模型时只重建该库。

### 5.2 核心表（照 EvoFlow schema 结构，字段按需裁剪）

```sql
-- 中心库 owned.sqlite
CREATE TABLE kb_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  storage_dir TEXT NOT NULL,
  embedding_model TEXT DEFAULT '',   -- 空 = 用默认
  embedding_dim INTEGER DEFAULT 0,   -- 0 = 未建索引
  content_mode TEXT DEFAULT 'hybrid',-- hybrid | keyword | vector
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- 每库 kb.sqlite
CREATE TABLE kb_documents (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,              -- 稳定 id（rel_path 派生）
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,        -- 用于增量：哈希未变则跳过
  byte_size INTEGER NOT NULL,
  parse_status TEXT NOT NULL,        -- pending | parsing | completed | failed
  parse_error TEXT,
  summary_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_docs_rel_path ON kb_documents(rel_path) WHERE deleted_at IS NULL;

CREATE TABLE kb_chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  context_header TEXT DEFAULT '',    -- 分块所属标题路径
  heading_path TEXT DEFAULT '',
  chunk_kind TEXT DEFAULT 'text',    -- text | table | code | image_caption
  token_estimate INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1
);
CREATE INDEX idx_chunks_doc ON kb_chunks(doc_id, ordinal);

CREATE TABLE kb_chunk_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL            -- struct.pack('f'*dim)，小端 float32
);
CREATE INDEX idx_emb_model ON kb_chunk_embeddings(model, dim);

-- 关键词索引（jieba 预分词后写入，中文可检索）
CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
  chunk_id UNINDEXED, doc_id UNINDEXED, content, tokenize='unicode61'
);

-- 索引任务队列
CREATE TABLE kb_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- parse | embed | wiki
  doc_id TEXT,
  state TEXT NOT NULL,               -- queued | running | done | failed
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON kb_jobs(state, created_at);
```

**关键设计说明**：

1. **`content_hash` 做增量**：再同步时哈希未变的文档直接跳过，不重复解析/嵌入。
2. **`kb_chunk_embeddings` 存 BLOB 而非独立向量表**：sqlite-vec 是可选加速，
   没装时退化为 Python 余弦计算。两套路径共用同一份 BLOB，不重复存储。
3. **`tokenize='unicode61'` + 预分词**：中文先 jieba 切词再用空格连回写入 FTS，
   查询时同样处理。这样 FTS5 才能命中中文。
4. **`chunk_kind` 保留结构信息**：检索时可按类型加权（表格/代码命中权重更高）。

## 6. 检索链路

### 6.1 三路召回 → RRF 融合 → 模型重排

```text
query
  ├─→ [1] FTS5 关键词召回（jieba 分词后 BM25）      → top 20
  ├─→ [2] 向量召回（embedding → cosine / sqlite-vec） → top 20
  └─→ [3] 标题/文件名匹配（LIKE + CJK 重叠）         → top 10
                    ↓
              RRF 融合（k=60）
               score = Σ 1/(k + rank_i)
                    ↓
              候选集 top 30
                    ↓
        [4] rerank 模型精排（内网服务，cross-encoder）
                    ↓
              最终 top K（默认 10）
```

### 6.2 各阶段细节

**[1] 关键词召回**

```python
# 写入时：jieba 分词
tokens = " ".join(jieba.cut(content))
conn.execute("INSERT INTO kb_chunks_fts VALUES (?,?,?)", (chunk_id, doc_id, tokens))

# 查询时：同样分词
q_tokens = " ".join(jieba.cut(query))
# FTS5 bm25() 排序，返回 chunk_id + 负分
```

**[2] 向量召回**

```python
# 优先 sqlite-vec（vec0 虚拟表，余弦距离）
vec_hits = vector_index.recall_ids(conn, kb_id, dim, model, query_vec, top_k=20)
# 降级：全表扫 + Python 余弦
if vec_hits is None:
    rows = conn.execute("SELECT chunk_id, embedding FROM kb_chunk_embeddings WHERE dim=? AND model=?", ...)
    scores = [(cid, cosine(query_vec, unpack(blob))) for ...]
    vec_hits = heapq.nlargest(top_k, scores, key=lambda x: x[1])
```

**距离 → 相似度**：`similarity = 1 / (1 + distance)`，保证落在 (0, 1]，避免负分污染融合。
（EvoFlow 的 `CORE-KB-02` 修的就是这个。）

**[3] 标题匹配**：`LIKE %query%` 命中标题/文件名/摘要，给固定高分。这条对
「按名字找文档」的场景很关键，纯向量检索经常漏掉。

**[4] RRF 融合**

```python
RRF_K = 60
score[chunk_id] += 1.0 / (RRF_K + rank)
```

三路各自排名倒数相加。**RRF 的好处**是不需要归一化不同来源的分数（BM25 是
无界负分、余弦是 0-1、标题是固定分），避免手调权重。

**[5] 模型重排**（本文档相对 EvoFlow 的升级点）

EvoFlow 的 `rerank_by_query_match` 只是词面启发式（标题命中 +3、正文命中 +1.5、
CJK 字符重叠加权），**不是模型**。我们有本地 rerank 服务，换成真 cross-encoder：

```python
# POST <rerank_base_url>/rerank
{
  "model": "<配置的模型名>",
  "query": query,
  "documents": [hit["content"] for hit in candidates[:30]],
  "top_n": top_k
}
# → {"results":[{"index":3,"relevance_score":0.92}, ...]}
```

**失败降级**：rerank 服务不可达时，退回 RRF 顺序 + 词面加权（保留 EvoFlow 那套
启发式作为 fallback），不报错、不阻塞检索。

### 6.3 模式切换

| 模式 | 召回路径 | 适用 |
| --- | --- | --- |
| `hybrid`（默认） | [1]+[2]+[3] → RRF → rerank | 正常 |
| `keyword` | [1]+[3] → 字面排序 | 嵌入服务不可用 / 用户显式选 |
| `vector` | [2] → 余弦排序 | 查语义相近内容 |

**自动降级规则**：请求 `hybrid` 但该库无向量（`embedding_dim=0` 或全部
`embedding_failed`）→ 自动走 `keyword`，响应里带 `degraded: "no_vector"`，
UI 提示「语义索引未就绪，已用关键词检索」。**不报错**。

## 7. 分块策略

### 7.1 保护性区段（关键）

分块前先识别**不可切断的区段**，切分时跳过这些区间：

| 区段 | 正则 | 理由 |
| --- | --- | --- |
| 围栏代码块 | ` ```[\s\S]*?``` ` | 切断后代码无法理解 |
| 图片引用 | `!\[[^\]]*\]\([^)]+\)` | 切断后引用失效 |
| Markdown 表格 | 表头 + 分隔行 + 数据行 | 切断后表结构丢失 |

```python
def _find_protected_spans(text) -> list[(start, end)]:
    spans = []
    for rx in (_FENCE_RE, _IMAGE_RE, _TABLE_RE):
        spans.extend((m.start(), m.end()) for m in rx.finditer(text))
    return merge_overlapping(sorted(spans))
```

### 7.2 切分算法

```text
1. 若 len(doc) <= chunk_size → 整篇一个 chunk（不切）
2. 否则：
   a. 按段落（\n\n）分组
   b. 贪心累积段落直到接近 chunk_size
   c. 若单段 > chunk_size，在保护性区段之外找句子边界（。！？\n）切
   d. 相邻 chunk 保留 overlap（默认 chunk_size 的 15%）
3. 每个 chunk 记录 context_header（当前标题路径），检索时一并返回
```

**踩过的坑（EvoFlow 注释里的真实事故）**：曾有个固定 5000 字符上限忽略配置，
导致 3k 字符的 FAQ 包变成单个向量，检索直接失效。**配置的 `chunk_size` 是唯一权威，
不允许再出现隐藏上限。**

### 7.3 默认参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `chunk_size` | 1000 字符 | 中文场景比英文小，避免语义稀释 |
| `chunk_overlap` | 150 字符 | 15% |
| `min_chunk_size` | 100 字符 | 小于此值并入前一块 |

## 8. 打包与分发

### 8.1 复用 office-engines 机制

```text
scripts/prepare-knowledge-assets.mjs    ← 新增，照 prepare-office-engines-assets.mjs
  ↓ 产出
packages/desktop/bundled-tools/<platform>/knowledge-engines/
  ├── python/                    # embeddable Python 3.12（~15MB）
  ├── site-packages/             # 纯 Python wheels
  │   ├── markitdown/            # 文档解析
  │   ├── sqlite_vec/            # 向量扩展
  │   ├── jieba/                 # 中文分词
  │   ├── openpyxl/              # xlsx
  │   └── (pdfplumber 等)
  └── sidecar/                   # 我们的 Python 代码
      └── knowledge_sidecar/
  ↓ electron-builder extraResources
resources/tools/knowledge-engines/
```

### 8.2 体积预算（P0-a 实测）

linux-arm64 实测 **45.0 MiB**（`node scripts/prepare-knowledge-assets.mjs` 输出）：

| 组件 | 体积 | 备注 |
|---|---|---|
| markdownify / bs4 / soupsieve / puremagic | ~4 MB | 轻量格式处理，纯 Python |
| requests + urllib3 + idna / certifi | ~2 MB | sidecar 调 embedding / rerank HTTP 服务 |
| sqlite-vec | ~2 MB | 平台相关 wheel（manylinux / macosx / win） |
| jieba + 词典 | ~15 MB | sdist，`pip --target` 装 |
| six | ~12 KB | markdownify 依赖，只有 sdist |
| sidecar 代码 | <1 MB | 6 个 .py |
| Windows embeddable Python | ~15 MB | 仅 Windows；Unix 记录系统解释器 |
| **合计** | **~45 MB**（linux-arm64） | 无 PyTorch / onnxruntime / numpy |

**关键决策：不使用 markitdown**（实测后放弃）。两版都踩坑：

- `0.1.x` 依赖 `magika` → `onnxruntime`（14.4MB 原生 wheel）+ 运行时下载 ONNX 模型权重；
- `0.0.1a2` 顶层硬导入 `mammoth` / `pandas` / `pdfminer` / `pptx`，
  其中 `pandas` → `numpy`，而 numpy 的 `cp311` ABI wheel 与 Python 3.12 不兼容，
  实测 `import numpy` 直接失败。

P0 改为**自写轻量解析器**（纯标准库 `zipfile` + `ElementTree` 解析 docx/pptx/xlsx），
文档解析能力复用本仓已有的 `file-tools-plugin`。代价是 Office 解析要自己实现，
收益是资产树零原生依赖、无平台 ABI 矩阵、离线部署可控。

**相比完整方案（含 sentence-transformers + torch）省约 400-500MB。**

### 8.3 平台矩阵

| 平台 | 支持 | 说明 |
| --- | --- | --- |
| win32-x64 | ✅ | 主要目标 |
| darwin-arm64 | ✅ | |
| darwin-x64 | ✅ | 无本地嵌入，走内网服务，**无降级问题** |
| linux-x64 | ✅ | |

有本地模型服务后，**四个平台一致**，不再有 EvoFlow 那个 macOS Intel 缺口。

## 9. 与 Agent 的接线

### 9.1 工具定义

```typescript
// knowledge 工具（MCP tool），四个 action
{
  name: "knowledge",
  inputSchema: {
    action: "search" | "read" | "docs" | "list",
    kbId?: string,        // 省略 = 搜所有已绑定库
    query?: string,       // search 必填
    docId?: string,       // read 必填
    topK?: number,        // 默认 10
    mode?: "hybrid" | "keyword" | "vector"
  }
}
```

### 9.2 检索结果注入（可选，按配置）

在调用模型前自动检索，把片段放进上下文：

```text
配置项（每个 agent 独立）：
  autoInject: boolean          // 是否自动注入
  topK: number                 // 注入条数，默认 5
  minScore: number             // 最低相关度，默认 0.3
  maxTokens: number            // 注入 token 上限，默认 2000
  onFailure: "continue" | "abort"  // 检索失败时继续还是中止
```

**默认关闭自动注入**（P0）。理由：自动注入会让每轮对话多一次嵌入调用 + 检索，
对不需要知识库的对话是纯浪费。等实测有效后再考虑默认开。

### 9.3 权限收敛（P1）

P0 单用户，不涉及。P1 引入多租户后：

- 普通 agent 只能搜「绑定给它的库」
- 管理员可搜全部
- 权限判断在 **services 层**，sidecar 不感知

## 10. 验收场景

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 上传 10 个 PDF，等待索引完成 | 全部 `completed`，可检索 |
| 2 | 中文查询「标准引用有哪些」 | 命中相关文档，rerank 后首位正确 |
| 3 | 断网（仅内网模型服务可用） | 检索、问答全部正常 |
| 4 | 嵌入服务停机 | 文档标记 `embedding_failed`，关键词检索仍可用，UI 提示降级 |
| 5 | rerank 服务停机 | 退回 RRF 顺序，不报错 |
| 6 | 换 embedding 模型 | 提示需重建索引；重建后维度一致 |
| 7 | 上传含表格/代码的 Markdown | 表格与代码块不被切断 |
| 8 | 同一文件重复上传 | `content_hash` 命中，跳过重复解析 |
| 9 | sidecar 崩溃后操作 | 自动重启一次，恢复可用 |
| 10 | 检索 100 次（并发 5） | 无 SQLite 锁错误，P95 < 800ms |
| 11 | 删除库 | SQLite 文件与 blobs 目录一并清理 |
| 12 | 库索引损坏 | 该库不可用，其他库不受影响 |

## 11. 实施拆解

| 阶段 | 内容 | 工期 | 依赖 |
| --- | --- | --- | --- |
| P0-a | sidecar 骨架（进程管理 + NDJSON RPC + 打包脚本） | 1 周 | 无 |
| P0-b | 解析 + 分块 + schema | 1.5 周 | P0-a |
| P0-c | FTS5 + jieba + 向量索引 | 1 周 | P0-b |
| P0-d | 三路召回 + RRF + rerank 对接 | 1.5 周 | P0-c |
| P0-e | services 层 + 工具 + 最小 UI | 2 周 | P0-d |
| P0-f | 多平台打包 + 验收 | 1 周 | P0-e |
| **合计** | | **8 周** | |

## 12. 待决问题

1. **Python 运行时是否复用 office-engines 那一份？**
   复用省 15MB，但两者 wheel 需求不同（office 要 LibreOffice 绑定，知识库要 markitdown），
   耦合后升级会互相牵制。**建议独立**，代价 +15MB。

2. **文档原始文件存哪？**
   `<userData>/knowledge/kb_<id>/blobs/`（跟随库）还是统一 `<userData>/blobs/`？
   建议跟随库，删库即清。

3. **rerank 服务接口格式确认**
   需要确认内网 rerank 服务的实际接口（是否 OpenAI 兼容、是否支持 batch）。

4. **是否要 Wiki / 图谱？**
   P0 不做。若后续要做，`wiki.py` / `kg.py` 的结构可复用，但要评估产品价值。

## 13. 参考实现对照

| EvoFlow 模块 | 行数 | 本方案处理 |
| --- | --- | --- |
| `owned/chunking.py` | 343 | 复用算法（保护性区段 + 边界切分） |
| `owned/retrieve.py` | 494 | 复用 RRF 骨架，**rerank 升级为模型** |
| `owned/vector_index.py` + `vector/sqlite_vec.py` | 423 | 复用 |
| `owned/schema.py` | 738 | 复用表结构，裁剪字段 |
| `owned/pipeline.py` | 597 | 复用流程，改任务编排 |
| `owned/jobs.py` | 761 | 复用状态机 |
| `embedding/cloud_provider.py` | 289 | 复用（base_url 指向内网服务） |
| `parser.py` | 234 | 复用（markitdown） |
| `embedding/local_provider.py` | 441 | **不采用**（无 PyTorch） |
| `owned/service.py` | 3320 | **重写**（接本仓存储与权限） |
| `owned/wiki.py` + `kg.py` | 787 | P1 再评估 |

## 14. P0-a 落地记录（2026-11-13）

### 已交付

| 文件 | 内容 |
| --- | --- |
| `apps/zcode-cli/packages/knowledge-sidecar/sidecar/knowledge_sidecar/transport.py` | NDJSON RPC：stdout 只走协议、日志走 stderr、8 MiB 行上限、按 id 并发回包 |
| `.../store.py` | 中心库 + 每库独立 SQLite、WAL + `busy_timeout=5s`、FTS5 可用性探测 |
| `.../handlers.py` | ping / list / create / update / delete / upload / listDocs / stats；检索类留 `NOT_IMPLEMENTED` |
| `.../models.py` | OpenAI 兼容 embedding 客户端 + 多格式 rerank 探测 + 纯 Python 余弦 |
| `.../__main__.py` | 参数解析、信号处理、ready 握手 |
| `packages/services/src/knowledge/knowledgeClient.ts` | 常驻进程管理 + RPC 客户端 + 资产候选链 |
| `scripts/prepare-knowledge-assets.mjs` | 资产 staging（wheel / sdist / sidecar 代码三类） |

### 实测结果

- **Node → Python 全链路**：握手 552 ms，建库 / 列表 / 统计 / 优雅退出全部通过
- **模型服务**（SiliconFlow，OpenAI 兼容）：
  - embedding `BAAI/bge-m3` → 1024 维，`pack/unpack` float32 往返一致
  - rerank `BAAI/bge-reranker-v2-m3` → 自动识别 `results` 数组格式，排序正确
- **资产体积**：linux-arm64 **45.0 MiB**，零原生重依赖
- `tsc -b packages/services` 0 错误；`oxlint` 改动文件 0 警告 0 错误

### rerank 接口格式兼容（用户明确要求）

OpenAI **没有**标准 rerank 接口，各家形状不同，`models.py` 做成自动探测 + 显式覆盖：

| 格式 | 响应形状 | 配置值 |
| --- | --- | --- |
| SiliconFlow / Jina | `{"results":[{"index":0,"relevance_score":0.04}]}` | `auto`（默认自动识别） |
| TEI（HuggingFace） | `[{"index":0,"score":0.04}]` | `tei` |
| 自定义 | 任意 | `ZCODE_KNOWLEDGE_RERANK_FORMAT` + 扩展 `_extract_results` |

embedding 侧天然兼容 OpenAI `/v1/embeddings`（已验证 SiliconFlow、并支持
`encoding_format` 可选字段），vLLM / Ollama / LM Studio 可直接切换。

### 踩过的坑（都已修，留档防再犯）

1. **`--data-root` 漏传**：sidecar argparse 必填，缺了 exit 2；Node 侧只看到
   「引擎退出（code=2）」，一个参数缺失被表现成引擎崩溃。
2. **`PYTHONPATH` 直接赋值**：覆盖了调用方注入的值，症状「资产在、import 不到」。
   改为「显式 env → 资产树 → 继承」的顺序拼接。
3. **Unix 不能用 executable 反推资产树**：Unix 走系统 python（`interpreter.json`），
   `/usr/local/bin/python3` 的 `../../` 跟资产树无关。改为显式写
   `ZCODE_KNOWLEDGE_SIDECAR_DIR`。
4. **`Set.map` 不存在**：去重后要 `[...new Set(...)]` 再 map。
5. **`kb_conn` 建库时鸡生蛋**：它先查文件存在，而建库时文件还没创建。`_init_kb`
   改用底层 `_connect`。
6. **目录名 `kb_kb_xxx` 双前缀**：id 已带 `kb_`，路径又拼一次。
7. **Dirent 的 `d_type` 在 FUSE / proot 不可靠**：硬链接被误报成 symlink，
   `isFile()`/`isDirectory()` 同时为 false。用 `stat` 复核（两处：打包脚本与 sidecar）。
8. **清华/阿里镜像不提供 PyPI JSON API**：`/pypi/<name>/<ver>/json` 返回 404。
   元数据只问官方 PyPI，文件下载再换镜像。
9. **`spawnSync` 里跑 fetch 不稳**：本机高并发/网络抖动下子进程常 status=5 退出，
   改主进程 `fetch` + 三次重试后稳定。
10. **解 zip 无系统工具**：容器里既无 `7z` 也无 `unzip`，GNU tar 不支持 zip。
    加 `fflate` 纯 Node 兜底（带 zip-slip 防护）。
11. **wheel 传递依赖不会自动拉**：markitdown 缺 `requests`、markdownify 缺 `six`，
    运行期才报 `ModuleNotFoundError`。逐个显式列出。
12. **numpy 是 cp311 ABI wheel**：与 Python 3.12 不兼容，`import numpy` 直接失败。
    这是放弃 markitdown/pandas 的最后一根稻草。

## 15. 前端接入记录（2026-11-13）

### 结论：EvoFlow 前端可直接复用，不需写 59 个 shim

原估算「写 tauri-api shim 要 2-3 周」是错的。读了 EvoFlow 的
`evopanel/src/lib/tauri-api.js` 后确认：**它本身就是双模式** ——
桌面走 Tauri `invoke`，Web 模式走 `gatewayProxy`，而 `gatewayProxyOnce`
的非 Tauri 分支就是普通 `fetch`。所以只要按它已约定的 REST 契约提供网关
（见 §16），前端 API 层一行不用改。

### 已落地

| 位置 | 内容 |
| --- | --- |
| `packages/ui/src/knowledge/` | 页面与组件 11,032 行（4 个 .jsx + 2 个 .css + 6 个工具模块） |
| `knowledge/kb-api.ts` | 56 个方法 → HTTP 网关的适配层 |
| `knowledge/kb-modal.ts` | 模块级 `showConfirm` → `useConfirmDialogStore` |
| `knowledge/right-stage/kb-bridge-services.ts` | EvoFlow 两个特有工厂的最小替身 |
| `knowledge/nav-panel-prefetch.js` | hover 预热缓存 shim（恒返回 null，回源） |
| `knowledge/knowledge-owned-aside.js` | 退化为 no-op（侧栏折叠归 ShellLayout 唯一持有） |
| `components/ai-elements/markdownTableVariant.tsx` | 20 行表格变体 context |
| `packages/server/src/knowledge/routes.ts` | `/api/knowledge/owned/*` 网关 |

主视图接线：`WorkspaceMainView` 加 `"knowledge"`、`WorkspaceShellLayout` 渲染分支、
侧栏 `knowledge-trigger`、`knowledgeEnabled` 开关（Root → RootWorkspaceContent →
App → ShellLayout，web 入口置 true）。

### 搬迁时踩的坑（都已修）

1. **动态 import 是第二层地雷**：静态 import 全改完后 `vite build` 才暴露 7 处
   动态 import（Office 预览 4、nav-prefetch、ForceGraph、tauri dialog）。
   前两类指向本仓已有模块或降级为 shim；ForceGraph 被 `KB_GRAPH_UI_ENABLED=false`
   关掉且依赖 EvoFlow 自有 graph-layout，整段摘除；tauri dialog 改为变量间接引用
   （`@tauri-apps/plugin-dialog` 不在依赖里，静态 import 会让 build 直接失败）。
2. **`styles-bridge.css` 不能搬**：那是 EvoFlow 的 Tailwind 主入口（2176 行，
   `@import "tailwindcss/theme.css"` 等），与我们 `styles.css` 会双份注册
   Tailwind 变量与 plugin。工具类本就全局可用，不引入。
3. **`.jsx` 在本仓无类型**：本项目统一 `.tsx`。给 4 个页面组件加 `.d.ts`
   提供最小类型面（`export default function(): JSX.Element`）。
4. **Vite 的 `.js` 后缀不映射 `.tsx`**：EvoFlow 用 `from "./x.js"` 指 `.tsx`，
   在它的构建里成立；我们的 vite 配置按真实扩展名解析。指向本仓组件时要写
   真实路径（`@/components/...`）而非 `.js`。
5. **`max-lines` 超限**：`knowledge-owned.jsx` 4245 行，按仓库既有约定在
   `.oxlintrc.json` 登记为**告警**（与 WorkspaceGroupedTasksSection 等存量同规格）。
6. **`listModels` 拿不到**：模型目录的 owner 是 provider 体系（React hook），
   模块级 `kb-api` 取不到。返回空列表让 UI 走既有降级（可建纯关键词库），
   并留 `setKnowledgeModelProvider()` 注入点，不在适配层再造第二份模型状态。

### 验证状态

| 项 | 结果 |
| --- | --- |
| `tsc -b packages/ui packages/web packages/server` | ✅ 0 错误 |
| `npx vite build`（packages/web） | ✅ built in 50.66s |
| `oxlint packages/ui/src/knowledge/` | ✅ 0 错误（21 警告均为 EvoFlow 原有未使用变量） |
| HTTP 端到端（真实 sidecar） | ✅ GET/POST/PATCH/DELETE bases、documents、stats；search 返回 501 符合预期 |
| **浏览器内点击验证** | ⏳ **未做** —— 手机 proot 环境装不了 chromium（Ubuntu 24.04 的 chromium 只有 snap 包装，proot 跑不了 snap；playwright 的 chromium 能下载但启动卡住） |

浏览器验证待在有可用 chromium 的环境完成。建议验证清单：

1. 侧栏出现「知识库」入口，点开进主视图
2. 新建库（选纯关键词模式，因无向量模型）
3. 上传一个 .md → 状态从「排队中」走到「已处理」
4. 切到「检索」页签，输入关键词能命中

> P0-b（解析/分块）落地后第 3、4 步才有完整数据；
> 当前上传只会登记并排 parse 任务（`parseStatus: "pending"`），不会真的解析。


## 16. P0-b 落地记录（2026-11-13）

### 已交付

| 文件 | 内容 |
| --- | --- |
| `knowledge_sidecar/parser.py` | 文档解析：docx/pptx/xlsx（纯标准库 zip+XML）、pdf（pdfplumber 优先 + 标准库兜底）、纯文本类 |
| `knowledge_sidecar/chunking.py` | 递归分块 + 保护性区段 + 标题路径 |
| `knowledge_sidecar/pipeline.py` | 解析 → 分块 → 落库 + FTS 索引；parse/embed 两类作业 |
| `knowledge_sidecar/worker.py` | 后台单线程 worker，轮询 kb_jobs，不阻塞 RPC |
| `handlers.py` | `read_doc`（正文+分块）、`retry_doc`（重排作业） |

### 为什么不用 markitdown（最终决策）

实测两版都不可接受：

- `0.1.x` → `magika` → `onnxruntime`（14.4MB 原生 wheel）+ 运行时下载 ONNX 模型；
- `0.0.1a2` → 顶层硬导入 `mammoth`/`pandas`/`pdfminer`/`pptx`，其中 `pandas`
  → `numpy`，而 numpy 的 **cp311 ABI wheel 与 Python 3.12 不兼容**，
  `import numpy` 直接失败。

改为纯标准库：`.docx`/`.pptx`/`.xlsx` 本质是 zip + XML，用 `zipfile` +
`ElementTree` 直解。代价是 Office 解析自己实现（约 400 行），收益是资产树
零原生依赖、无平台 ABI 矩阵。

### 分块策略要点

- **保护性区段**：围栏代码块、图片引用、Markdown 表格在切分时跳开，不被切断；
- **三级边界**：标题 → 段落 → 句子，优先保持语义单元完整；
- **overlap**：相邻块保留尾部重叠（默认 150 字符）；
- **`chunk_kind`**：自动识别 text / table / code / image_caption，供检索时按类型加权；
- **`heading_path`**：记录「第2章 > 2.1 概述」这样的路径，检索结果可溯源。

`chunk_size` 是唯一权威，没有隐藏上限（这是 EvoFlow 注释里记录的真实事故：
固定 5000 字符上限让 3k 字符的 FAQ 包变成单个向量，检索彻底失效）。

### job 拆成 parse / embed 两类的原因

失败语义不同，合并会误导演排：

| 失败点 | 文档状态 | 检索可用性 |
| --- | --- | --- |
| 解析失败 | `parse_status=failed` | 完全不可用（无正文） |
| 嵌入失败 | `parse_status=completed` | 关键词仍可用（语义降级） |

合成一个 job 会让「嵌入服务挂了」表现成「文档解析失败」。

### worker 设计

- **独立线程**：解析一个 PDF 可能几秒到几十秒，同步做会让 `kb.upload` 卡住；
- **单线程而非线程池**：SQLite 写锁是库级（即使 WAL 同时只有一个写者），
  多线程只会互相排队并增加 `database is locked` 风险。每库一个 DB 已隔离，
  将来可每库一线程；
- **幂等**：重跑 parse 先删旧 chunks 与 FTS 行，不累积重复；
- **优雅停止**：先停 worker 再退出，避免写 SQLite 时被 SIGTERM 打断。

### 实测结果

| 场景 | 结果 |
| --- | --- |
| `.md` 解析 | ✅ 标题结构保留，`has_structure=true` |
| `.docx` 解析 | ✅ `Heading1`/`Heading2` 正确映射成 `#`/`##`，段落完整 |
| 长文档分块（2411 字符，chunk_size=600） | ✅ 切 5 块，`heading_path` 精确到章节 |
| 表格保护 | ✅ `\| 列A \| 列B \|` 到 `\| 值3 \| 值4 \|` 同块未切断 |
| 代码块保护 | ✅ `def func_5` 与 `return 5` 同块 |
| `chunk_kind` 识别 | ✅ 正确标出 table / code / text |
| jieba 分词 | ✅ 首次加载 0.58s，之后走缓存 |
| worker 异步链路 | ✅ 3 文件上传后 `pending` → 1.0s 内全部 `completed`，5 chunks 入库 |
| 类型检查 | ✅ services / server / ui / web 四包 0 错误 |

### 未做（P0-c/d）

- embedding 写入（`kembed` job 标记为 `failed: embedding 尚未实现`，不会永久 queued）
- 检索链路（`kb.search` 仍返回 `NOT_IMPLEMENTED`）

## 17. P0-c/d 落地记录（2026-11-13）

**本轮起改用「移植 EvoFlow」而不是重写。** 前期自己实现的 `chunking.py` 漏掉了
`_overlap_tail()` 的边界回溯，实测 chunk 从「，」中间截断（`'，并按规定进行抽样复验'`），
这是重写导致的质量损失。经确认 EvoFlow 是公司自有项目且已获书面授权，本轮
**算法逻辑照搬、只改存储适配层**。

### 已交付

| 文件 | 来源 | 改动 |
| --- | --- | --- |
| `chunking.py` | EvoFlow `owned/chunking.py` | `ChunkPiece`→`Chunk`，`split_text`→`chunk_markdown`，补 `strategy` 参数 |
| `search.py` | EvoFlow `owned/retrieve.py` | 去掉 `kb_id`/`deleted_at` 过滤；rerank 升级为模型 |
| `vector_index.py` | EvoFlow `owned/vector_index.py` | 表名去 `kb_id`，修 `id(conn)` 缓存 bug |
| `tokenize.py` | 新增（EvoFlow 无此模块） | 抽出共用分词，修「写入分词、查询不分词」的致命 bug |
| `pipeline.py` | — | 新增 `run_embed_job()`；`pending_parse_jobs`→`pending_jobs` |
| `worker.py` | — | 消费 embed job；新增 `_resolve_embedding_model()` |
| `handlers.py` | — | `kb.search` / `kb.reindex` / `kb.ask` 落地 |
| `entry-http.ts` | — | 补 `knowledgeDataRoot`（网关此前从未挂载） |

### 本轮修掉的 4 个真 bug

1. **写入分词、查询不分词** —— FTS 索引里是「材料 复验 不合格」，查询拿整串去做短语匹配，
   一条都命中不了。只有向量检索时完全看不出来，关掉向量即全废。抽出 `tokenize.py` 共用。
2. **`id(conn)` 缓存扩展加载状态** —— CPython 复用已释放对象的 id，第二个连接被误判为
   「已加载」→ 跳过 `load_extension` → `no such module: vec0`。症状是「第一次检索正常，
   之后全部静默退化」。SQLite 扩展本来就是连接级的，直接去掉缓存。
3. **嵌入写入与检索查询的 model 不一致** —— 写入 `model=''`、查询按 `model='BAAI/bge-m3'`
   过滤，表现是「嵌入明明成功，检索永远只有关键词」。worker 改为读库登记的 model。
4. **`id(item)` 去重导致结果重复** —— dict 的 id 会复用，同一 chunk 出现两次
   （一次带 `rerankScore`、一次不带）。改用 `chunkId` 去重。

### 实测结果

```
端到端（2 文档 / 7 块 / 真实 SiliconFlow 服务）
  检索 5/5 通过，degraded 全为 false
  典型时延 630–770ms（含查询嵌入 + 网络往返）
  嵌入 BAAI/bge-m3 1024 维，rerank BAAI/bge-reranker-v2-m3

降级路径（三条都验证）
  rerank 服务不可达   → 退回词面启发式，不报错
  embedding 服务不可达 → 降级为关键词检索，degraded=true
  无模型配置          → 建库/上传/解析/关键词检索全可用

NDJSON RPC 全链路（真实子进程）
  kb.create → kb.upload → worker 异步 parse+embed → kb.search → kb.ask → kb.reindex  ✅
```

### 验证命令

```sh
set -a && . .secrets/siliconflow.env && set +a
ZCODE_KNOWLEDGE_MODEL_BASE_URL="$SILICONFLOW_BASE_URL" \
ZCODE_KNOWLEDGE_MODEL_API_KEY="$SILICONFLOW_API_KEY" \
ZCODE_KNOWLEDGE_EMBEDDING_MODEL="$SILICONFLOW_EMBEDDING_MODEL" \
ZCODE_KNOWLEDGE_RERANK_MODEL="$SILICONFLOW_RERANK_MODEL" \
PYTHONPATH="$PWD/packages/desktop/bundled-tools/linux-arm64/knowledge-engines/python/Lib/site-packages" \
python3 scripts/dev/knowledge-e2e.py
```

### 仍未做

- **Agent 工具接线**（spec §9 的 `knowledge` 工具：search/read/docs/list 四个 action）
- **文件夹操作**（前端 5 个方法仍是桩）
- **Wiki / 图谱**（9 个方法，P1）
- **多平台打包**（当前只有 linux-arm64 资产树）
- **浏览器实点验证**（手机 proot 装不了 chromium，仅验证到 HTTP/RPC 层）
