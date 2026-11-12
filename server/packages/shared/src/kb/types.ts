/**
 * 知识库统一契约（个人库 / 公共库共用）—— 纯类型 + 常量，零依赖。
 *
 * ## 为什么先立契约
 *
 * 个人库在**端上**、公共库在**服务端**，两路检索最终要在同一次工具回执里混排。
 * 若两边各写一套结果形状，混排与"出处标注"就会被写两遍，且**必然漂移**
 * （一边加了 `score` 字段、另一边忘了）——这是跨端功能最常见的烂账。
 *
 * 所以先钉死 `RetrievalHit`：**任何一路检索的产出都必须是它**。
 */

/** 知识库来源三类（用户口径：公共库只到「部门 + 全员」两级，个人库仅本机） */
export type KbSource = "personal" | "department" | "org";

/** 全部来源（渲染顺序 = 界面分组顺序） */
export const KB_SOURCES: readonly KbSource[] = ["personal", "department", "org"];

/** 来源的中文标签（回执与界面共用；改文案只改这里） */
export const KB_SOURCE_LABEL: Record<KbSource, string> = {
  personal: "我的",
  department: "部门",
  org: "全员",
};

/**
 * 一条检索命中。
 *
 * ⚠️ `source` **必填**（红线 3）：没有来源的命中会让模型无法标注出处，
 * 也就无法回答"这条是组织资料还是你自己的笔记"——这在合规上是不可接受的。
 */
export interface RetrievalHit {
  /** 命中的片段文本 */
  readonly chunk: string;
  /** 相关度（越大越相关；不同检索器之间只保证可比性由调用方负责归一） */
  readonly score: number;
  readonly source: KbSource;
  /** 库名（出处展示） */
  readonly datasetName: string;
  /** 文档名（出处展示） */
  readonly docName: string;
  /** 片段在文档中的序号（0-based；用于"跳回原文"与去重） */
  readonly position: number;
}

/** 一个已切片片段（存储层形状） */
export interface Segment {
  /** 稳定 id：`<docId>#<position>`（便于幂等 upsert） */
  readonly id: string;
  readonly docId: string;
  readonly docName: string;
  readonly position: number;
  readonly text: string;
  /** 字符数（切片时算好，避免每次统计重算） */
  readonly length: number;
  /** 向量（未做向量化时为 undefined —— 允许只有 lexical） */
  readonly embedding?: readonly number[];
}

/** 切片参数（照 BuildingAI `SegmentationOptions` 的口径） */
export interface ChunkOptions {
  /** 单片段最大字符数 */
  readonly maxSegmentLength: number;
  /** 相邻片段重叠字符数（默认 0） */
  readonly segmentOverlap?: number;
  /** 分隔符优先级（默认含中文句号 —— 中文文档不按它切会切碎句子） */
  readonly separators?: readonly string[];
}

/** 缺省切片参数（与公共库保持同一口径，便于将来统一调参） */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxSegmentLength: 500,
  segmentOverlap: 50,
  separators: ["\n\n", "。", ". ", " ", ""],
};

/** 过短片段阈值：低于它就尝试与前一片合并（避免"1 个字的片段"污染召回） */
export const MIN_SEGMENT_CHARS = 24;

/** 单次检索返回上限（防止一次把上下文灌爆） */
export const MAX_HITS = 20;

/** 单次查询可给出的 query 数上限（照 BuildingAI 的 1~5 口径） */
export const MAX_QUERIES_PER_CALL = 5;

/**
 * 向量化器（注入式）。
 *
 * 之所以是接口而不是直接 HTTP：① 探针能用假实现覆盖 KB 全部逻辑；
 * ② 网关路由补齐前，KB 以 lexical 先行也能完整跑（见方案 §4）。
 */
export type Embedder = (texts: readonly string[], opts?: { model?: string }) => Promise<number[][]>;

/** 重排器（注入式；可选 —— 没有它就用召回分排序） */
export type Reranker = (
  query: string,
  documents: readonly string[],
  opts?: { model?: string; topN?: number },
) => Promise<Array<{ index: number; score: number }>>;
