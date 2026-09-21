/**
 * 知识库（KB）公共契约与纯逻辑（KB-①）。
 *
 * 个人库在端上、公共库在服务端，两路检索共用本模块的契约与排序 —— 见
 * `docs/实施计划/个人知识库-实施方案-v1.md`。
 */
export * from "./types.js";
export * from "./chunk.js";
export * from "./rank.js";
