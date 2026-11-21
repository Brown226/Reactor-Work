# -*- coding: utf-8 -*-
# 示例：空腹桁架节点（StruModel，纯几何路线）—— 多块壳板拼焊接钢节点（通用几何线/面）
# 路线：结构（几何）模型；收口 = StruModel.toViewer()（与原示例一致，网格在界面设置后划分）
# 单位制：mm-t 制（setting.iTypeSI = 2）→ 长度 mm / 力 N / 应力·弹模 MPa / 密度 t/mm3
# 来源：PkpmCAE 自带示例 resources/example/1.2通用仿真-固体力学-空腹桁架节点/建模脚本/node_model_stru.py
# 要点：① 每块壳板 = 一个 Surf(outer=[线构件 id...])，边界线必须首尾相接成闭环（4 条边可为四边形，
#          也可 6 条边围成六边形，见 group_2 的 z=-650 平面板）；
#       ② 相邻板共用同一条 Line（如 lines_4_side / lines_4_z0 / lines_4_cross 被多块板反复引用，
#          group_6 的隔板还复用了 group_5 的弦杆线）——重复建线会产生重叠构件；
#       ③ 板厚由壳截面 SingleLayer(mid=..., t=...) 给定，同一厚度可复用一个 Section；
#       ④ 这里的 87 条线全部是"几何边线"（不挂截面 sid）——只有需要生成梁单元的线构件才挂
#          SectionType.Line 截面；壳板单元由 Surf + 壳截面生成，几何边线只定义面的边界；
#       ⑤ 同坐标点必须共用同一个 Node 对象：原示例 group_1 与 group_4 在 z=-1300 处各建了 4 个
#          角点，平台校验会报"几何错误: 节点坐标重复定义"（本示例已改为共用，见下方差异说明）；
#       ⑥ 节点区模型不带支座/荷载（原示例的 5 个 coupling 参考点供后续有限元阶段做耦合/约束用）。
# 与官方示例的差异（几何形状完全一致，构件数有一处刻意合并）：
#   - Wire → Line（手册 documented 名，实测同为线构件 iMark=61）；Surf([...]) → Surf(outer=[...])；
#   - MatDB.assemble(type=...) → iType=...（手册形参名，实测两者均可，统一用 iType）；
#   - 删除未使用的 from pypcae.utils import MathUtil；构造类改关键字传参；
#   - group_1 与 group_4 在 z=-1300 处的 4 个角点及 4 条顶边，原示例各建了一次（4 组重合节点 +
#     4 条重合线，平台校验会报"节点坐标重复定义"），本示例改为共用同一 Node / Line
#     → 节点数 64→60、线构件 91→87，面构件数与几何形状不变。
# 实测：PkpmCAE pypcae 2.1.0（last release 20261230）——几何路线执行成功（节点 60 / 线 87 /
#       面 37，落盘 pypcae/pypcae.stru）；另测可选网格 basicSize=150 mm → 1126 节点 / 1068 个
#       四边形壳单元，耗时约 8 s。

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx

clc()
MatDB.load()

# ========== 1. 全局设置（mm-t 制） ==========
setting = Setting()
setting.iTypeSI = 2                       # 0=自定义 1=m-kg(SI) 2=mm-t

# ========== 2. 材料（标准牌号查库） ==========
mat_steel = MatDB.assemble(name="Q345", iType=MaterialType.Steel,
                           iMark=SteelType.Q345, setting=setting)

# ========== 3. 壳截面（板厚 mm） ==========
sec_bot_45 = Section("bot_plate_t45", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=45))
sec_bot_25 = Section("bot_plate_t25", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=25))
sec_web_30 = Section("web_outer_t30", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=30))
sec_web_16 = Section("web_inner_t16", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=16))
sec_top_45 = Section("top_plate_t45", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=45))
sec_top_25 = Section("top_plate_t25", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=25))

# ========== 4. group_1：下节点箱形段（z=-2100 ~ -1300） ==========
# 4 块壳板：y=±400 两块侧板 t=45，x=±300 两块端板 t=25
nodes_1 = [
    Node(-300, -400, -2100).id,      # 0
    Node(-300, -400, -1300).id,      # 1
    Node(300, -400, -1300).id,       # 2
    Node(300, -400, -2100).id,       # 3
    Node(-300, 400, -2100).id,       # 4
    Node(-300, 400, -1300).id,       # 5
    Node(300, 400, -1300).id,        # 6
    Node(300, 400, -2100).id,        # 7
]
lines_1 = [
    Line(start=nodes_1[0], end=nodes_1[1]).id,     # 0  竖边 x=-300,y=-400
    Line(start=nodes_1[1], end=nodes_1[2]).id,     # 1  z=-1300,y=-400
    Line(start=nodes_1[2], end=nodes_1[3]).id,     # 2  竖边 x=300,y=-400
    Line(start=nodes_1[3], end=nodes_1[0]).id,     # 3  z=-2100,y=-400
    Line(start=nodes_1[4], end=nodes_1[5]).id,     # 4  竖边 x=-300,y=400
    Line(start=nodes_1[5], end=nodes_1[6]).id,     # 5  z=-1300,y=400
    Line(start=nodes_1[6], end=nodes_1[7]).id,     # 6  竖边 x=300,y=400
    Line(start=nodes_1[7], end=nodes_1[4]).id,     # 7  z=-2100,y=400
    Line(start=nodes_1[0], end=nodes_1[4]).id,     # 8  z=-2100,x=-300
    Line(start=nodes_1[1], end=nodes_1[5]).id,     # 9  z=-1300,x=-300
    Line(start=nodes_1[3], end=nodes_1[7]).id,     # 10 z=-2100,x=300
    Line(start=nodes_1[2], end=nodes_1[6]).id,     # 11 z=-1300,x=300
]
Surf(outer=lines_1[0:4], sid=sec_bot_45.id)                                  # y=-400 侧板
Surf(outer=lines_1[4:8], sid=sec_bot_45.id)                                  # y=+400 侧板
Surf(outer=[lines_1[2], lines_1[10], lines_1[6], lines_1[11]], sid=sec_bot_25.id)   # x=+300 端板
Surf(outer=[lines_1[0], lines_1[8], lines_1[4], lines_1[9]], sid=sec_bot_25.id)     # x=-300 端板

# ========== 5. group_2：过渡段（z=-650 六边形板 + 斜腹板） ==========
nodes_2 = [
    Node(-300, -400, -650).id,       # 0
    Node(300, -400, -650).id,        # 1
    Node(300, -300, -650).id,        # 2
    Node(300, 300, -650).id,         # 3
    Node(300, 400, -650).id,         # 4
    Node(-300, 400, -650).id,        # 5
    Node(1500, -300, -798).id,       # 6  斜腹板外伸点（下弦倾斜）
    Node(1500, 300, -798).id,        # 7
]
lines_2 = [
    Line(start=nodes_2[0], end=nodes_2[1]).id,     # 0
    Line(start=nodes_2[1], end=nodes_2[2]).id,     # 1
    Line(start=nodes_2[2], end=nodes_2[3]).id,     # 2
    Line(start=nodes_2[3], end=nodes_2[4]).id,     # 3
    Line(start=nodes_2[4], end=nodes_2[5]).id,     # 4
    Line(start=nodes_2[5], end=nodes_2[0]).id,     # 5
    Line(start=nodes_2[2], end=nodes_2[6]).id,     # 6
    Line(start=nodes_2[6], end=nodes_2[7]).id,     # 7
    Line(start=nodes_2[7], end=nodes_2[3]).id,     # 8
]
Surf(outer=lines_2[0:6], sid=sec_web_30.id)                                  # 六边形水平板（6 条边）
Surf(outer=[lines_2[2], lines_2[6], lines_2[7], lines_2[8]], sid=sec_web_30.id)   # 斜腹板

# ========== 6. group_3：端隔板（z=0 平面） ==========
nodes_3 = [
    Node(300, -300, 0).id,           # 0
    Node(1500, -300, 0).id,          # 1
    Node(1500, 300, 0).id,           # 2
    Node(300, 300, 0).id,            # 3
]
Surf(outer=[
    Line(start=nodes_3[0], end=nodes_3[1]).id,
    Line(start=nodes_3[1], end=nodes_3[2]).id,
    Line(start=nodes_3[2], end=nodes_3[3]).id,
    Line(start=nodes_3[3], end=nodes_3[0]).id,
], sid=sec_web_30.id)

# ========== 7. group_4：上节点板（x=±300 两块对称多边形板，共 18 块壳板） ==========
# z=-1300 处的 4 个角点与 group_1 顶面角点是同一个点 —— 必须复用 group_1 的 Node，
# 重复建点会被平台校验判为"几何错误: 节点坐标重复定义"，且网格后单元不连接。
nodes_4 = [
    Node(-300, -400, 800).id,        # 0
    Node(-300, -400, 0).id,          # 1
    Node(-300, -1500, 0).id,         # 2
    Node(-300, -1500, -1300).id,     # 3
    nodes_1[1],                      # 4   共用 group_1 节点 1：(-300,-400,-1300)
    nodes_1[5],                      # 5   共用 group_1 节点 5：(-300, 400,-1300)
    Node(-300, 1500, -1300).id,      # 6
    Node(-300, 1500, 0).id,          # 7
    Node(-300, 400, 0).id,           # 8
    Node(-300, 400, 800).id,         # 9
    Node(300, -400, 800).id,         # 10
    Node(300, -400, 0).id,           # 11
    Node(300, -1500, 0).id,          # 12
    Node(300, -1500, -1300).id,      # 13
    nodes_1[2],                      # 14  共用 group_1 节点 2：( 300,-400,-1300)
    nodes_1[6],                      # 15  共用 group_1 节点 6：( 300, 400,-1300)
    Node(300, 1500, -1300).id,       # 16
    Node(300, 1500, 0).id,           # 17
    Node(300, 400, 0).id,            # 18
    Node(300, 400, 800).id,          # 19
]
lines_4_side = [                     # 原 wireset_3：板内竖边（x=-300 侧 7 条 + x=+300 侧 7 条）
    Line(start=nodes_4[0], end=nodes_4[9]).id,      # 0
    Line(start=nodes_4[2], end=nodes_4[1]).id,      # 1
    Line(start=nodes_4[1], end=nodes_4[8]).id,      # 2
    Line(start=nodes_4[8], end=nodes_4[7]).id,      # 3
    Line(start=nodes_4[3], end=nodes_4[4]).id,      # 4
    lines_1[9],                                     # 5  共用 group_1 顶边（x=-300, z=-1300）
    Line(start=nodes_4[5], end=nodes_4[6]).id,      # 6
    Line(start=nodes_4[10], end=nodes_4[19]).id,    # 7
    Line(start=nodes_4[12], end=nodes_4[11]).id,    # 8
    Line(start=nodes_4[11], end=nodes_4[18]).id,    # 9
    Line(start=nodes_4[18], end=nodes_4[17]).id,    # 10
    Line(start=nodes_4[13], end=nodes_4[14]).id,    # 11
    lines_1[11],                                    # 12 共用 group_1 顶边（x=+300, z=-1300）
    Line(start=nodes_4[15], end=nodes_4[16]).id,    # 13
]
lines_4_z0 = [                       # 原 wireset_4：z=0 / z=-1300 平面内的横向边
    Line(start=nodes_4[2], end=nodes_4[3]).id,      # 0
    Line(start=nodes_4[0], end=nodes_4[1]).id,      # 1
    Line(start=nodes_4[1], end=nodes_4[4]).id,      # 2
    Line(start=nodes_4[9], end=nodes_4[8]).id,      # 3
    Line(start=nodes_4[8], end=nodes_4[5]).id,      # 4
    Line(start=nodes_4[7], end=nodes_4[6]).id,      # 5
    Line(start=nodes_4[12], end=nodes_4[13]).id,    # 6
    Line(start=nodes_4[10], end=nodes_4[11]).id,    # 7
    Line(start=nodes_4[11], end=nodes_4[14]).id,    # 8
    Line(start=nodes_4[19], end=nodes_4[18]).id,    # 9
    Line(start=nodes_4[18], end=nodes_4[15]).id,    # 10
    Line(start=nodes_4[17], end=nodes_4[16]).id,    # 11
]
lines_4_cross = [                    # 原 wireset_5：x=-300 与 x=+300 之间的横向连线（板厚方向）
    Line(start=nodes_4[0], end=nodes_4[10]).id,     # 0
    Line(start=nodes_4[1], end=nodes_4[11]).id,     # 1
    Line(start=nodes_4[2], end=nodes_4[12]).id,     # 2
    Line(start=nodes_4[3], end=nodes_4[13]).id,     # 3
    lines_1[1],                                     # 4  共用 group_1 顶边（y=-400, z=-1300）
    lines_1[5],                                     # 5  共用 group_1 顶边（y=+400, z=-1300）
    Line(start=nodes_4[6], end=nodes_4[16]).id,     # 6
    Line(start=nodes_4[7], end=nodes_4[17]).id,     # 7
    Line(start=nodes_4[8], end=nodes_4[18]).id,     # 8
    Line(start=nodes_4[9], end=nodes_4[19]).id,     # 9
]
# --- 7a. 节点板横向加劲板（t=25，8 块）：side-z0-side-z0 闭环 ---
Surf(outer=[lines_4_side[0], lines_4_z0[1], lines_4_side[2], lines_4_z0[3]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[1], lines_4_z0[0], lines_4_side[4], lines_4_z0[2]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[2], lines_4_z0[2], lines_4_side[5], lines_4_z0[4]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[3], lines_4_z0[4], lines_4_side[6], lines_4_z0[5]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[7], lines_4_z0[7], lines_4_side[9], lines_4_z0[9]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[8], lines_4_z0[6], lines_4_side[11], lines_4_z0[8]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[9], lines_4_z0[8], lines_4_side[12], lines_4_z0[10]], sid=sec_top_25.id)
Surf(outer=[lines_4_side[10], lines_4_z0[10], lines_4_side[13], lines_4_z0[11]], sid=sec_top_25.id)

# --- 7b. 节点板立面（板厚方向，t=45，6 块）：side-cross-side-cross 闭环 ---
Surf(outer=[lines_4_side[1], lines_4_cross[2], lines_4_side[8], lines_4_cross[1]], sid=sec_top_45.id)
Surf(outer=[lines_4_side[2], lines_4_cross[1], lines_4_side[9], lines_4_cross[8]], sid=sec_top_45.id)
Surf(outer=[lines_4_side[3], lines_4_cross[8], lines_4_side[10], lines_4_cross[7]], sid=sec_top_45.id)
Surf(outer=[lines_4_side[4], lines_4_cross[3], lines_4_side[11], lines_4_cross[4]], sid=sec_top_45.id)
Surf(outer=[lines_4_side[5], lines_4_cross[4], lines_4_side[12], lines_4_cross[5]], sid=sec_top_45.id)
Surf(outer=[lines_4_side[6], lines_4_cross[5], lines_4_side[13], lines_4_cross[6]], sid=sec_top_45.id)

# --- 7c. 节点板平面内板（t=45，4 块）：z0-cross-z0-cross 闭环 ---
Surf(outer=[lines_4_z0[1], lines_4_cross[1], lines_4_z0[7], lines_4_cross[0]], sid=sec_top_45.id)
Surf(outer=[lines_4_z0[2], lines_4_cross[4], lines_4_z0[8], lines_4_cross[1]], sid=sec_top_45.id)
Surf(outer=[lines_4_z0[3], lines_4_cross[8], lines_4_z0[9], lines_4_cross[9]], sid=sec_top_45.id)
Surf(outer=[lines_4_z0[4], lines_4_cross[5], lines_4_z0[10], lines_4_cross[8]], sid=sec_top_45.id)

# ========== 8. group_5：空腹桁架腹杆区（内腹板 t=16，8 块） ==========
nodes_5 = [
    Node(300, 0, -650).id,           # 0
    Node(900, 0, -720).id,           # 1
    Node(1500, 0, -798).id,          # 2
    Node(300, 0, -450).id,           # 3
    Node(900, 0, -450).id,           # 4
    Node(1500, 0, -450).id,          # 5
    Node(300, 0, 0).id,              # 6
    Node(900, 0, 0).id,              # 7
    Node(1500, 0, 0).id,             # 8
    Node(300, -300, -450).id,        # 9
    Node(900, -300, -450).id,        # 10
    Node(1500, -300, -450).id,       # 11
    Node(300, 300, -450).id,         # 12
    Node(900, 300, -450).id,         # 13
    Node(1500, 300, -450).id,        # 14
]
lines_5_chord = [                    # 原 wireset_6：y=0 / y=±300 四条弦杆线（各 2 段）
    Line(start=nodes_5[0], end=nodes_5[1]).id,      # 0
    Line(start=nodes_5[1], end=nodes_5[2]).id,      # 1
    Line(start=nodes_5[3], end=nodes_5[4]).id,      # 2
    Line(start=nodes_5[4], end=nodes_5[5]).id,      # 3
    Line(start=nodes_5[6], end=nodes_5[7]).id,      # 4
    Line(start=nodes_5[7], end=nodes_5[8]).id,      # 5
    Line(start=nodes_5[9], end=nodes_5[10]).id,     # 6
    Line(start=nodes_5[10], end=nodes_5[11]).id,    # 7
    Line(start=nodes_5[12], end=nodes_5[13]).id,    # 8
    Line(start=nodes_5[13], end=nodes_5[14]).id,    # 9
]
lines_5_vert = [                     # 原 wireset_7：z 向竖杆（y=0 平面）
    Line(start=nodes_5[0], end=nodes_5[3]).id,      # 0
    Line(start=nodes_5[3], end=nodes_5[6]).id,      # 1
    Line(start=nodes_5[1], end=nodes_5[4]).id,      # 2
    Line(start=nodes_5[4], end=nodes_5[7]).id,      # 3
    Line(start=nodes_5[2], end=nodes_5[5]).id,      # 4
    Line(start=nodes_5[5], end=nodes_5[8]).id,      # 5
]
lines_5_y = [                        # 原 wireset_8：y 向连杆（±300 与 0 之间）
    Line(start=nodes_5[9], end=nodes_5[3]).id,      # 0
    Line(start=nodes_5[3], end=nodes_5[12]).id,     # 1
    Line(start=nodes_5[10], end=nodes_5[4]).id,     # 2
    Line(start=nodes_5[4], end=nodes_5[13]).id,     # 3
    Line(start=nodes_5[11], end=nodes_5[5]).id,     # 4
    Line(start=nodes_5[5], end=nodes_5[14]).id,     # 5
]
# --- 8a. y=0 平面内腹板（t=16，4 块）：chord-vert-chord-vert 闭环 ---
Surf(outer=[lines_5_chord[0], lines_5_vert[2], lines_5_chord[2], lines_5_vert[0]], sid=sec_web_16.id)
Surf(outer=[lines_5_chord[1], lines_5_vert[4], lines_5_chord[3], lines_5_vert[2]], sid=sec_web_16.id)
Surf(outer=[lines_5_chord[2], lines_5_vert[3], lines_5_chord[4], lines_5_vert[1]], sid=sec_web_16.id)
Surf(outer=[lines_5_chord[3], lines_5_vert[5], lines_5_chord[5], lines_5_vert[3]], sid=sec_web_16.id)

# --- 8b. y=±300 与 y=0 之间腹板（t=16，4 块）：chord-yLink-chord-yLink 闭环 ---
Surf(outer=[lines_5_chord[6], lines_5_y[2], lines_5_chord[2], lines_5_y[0]], sid=sec_web_16.id)
Surf(outer=[lines_5_chord[7], lines_5_y[4], lines_5_chord[3], lines_5_y[2]], sid=sec_web_16.id)
Surf(outer=[lines_5_chord[2], lines_5_y[3], lines_5_chord[8], lines_5_y[1]], sid=sec_web_16.id)
Surf(outer=[lines_5_chord[3], lines_5_y[5], lines_5_chord[9], lines_5_y[3]], sid=sec_web_16.id)

# ========== 9. group_6：中间隔板（y=±300 之间 4 块 t=16 腹板） ==========
nodes_6 = [
    Node(900, -300, -724).id,        # 0
    Node(900, 300, -724).id,         # 1
    Node(900, 300, 0).id,            # 2
    Node(900, -300, 0).id,           # 3
]
Surf(outer=[Line(start=nodes_6[0], end=nodes_5[1]).id, lines_5_vert[2],
            lines_5_y[2], Line(start=nodes_5[10], end=nodes_6[0]).id], sid=sec_web_16.id)
Surf(outer=[Line(start=nodes_5[1], end=nodes_6[1]).id, Line(start=nodes_6[1], end=nodes_5[13]).id,
            lines_5_y[3], lines_5_vert[2]], sid=sec_web_16.id)
Surf(outer=[lines_5_y[2], lines_5_vert[3], Line(start=nodes_5[7], end=nodes_6[3]).id,
            Line(start=nodes_6[3], end=nodes_5[10]).id], sid=sec_web_16.id)
Surf(outer=[lines_5_y[3], Line(start=nodes_5[13], end=nodes_6[2]).id,
            Line(start=nodes_6[2], end=nodes_5[7]).id, lines_5_vert[3]], sid=sec_web_16.id)

# ========== 10. 耦合参考点（原示例保留：供后续有限元阶段做 Coupling/约束的主控点） ==========
nodes_coupling = [
    Node(0, 1500, -650).id,
    Node(0, -1500, -650).id,
    Node(0, 0, 800).id,
    Node(1500, 0, -405).id,
    Node(0, 0, -2100).id,
]

# ========== 11.（可选）自动划分网格 ==========
# 原示例不含网格设置。若要脚本内划分：MeshParams 写在 toViewer() 之前，submitAndMesh() 写在其后，
# MeshParams(sizer=Size(isBasic=True, basicSize=150.0, beamSize=150.0,
#                       wallSize=150.0, plateSize=150.0, densifyLevel=0), toQuad="true")
# 实测（basicSize=150 mm ≈ 3~9 倍板厚）：1126 节点 / 1068 个四边形壳单元，约 8 s。
# 节点区应力集中，正式分析建议再加密（如 75 mm）并做网格收敛性对比（见 ../../reference/verification.md）。

# ========== 12. 收口（结构模型路线） ==========
StruModel.toViewer()
# StruModel.submitAndMesh()      # 需要脚本内划网格时再打开

# ========== 验证要点 ==========
# 构件计数（实测 pypcae/pypcae.stru 与本式一致）：
#   节点 = 8(g1) + 8(g2) + 4(g3) + 16(g4 新建，另 4 个复用 g1) + 15(g5) + 4(g6) + 5(耦合点) = 60
#   线构件 = 12(g1) + 9(g2) + 4(g3) + 32(g4 新建，另 4 条复用 g1 顶边) + 22(g5: 10+6+6)
#            + 8(g6 新建) = 87
#   面构件 = 4(g1) + 2(g2) + 1(g3) + 18(g4) + 8(g5) + 4(g6) = 37
#   材料 1（Q345）、截面 6（t=45/25/30/16/45/25）
# 单位自检：mm-t 制下 Q345 应为 E0=206000 MPa、density=7.85e-9 t/mm3、plasPara=[345,470,...]
# 包围盒（实测）：X[-300,1500] Y[-1500,1500] Z[-2100,800] mm
# 截面（实测）：6 个壳截面，厚度依次为 45/25/30/16/45/25 mm
# 说明：save_script 校验会提示"缺少 FemModel 导入/收口""Z 坐标异常大""无荷载工况"——
#       纯几何路线 + mm-t 单位制下属预期提示，不影响执行（见 ../../docs/platform_tools.md）。
# 界面：几何模型页面执行后视图刷新；本脚本为纯几何脚本，有限元页面执行不会刷新
