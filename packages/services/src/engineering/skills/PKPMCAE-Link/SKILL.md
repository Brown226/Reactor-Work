---
name: pkpmcae-link
description: 通过 PKPMCAE 的 PyPCAE API 与平台工具完成有限元建模、构件与几何建模、自动网格、混合建模、分析计算、脚本诊断和按用户要求的结果读取。用于明确涉及 PKPMCAE、PKPM-CAE、PyPCAE 或已有该软件项目/脚本的任务；不用于 PKPM 建筑结构设计软件或其他 CAE 软件。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# PKPMCAE-Link

使用 PKPMCAE 的 API 按用户规格建模、运行并交付产物。只在需要的环节读取对应参考资料。

## 开始任务

1. 首次执行项目操作前，读 [平台工具](references/platform_tools.md)，确认连接、当前项目及实际工具签名。
2. 根据下表选路线；有歧义时读 [路线判据](references/routes.md)。选定后只加载对应路线资料。
3. 建模、网格或计算任务按 [工作流程](references/workflow.md) 与 [执行契约](references/execution_contract.md) 执行；API 查询或脚本解释只读取相关主题。

| 任务 | 路线 | 首先读取 |
|---|---|---|
| 直接用节点和单元建模、手工控制网格并求解 | 有限元 | [执行规则](references/fem/guide.md)、[脚本标准](references/fem/script_standard.md) |
| 按构件或线/面/体建立几何模型，按需自动网格，脚本内不求解 | 几何 | [执行规则](references/stru/guide.md)、[几何 API](references/stru/stru_model.md) |
| 几何建模 → 自动网格 → 有限元模型 → 求解 | 混合 | [执行规则与五步时序](references/stru/guide.md)、[阶段划分](references/stru/shared_api.md) |

“要有限元模型”不等于必须选有限元路线；混合路线也产出有限元模型。复杂曲面先确认几何表达能力，不静默切换路线。

## 共用约束

- 保留用户给定的几何、材料、边界、荷载与分析要求。关键规格缺失时先澄清；默认值、估算和等效假设必须注明。
- API 参数、枚举、单位和执行顺序以本技能中对应路线的用法与实际软件版本为依据，不编造接口。区分手册记载与未验证能力。
- 软件脚本与 Agent 本地代码分开：软件内嵌 Python 禁止 print、中文标识符和第三方库；本地日志处理按平台说明执行。
- 标准牌号调用材料库；脚本单位统一。节点与构件按对象 id 引用，路线切换后按规则重新取编号。
- 完成规定的产物存在性核对后交付并停止。未经用户明确要求，不自动分析结果、优化模型、做收敛研究或重跑。具体修复边界与例外见执行契约。
- 用户明确指令优先于模板约定；不为满足模板或工具校验改变用户要求。

## 按主题读取

下表路径均相对技能根目录。使用 `use_skill('pkpmcae-link', file='<完整相对路径>')` 读取；不要只传叶文件名，也不要把其他参考文档当作独立技能加载。

| 主题 | 有限元路线 | 几何/混合路线 |
|---|---|---|
| 参数提取、生成流程 | [generation](references/fem/generation.md) | [generation](references/stru/generation.md) |
| 材料、截面、单位 | [material_section](references/fem/material_section.md) | [material_section](references/stru/material_section.md) |
| 节点、单元、集合 | [nodes_elements](references/fem/nodes_elements.md) | [shared_api](references/stru/shared_api.md) |
| 构件、线面体、开洞、几何清理 | — | [stru_model](references/stru/stru_model.md) |
| 自动网格、尺寸与模式 | — | [mesh](references/stru/mesh.md) |
| 支座与约束 | [supports](references/fem/supports.md) | [supports](references/stru/supports.md) |
| 绑定、耦合、嵌入、接触、连接器 | [interactions](references/fem/interactions.md) | [interactions](references/stru/interactions.md) |
| 荷载与工况 | [loads](references/fem/loads.md) | [loads](references/stru/loads.md) |
| 分析设置、任务指派、多任务 | [analysis](references/fem/analysis.md) | [analysis](references/stru/analysis.md) |
| 附加质量、偏心、铰接、抑制 | [model_modification](references/fem/model_modification.md) | [model_modification](references/stru/model_modification.md) |
| 条件查询 | [query](references/fem/query.md) | [query](references/stru/query.md) |
| 枚举与单元面号 | [enums](references/fem/enums.md) | [enums](references/stru/enums.md) |
| 报错与日志诊断 | [error_diagnosis](references/fem/error_diagnosis.md) | [error_diagnosis](references/stru/error_diagnosis.md) |
| 已知问题、未验证能力 | [known_issues](references/fem/known_issues.md) | [known_issues](references/stru/known_issues.md) |
| 连接器本构/阻尼/限位、**卸载（`keyInherit`+系数 −1）**、`Wpload` 方向、`VSABoundary` | [known_issues](references/fem/known_issues.md) #201~#212 | [known_issues](references/stru/known_issues.md) #201~#207 |
| 产物核对；用户要求后的验证 | [verification](references/fem/verification.md) | [verification](references/stru/verification.md) |

结果文件格式与读取约束见 [result_analysis](references/fem/result_analysis.md)，按当前分析类型与文件头使用。示例按需从 [示例索引](references/examples.md) 选择；尺寸、材料和网格必须替换为用户规格，不照搬示例取值。

## 查手册

内置手册（**2026-10-29 15:29 版，3393 行 / 151192 B**）按关键词、章节或枚举查询，不整本载入上下文：

~~~python
use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='"AnalySetting"')
use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='--list')
use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='--section 2.9.8')
use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='--enum AnaType')
~~~

一次查询一个关键词。未命中时改查章节或枚举，不能据此认定软件不支持。文档与实际工具信息不一致时保留疑点并告知用户；不要覆盖已确认用法或将未验证签名当作可用能力承诺。
