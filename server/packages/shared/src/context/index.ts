/**
 * 上下文装配（W4-①）—— 出口。
 *
 * 设计来源：LeAgent `context/` + `prompts/`（Apache-2.0）。只取「纯函数、可测、零依赖」
 * 的三件事：两道预算闸门、相关性门控、三层排序保稳定前缀。
 *
 * 不抄的部分（见 master-plan §8 红线）：Python 的 structlog/asyncio.shield/frozen dataclass、
 * Milvus 硬依赖、以及 LeAgent 那套与主链路重复的 `CompactService`。
 */

export * from "./types.js";
export * from "./relevance.js";
export * from "./budget.js";
export * from "./assemble.js";
export * from "./assemble-context.js";
