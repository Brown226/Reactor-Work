# Reactor 文档

本目录存放 Reactor（ZCode 二开产品）相关的设计与工程文档。

| 文档                                                     | 内容                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [REACTOR-REBRAND-PLAN.md](REACTOR-REBRAND-PLAN.md)       | 去 ZCode 化改造方案：分层清单、决策记录、风险与合规                                                 |
| [data-directory-contract.md](data-directory-contract.md) | **用户数据目录契约**：唯一所有者、用户级/工作区级边界、可覆盖项、失败语义、有意保留清单             |
| [interface-mode.md](interface-mode.md)                   | **界面模式（编程/办公）契约**：状态所有者、全部入口、分段控件唯一实现、主面板入口显示规则与验收场景 |
| [appearance-background-theme.md](appearance-background-theme.md) | **背景主题契约**：主区域背景层、模糊/覆盖色参数、渲染契约与验收场景                 |
| [brand/](brand/README.md)                                | 品牌素材（图形标记、字标、色板）与待补齐的生产资产清单                                              |
| [../server/README.md](../server/README.md)               | **Reactor 服务端**（身份底座 + 模型网关 + 管理台 API）：搬迁边界、目录结构、运行与冒烟命令          |

## 说明

- 仓库根目录的既有文档各司其职，不迁入此处：`AGENTS.md`（编码代理规则）、`DESIGN.md`（UI 设计系统）、`CONTEXT.md`（插件商店领域词汇）、`README.md`（面向使用者的说明）、`NOTICE.md` / `THIRD-PARTY-NOTICES.md`（合规声明）。
- `knip.json` 已将 `docs/**` 排除在未使用依赖检查之外，本目录不参与构建与打包。
- `server/` 是从旧独立项目 Reactor-Desktop 搬来的**服务端独立 pnpm workspace**：它自带 README 与 AGENTS.md，不在本仓 `pnpm-workspace.yaml` 内，也不参与本仓 lint / fmt / 架构门禁。
