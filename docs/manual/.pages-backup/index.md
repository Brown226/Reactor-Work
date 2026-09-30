# Reactor 产品说明书

**Reactor（数智堆脑）** 是面向内网环境部署的 Agentic Development Environment（ADE）：把大模型的长上下文与长程任务能力，落到桌面端、Web 端与终端里可连续推进的开发工作流上。

本说明书**依据当前检出的源码整理**，描述的是本仓库实际提供的能力、命令、配置项与文件位置。它与上游 ZCode 官方文档存在差异，凡属本仓二次开发新增、上游没有或已改动的部分，均在本说明书中单独标注。

## 本说明书与上游文档的关系

| 关注点 | 上游 ZCode 官方文档 | 本说明书 |
| --- | --- | --- |
| 依据 | 官方发布的产品形态 | 当前检出的本仓源码 |
| 产品名 | ZCode | Reactor（数智堆脑） |
| 模型接入 | 官方 GLM Coding Plan / Z.ai / BigModel 等 | 内网自建服务端与模型网关，含企业目录白名单 |
| 新增能力 | — | 界面模式（编程 / 办公 / 审查）、文件审查板块、内网办公四件套、模型治理等 |
| 在线商业与社群内容 | 下载、套餐、社群、额度重置等 | 已删除，替换为内网部署与分发方式 |

> **提示**：本说明书是离线站点，双击任意 `.html` 即可浏览，不依赖网络、不请求任何外部资源。
> 若你只是想确认某条行为是否与本仓源码一致，请以源码、`package.json` 与 `docs/` 下的契约为准。

## 目录

| 章节 | 包含内容 |
| --- | --- |
| [开始使用](welcome.html) | [概述与核心能力](welcome.html) · [安装与部署](install.html) · [接入模型](model-access.html) · [反馈与支持](feedback.html) |
| 核心功能 | [Reactor Agent](agent.html) · [目标模式](goal.html) · [项目记忆](memory.html) · [仓库百科](repo-wiki.html) · [任务与文件管理](task-management.html) · [编辑历史对话](edit-history.html) |
| 核心功能（续） | [定时任务](automations.html) · [闲时任务](idle-time-tasks.html) · [远程开发](remote-development.html) · [手机远控](remote-control.html) · [子智能体](subagents.html) · [浏览器自动化](browser-use.html) |
| 扩展体系 | [插件](plugin.html) · [技能](skill.html) · [MCP](mcp.html) · [命令](command.html) · [Hooks](hooks.html) |
| 本仓特有功能 | [界面模式](interface-modes.html) · [文件审查板块](review-panel.html) · [内网办公四件套](office-suite.html) · [模型治理与开发者模式](model-governance.html) · [数据目录与背景主题契约](data-contracts.html) |
| 内网服务端 | [服务端总览与接线](server-overview.html) · [技能与 Agent 下发](server-delivery.html) · [用量上报与策略下发](server-usage-policy.html) |
| 帮助 | [快捷键表](keyboard-shortcuts.html) · [常见问题](qa.html) · [Linux / WSL 排查](linux-wsl.html) · [与上游 ZCode 的差异](upstream-diff.html) |

## 阅读建议

1. **第一次接触**：先读[概述与核心能力](welcome.html)，再按[安装与部署](install.html)、[接入模型](model-access.html)把环境跑起来。
2. **日常使用**：重点看[Reactor Agent](agent.html)的补充上下文与[执行模式](agent.html)，以及[快捷键表](keyboard-shortcuts.html)。
3. **管理员与系统集成**：读「内网服务端」三章，配合[模型治理与开发者模式](model-governance.html)。
4. **排查差异**：遇到行为与预期不符时，先看[常见问题](qa.html)与[与上游 ZCode 的差异](upstream-diff.html)。

## 关于本说明书的边界

- 本说明书只描述**当前仓库提供的功能、命令与文件**；不存在的功能不写入，已移除的功能同步删除。
- 涉及状态所有者、事件顺序、失败语义的内容，以 `docs/` 下对应契约文档为准，本说明书只做面向使用者的转述。
- 上游官方文档中的在线服务（下载站、套餐权益、社群入口、额度重置卡、Bot Channel 等）与内网隔离部署场景无关，本说明书不再收录。
