# Reactor 文档

本目录存放 Reactor（ZCode 二开产品）相关的设计与工程文档。

| 文档                                                                 | 内容                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [REACTOR-REBRAND-PLAN.md](REACTOR-REBRAND-PLAN.md)                   | 去 ZCode 化改造方案：分层清单、决策记录、风险与合规（勾选框已按源码核对同步）                         |
| [服务端接线-方案-v1.md](服务端接线-方案-v1.md)                       | **桌面端 ↔ 自建服务端接线**：产品规则、状态所有者、服务端契约、P1–P4 分阶段与验收                     |
| [data-directory-contract.md](data-directory-contract.md)             | **用户数据目录契约**：唯一所有者、用户级/工作区级边界、可覆盖项、失败语义、有意保留清单               |
| [interface-mode.md](interface-mode.md)                               | **界面模式（编程/办公）契约**：状态所有者、全部入口、分段控件唯一实现、主面板入口显示规则与验收场景   |
| [appearance-background-theme.md](appearance-background-theme.md)     | **背景主题契约**：主区域背景层、模糊/覆盖色参数、渲染契约与验收场景                                   |
| [model-governance-and-dev-mode.md](model-governance-and-dev-mode.md) | **模型治理契约**：本地模型配置的开发者模式隐藏策略（连点版本号 7 下）、企业目录即白名单               |
| [model-provider-catalog-pull.md](model-provider-catalog-pull.md)     | **模型目录拉取契约**：一键拉取 `/models` 的 host 侧执行边界、URL/鉴权策略、勾选与批量添加语义         |
| [服务端接线-P4-用量上报与策略.md](服务端接线-P4-用量上报与策略.md)   | **P4 开工计划**：用量上报（model_call）、桌面策略天花板、outbox/契约与阶段验收                        |
| [server-skill-delivery-plan.md](server-skill-delivery-plan.md)       | **P2 技能下发实施计划**：目标、旧项目取舍、步骤、风险与验收                                           |
| [server-skill-sync.md](server-skill-sync.md)                         | **服务端技能同步契约**：状态所有者、同步时序、失败语义与验收场景                                      |
| [服务端接线-P3-Agent下发.md](服务端接线-P3-Agent下发.md)             | **P3 Agent 下发开工计划**：server scope 物化、字段映射、发现层/precedence、同步器步骤、风险与验收     |
| [专家技能市场-方案-v1.md](专家技能市场-方案-v1.md)                   | **专家·技能市场方案**：参考图功能清单、复用/新建决策、前端设计（壳/卡片/详情/管理）、分期与数据源缺口 |
| [brand/](brand/README.md)                                            | 品牌素材与生产资产清单；**唯一产品标记为立方体**（风车系列仅存档），色板与待补齐项                    |
| [../server/README.md](../server/README.md)                           | **Reactor 服务端**（身份底座 + 模型网关 + 管理台 API）：搬迁边界、目录结构、运行与冒烟命令            |

## 说明

- 仓库根目录的既有文档各司其职，不迁入此处：`AGENTS.md`（编码代理规则）、`DESIGN.md`（UI 设计系统）、`CONTEXT.md`（插件商店领域词汇）、`README.md`（面向使用者的说明）、`NOTICE.md` / `THIRD-PARTY-NOTICES.md`（合规声明）。
- `knip.json` 已将 `docs/**` 排除在未使用依赖检查之外，本目录不参与构建与打包。
- `server/` 是从旧独立项目 Reactor-Desktop 搬来的**服务端独立 pnpm workspace**：它自带 README 与 AGENTS.md，不在本仓 `pnpm-workspace.yaml` 内，也不参与本仓 lint / fmt / 架构门禁。
