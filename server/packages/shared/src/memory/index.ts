/**
 * 记忆层（W4-②）—— 出口。
 *
 * 设计来源：LeAgent `memory/`（Apache-2.0）。只取**契约与算法**：
 * 三存储类型、确定性 formation 打分、混合召回 boost/去重/折叠。
 *
 * 不抄（见 master-plan §8）：Milvus 硬依赖、SQLAlchemy、`memory/compaction.py` 的
 * `getattr(store,"_db")` 反模式、以及与其主链路重复的 `services/compact`。
 * 存储层由 sidecar 用 JSONL（真源）+ 内存索引实现 —— 与 Reactor 既有的
 * 审计日志同构（复用 `append-line.ts` 的单次 write(2) 与尾愈合）。
 */

export * from "./types.js";
export * from "./formation.js";
export * from "./recall.js";
export * from "./maintenance.js";
