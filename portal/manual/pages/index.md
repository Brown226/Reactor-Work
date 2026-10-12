# Reactor 产品说明书

**Reactor（数智堆脑）** 是面向内网环境部署的 Agentic Development Environment（ADE）：把大模型的长上下文与长程任务能力，落到桌面端、Web 端与终端里可连续推进的开发工作流上。

本说明书**依据当前检出的源码整理**，描述的是本仓库实际提供的能力、命令、配置项与文件位置。取材依据、称谓口径与内容边界统一见[关于本说明书](about.md)。

> **提示**：本说明书是离线站点，双击任意 `.html` 即可浏览，不依赖网络、不请求任何外部资源。

## 目录

| 章节 | 包含内容 |
| --- | --- |
| [开始使用](welcome.html) | [概述与核心能力](welcome.html) · [安装与部署](install.html) · [接入模型](model-access.html) · [反馈与支持](feedback.html) |
| 核心功能 | [Reactor Agent](agent.html) · [目标模式](goal.html) · [项目记忆](memory.html) · [仓库百科](repo-wiki.html) · [任务与文件管理](task-management.html) · [编辑历史对话](edit-history.html) |
| 核心功能（续） | [定时任务](automations.html) · [闲时任务](idle-time-tasks.html) · [远程开发](remote-development.html) · [子智能体](subagents.html) · [浏览器自动化](browser-use.html) |
| 扩展体系 | [插件](plugin.html) · [技能](skill.html) · [MCP](mcp.html) · [命令](command.html) · [Hooks](hooks.html) |
| 本仓特有功能 | [界面模式](interface-modes.html) · [文件审查板块](review-panel.html) · [内网办公四件套](office-suite.html) · [模型治理与开发者模式](model-governance.html) · [数据目录与背景主题契约](data-contracts.html) |
| 内网服务端 | [服务端总览与接线](server-overview.html) · [软件包分发与自动更新](software-update.html) · [技能与 Agent 下发](server-delivery.html) · [用量上报与策略下发](server-usage-policy.html) |
| 帮助 | [快捷键表](keyboard-shortcuts.html) · [常见问题](qa.html) · [Linux / WSL 排查](linux-wsl.html) · [关于本说明书](about.html) |

## 阅读建议

1. **第一次接触**：先读[概述与核心能力](welcome.html)，再按[安装与部署](install.html)、[接入模型](model-access.html)把环境跑起来。
2. **日常使用**：重点看[Reactor Agent](agent.html)的补充上下文与[执行模式](agent.html)，以及[快捷键表](keyboard-shortcuts.html)。
3. **管理员与系统集成**：读「内网服务端」三章，配合[模型治理与开发者模式](model-governance.html)。
4. **排查问题**：遇到行为与预期不符时，先看[常见问题](qa.html)。
