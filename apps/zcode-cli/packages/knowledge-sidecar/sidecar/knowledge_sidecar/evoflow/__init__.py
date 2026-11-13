"""EvoFlow 兼容层（shim）。

移植 EvoFlow `knowledge/owned/` 时，那批模块 import 了 `evoflow.config.*` 等
上层框架。本包只提供**最小可用的等价实现**，让移植代码原样运行，而不必改
它内部的 import 语句 —— 改 import 会让后续再同步 EvoFlow 更新时产生冲突。

对应关系：
  evoflow.config.paths          → 本仓 `--data-root`
  evoflow.config.app_config     → 空配置对象（本仓没有 yaml 配置体系）
  evoflow.config.model_config   → ModelConfig，接 ZCODE_KNOWLEDGE_* 环境变量
  evoflow.persistence.db        → 复用本仓的连接管理
  evoflow.persistence.secret_store → 内存实现（本仓凭据走环境变量）
"""
