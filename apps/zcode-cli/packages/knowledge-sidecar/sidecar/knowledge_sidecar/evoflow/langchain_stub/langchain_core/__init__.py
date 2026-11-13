"""`langchain_core` 的最小替身。

只用于让移植过来的 `llm_indexer` 能 import 成功 —— 它的 LLM 索引能力
（用大模型增强分块）在本仓**不启用**，因为 sidecar 不直接调 LLM。
真正的消息对象在 `messages` 子模块里给了最小实现。
"""
