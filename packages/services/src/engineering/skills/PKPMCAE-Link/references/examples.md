# 示例索引

选择与任务路线和分析类型匹配的示例，再按用户规格修改。示例中的理论值和验证注释仅在用户要求验证时使用；默认交付边界见 `references/execution_contract.md`。

## 有限元路线

| 文件（相对技能根目录） | 用途 |
|---|---|
| `examples/fem/beam_simply_supported.py` | 示例：简支梁（入门）—— FemModel 有限元模型，线性静力 |
| `examples/fem/buckling_column.py` | 分析类型: 屈曲（线性特征值屈曲） |
| `examples/fem/cantilever_verification.py` | 示例：悬臂梁验证算例 —— 最小规模验证模型正确性的标准做法 |
| `examples/fem/connector_spring_series.py` | 示例：连接器（Connector）弹簧串联传力 —— 「连接器为唯一传力路径」最小验证模型 |
| `examples/fem/construction_stage.py` | 分析类型: 静力（单元生死，两阶段施工模拟） |
| `examples/fem/continuous_beam_bridge.py` | 示例：三跨连续梁桥 —— DL(自重) + LL(车道均布) + 包络步 |
| `examples/fem/elastic_foundation_beam.py` | 分析类型: 静力 |
| `examples/fem/frame_2d.py` | 示例：平面刚架 —— 两柱一梁，柱脚固结，梁跨中集中力 |
| `examples/fem/golden_gate_suspension_bridge.py` | 示例：金门大桥悬索桥 —— 双塔双缆全桥（静力 DL/LL/包络 + 模态前 30 阶，JobManager 切换任务） |
| `examples/fem/gravity_dam_multi_task.py` | 分析类型: 静力 + 规范谱 + 隐式动力时程 (单脚本多任务) |
| `examples/fem/harmonic_beam.py` | 分析类型: 谐响应分析 |
| `examples/fem/modal_frame.py` | 示例：三层框架模态分析 —— AnalySetting(anaType=MODAL, nModal=...) |
| `examples/fem/postbuckling_column.py` | 分析类型: 极限承载力分析（POSTBUCK，几何非线性弧长类） |
| `examples/fem/rc_plate_shell_rebar_layer.py` | 分析类型: 线性静力 |
| `examples/fem/rc_silo_shell_rebar_layer.py` | 分析类型: 线性静力 |
| `examples/fem/shell_plate.py` | 示例：四边简支板（壳单元）—— 面荷载 + 边界约束 |
| `examples/fem/silo_industrial_hydrostatic_modal.py` | 分析类型: 线性静力 + 模态（同一模型内两个分析任务, CUR_TASK 开关逐任务提交） |
| `examples/fem/sleeve_interference_contact.py` | 分析类型: 静力接触(几何非线性 + SuperElement超级接触单元) |
| `examples/fem/solid_cantilever.py` | 分析类型: 静力 |
| `examples/fem/spectrum_frame.py` | 分析类型: 规范谱分析（抗震反应谱） |
| `examples/fem/tank_water_pressure.py` | 分析类型: 静力 |
| `examples/fem/thermal_continuous_beam.py` | 分析类型: 静力（温度 + 支座沉降） |
| `examples/fem/time_history_beam.py` | 分析类型: 隐式动力（时程分析） |
| `examples/fem/truss_3d.py` | 分析类型: 静力 |
| `examples/fem/tunnel_shield_excavation.py` | 分析类型: 静力施工步进(单元生死, 26步) |

## 几何路线

| 文件（相对技能根目录） | 用途 |
|---|---|
| `examples/stru/stru_cable_stayed_bridge.py` | 示例：双塔斜拉桥（StruModel，纯几何路线）—— 通用几何线/面构件搭大跨桥梁 |
| `examples/stru/stru_industrial_silo.py` | 示例：立式圆形料仓 / 工业筒仓（StruModel，纯几何路线）—— 回转体壳 + 环向加劲肋 |
| `examples/stru/stru_multi_story.py` | 示例：多层框架结构模型（StruModel，纯几何路线）—— 梁柱板构件 + 自动网格划分 |
| `examples/stru/stru_open_web_truss_node.py` | 示例：空腹桁架节点（StruModel，纯几何路线）—— 多块壳板拼焊接钢节点（通用几何线/面） |
| `examples/stru/stru_solid_geometry.py` | 示例：通用几何模型（StruModel）—— 圆柱 + 圆锥组合体（Line → Surf → Solid 拓扑）+ 自动网格 |
| `examples/stru/cyl_shell_tripatch.py` | 示例：圆柱壳 · `SurfType.TriPatch` 三角面片离散面（壳路线最小配方，2026-10-16 实机通过） |
| `examples/stru/sphere_tripatch_solid_uv.py` | 示例：球面 · TriPatch 面片拼闭合实体（`Solid` + 三角面片表） |

## 混合路线

| 文件（相对技能根目录） | 用途 |
|---|---|
| `examples/mixed/blade_lofted_solid_modal.py` | 示例：59 m 风电叶片气动外形实体 + 模态（混合路线 · 三角面片放样拼 Solid 的通用配方） |
| `examples/mixed/concrete_splitting_tensile.py` | 示例：混凝土圆柱劈裂抗拉（Brazilian splitting）试验 —— 混合路线 + 刚性垫条力控制 |
| `examples/mixed/connector_spring_series.py` | 示例：连接器（Connector）· 混合路线 —— 几何 → 自动网格 → 有限元 → 连接器 → 求解 |
| `examples/mixed/rc_column_axial_compression.py` | 示例：钢筋混凝土柱轴压模型（混合路线 · 钢筋 Embeded 嵌入实体） |
| `examples/mixed/silo_wholecircle_boxrib_wp.py` | 示例：钢筋混凝土工业筒仓 D18×H30（混合路线 · 整圆回转面 + 闭合矩形环撑 + 节点级储料压 + 静水压） |
| `examples/mixed/solid_beam_simply_supported.py` | 示例：实体简支梁（混合路线）—— 规则长方体 Solid + **六面体扫掠网格** + 顶面 Ebsload 均布面压 + 线性静力 |
| `examples/mixed/sphere_solid_selfweight.py` | 示例：实心球体自重静力（混合路线）—— 球冠面拼整球 + 实体网格 + 线性静力 |
| `examples/mixed/steel_joint_solid_round_holes.py` | 示例：J-1 栓焊混合梁柱节点三维实体（混合路线 · 真圆弧孔 + 真圆柱螺栓 + 实体分割分区网格） |
| `examples/mixed/stru_to_fem_mixed.py` | 示例：几何模型 → 网格划分 → 有限元计算（混合路线，同一脚本跑完全过程） |
| `examples/mixed/cyl_shell_tripatch_mixed.py` | 示例：圆柱壳 TriPatch 面片 → 自动网格 → 有限元 → 求解（混合路线） |
