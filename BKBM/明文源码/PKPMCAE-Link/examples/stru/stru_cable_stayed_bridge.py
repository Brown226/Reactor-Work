# -*- coding: utf-8 -*-
# 示例：双塔斜拉桥（StruModel，纯几何路线）—— 通用几何线/面构件搭大跨桥梁
# 路线：结构（几何）模型；收口 = StruModel.toViewer()（与原示例一致，网格在界面设置后划分）
# 单位制：mm-t 制（setting.iTypeSI = 2）→ 长度 mm / 力 N / 应力·弹模 MPa / 密度 t/mm3 / 加速度 mm/s2
# 来源：PkpmCAE 自带示例 resources/example/1.1通用仿真-固体力学-双塔斜拉桥/建模脚本/双塔斜拉桥.py
# 要点：① 线构件一律挂 SectionType.Line 截面、桥面板挂 SectionType.Surface 壳截面；
#       ② 相交构件在交点必须共用同一个 Node（本例桥面节点同时是桥墩/塔柱/拉索的端点）；
#       ③ 圆弧/整圆 Line 才需要 center+kp，直线段只给 start/end；
#       ④ Surf(outer=[...]) 的边界线要首尾相接成闭环，绕序决定面法向；
#       ⑤ Tube 必须全位置参数 Tube(mid, D, d)（实测第 3 参为内径 d，手册/list_shapes 误作 t，见 ../../docs/ERRATA.md）
# 与官方示例的差异（几何与数量完全一致）：
#   - Wire/WireType（旧名）→ Line/LineType（手册 documented 名，实测同一构件类型 iMark=61）；
#   - MatDB.assemble(type=...) → iType=...（手册形参名）；构造类改关键字传参（Tube 除外）；
#   - 方向向量归一化改为一次性归一（原式逐分量重复用已改写的 n1，本例方向均沿坐标轴，结果不变）；
#   - 修正原式笔误：第二座塔柱起点 z 取 arrBridgeRNods[id2].z（原写 [id1].z；桥面节点 z 均为 0，几何不变）；
#   - 删除未使用的 Material(name="测试材料")（空材料无参数，标准牌号一律走 MatDB）。
# 实测：PkpmCAE pypcae 2.1.0（last release 20261230）——几何路线执行成功（节点 237 / 线 450 /
#       面 116，落盘 pypcae/pypcae.stru）；另测可选网格 basicSize=1500 mm → 4265 节点 / 5174 单元
#       （3782 梁单元 + 1392 四边形壳单元），耗时约 9 s。

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx
import math

clc()
MatDB.load()

# ========== 1. 全局设置（mm-t 制） ==========
setting = Setting()
setting.iTypeSI = 2                       # 0=自定义 1=m-kg(SI) 2=mm-t

# ========== 2. 材料（标准牌号一律查库） ==========
mat_steel = MatDB.assemble(name="Q345", iType=MaterialType.Steel,
                           iMark=SteelType.Q345, setting=setting)      # 拉索
mat_conc = MatDB.assemble(name="C60", iType=MaterialType.Concrete,
                          iMark=ConcreteType.C60, setting=setting)     # 桥面/桥墩/塔柱

# ========== 3. 截面 ==========
sec_pier = Section("pier_D2500", SectionType.Line, Circle(mid=mat_conc.id, d=2500))       # mm 桥墩/塔柱
sec_deck = Section("deck_1200x2100", SectionType.Line, Rectangle(mid=mat_conc.id, b=1200, h=2100))
sec_strut = Section("strut_tube_D1200", SectionType.Line, Tube(mat_conc.id, 1200, 900))  # 全位置：mid, D, d
sec_cable = Section("cable_D120", SectionType.Line, Circle(mid=mat_steel.id, d=120))      # mm 斜拉索
sec_plate = Section("deck_plate_t600", SectionType.Surface, SingleLayer(mid=mat_conc.id, t=600))

# ========== 4. 参数（顶部常量，带单位注释） ==========
L1 = 45000.0        # mm，主跨
L2 = 18000.0        # mm，边跨
L3 = 9000.0         # mm，端跨（桥面纵向 = (L1+L2)*4 + L3）
H1 = 12000.0        # mm，桥墩高度（向下）
H2 = 18000.0        # mm，塔柱下段高度（向上）
H3 = 15000.0        # mm，塔柱上段高度（向上）
N_PIER = 3          # 桥墩竖向分段数
N_TOWER = 2         # 塔柱下段分段数
SEG = 4500.0        # mm，桥面纵向分段长度
BW = 12000.0        # mm，桥宽（左/中/右三片主梁，间距 BW/2）

n_deck = int(((L1 + L2) * 4 + L3) / SEG)          # 桥面总分段数 = 58
i_pier1 = int((L1 + L2) / SEG) - 1                # 第一组桥墩/塔柱所在桥面节点下标 = 13
i_pier2 = int(((L1 + L2) * 3 + L3) / SEG) - 1     # 第二组桥墩/塔柱下标 = 43
n_cable = int(L1 / SEG)                           # 单塔单侧拉索根数 = 10


# ========== 5. 子函数：沿指定方向连续生成 n_seg 段线构件 ==========
# start_id < 0 时先新建起点节点；返回 (起点节点号, 新节点列表, 新线构件列表)
def point_to_lines(dx, dy, dz, x0, y0, z0, start_id, n_seg, seg_len, sid):
    norm = math.sqrt(dx * dx + dy * dy + dz * dz)
    ux, uy, uz = dx / norm, dy / norm, dz / norm      # 一次性归一化
    nodes, lines = [], []
    if start_id < 0:
        start_id = Node(x0, y0, z0).id
    cur_id = start_id
    for i in range(n_seg):
        nd = Node(x0 + ux * seg_len * (i + 1),
                  y0 + uy * seg_len * (i + 1),
                  z0 + uz * seg_len * (i + 1))
        nodes.append(nd)
        lines.append(Line(start=cur_id, end=nd.id, sid=sid))
        cur_id = nd.id
    return start_id, nodes, lines


# ========== 6. 桥面（三片主梁 + 横向联系梁 + 桥面板） ==========
nod_L = Node(0.0, 0.0, 0.0)                # 左幅起点（X 为纵桥向，Y 为横桥向，Z 竖直向上）
nod_M = Node(0.0, BW / 2, 0.0)             # 中幅起点
nod_R = Node(0.0, BW, 0.0)                 # 右幅起点

_, deck_L_nodes, deck_L_lines = point_to_lines(1, 0, 0, nod_L.x, nod_L.y, nod_L.z,
                                               nod_L.id, n_deck, SEG, sec_deck.id)
_, deck_M_nodes, deck_M_lines = point_to_lines(1, 0, 0, nod_M.x, nod_M.y, nod_M.z,
                                               nod_M.id, n_deck, SEG, sec_deck.id)
_, deck_R_nodes, deck_R_lines = point_to_lines(1, 0, 0, nod_R.x, nod_R.y, nod_R.z,
                                               nod_R.id, n_deck, SEG, sec_deck.id)

line_LM0 = Line(start=nod_M.id, end=nod_L.id, sid=sec_deck.id)     # 起点端横梁
line_RM0 = Line(start=nod_M.id, end=nod_R.id, sid=sec_deck.id)
lines_LM, lines_RM = [], []
for i in range(n_deck):                                            # 各分段横梁（L-M、R-M）
    lines_LM.append(Line(start=deck_L_nodes[i].id, end=deck_M_nodes[i].id, sid=sec_deck.id))
    lines_RM.append(Line(start=deck_R_nodes[i].id, end=deck_M_nodes[i].id, sid=sec_deck.id))

for i in range(n_deck):                                            # 桥面板（4 条边线闭环）
    lm_left = lines_LM[i - 1].id if i >= 1 else line_LM0.id      # 板块左侧边（i=0 用端横梁）
    rm_left = lines_RM[i - 1].id if i >= 1 else line_RM0.id
    Surf(outer=[deck_L_lines[i].id, lines_LM[i].id, deck_M_lines[i].id, lm_left], sid=sec_plate.id)
    Surf(outer=[deck_R_lines[i].id, lines_RM[i].id, deck_M_lines[i].id, rm_left], sid=sec_plate.id)

# ========== 7. 桥墩（自桥面向下 H1，两组） ==========
for i_pier in (i_pier1, i_pier2):
    _, pier_L_nodes, _ = point_to_lines(0, 0, -1, deck_L_nodes[i_pier].x, deck_L_nodes[i_pier].y,
                                        deck_L_nodes[i_pier].z, deck_L_nodes[i_pier].id,
                                        N_PIER, H1 / N_PIER, sec_pier.id)
    _, pier_R_nodes, _ = point_to_lines(0, 0, -1, deck_R_nodes[i_pier].x, deck_R_nodes[i_pier].y,
                                        deck_R_nodes[i_pier].z, deck_R_nodes[i_pier].id,
                                        N_PIER, H1 / N_PIER, sec_pier.id)
    for i in range(N_PIER - 1):                                    # 墩身横向联系杆（圆管）
        Line(start=pier_L_nodes[i].id, end=pier_R_nodes[i].id, sid=sec_strut.id)

# ========== 8. 塔柱（自桥面向上 H2 下段 + H3 上段，两组） ==========
tower_top_L, tower_top_R = [], []                                  # 两座塔柱顶端节点（拉索锚固）
for i_pier in (i_pier1, i_pier2):
    _, tw_L_nodes, _ = point_to_lines(0, 0, 1, deck_L_nodes[i_pier].x, deck_L_nodes[i_pier].y,
                                      deck_L_nodes[i_pier].z, deck_L_nodes[i_pier].id,
                                      N_TOWER, H2 / N_TOWER, sec_pier.id)
    _, tw_R_nodes, _ = point_to_lines(0, 0, 1, deck_R_nodes[i_pier].x, deck_R_nodes[i_pier].y,
                                      deck_R_nodes[i_pier].z, deck_R_nodes[i_pier].id,
                                      N_TOWER, H2 / N_TOWER, sec_pier.id)
    for i in range(N_TOWER - 1):                                   # 下段横向联系杆
        Line(start=tw_L_nodes[i].id, end=tw_R_nodes[i].id, sid=sec_strut.id)

    _, up_L_nodes, _ = point_to_lines(0, 0, 1, tw_L_nodes[-1].x, tw_L_nodes[-1].y, tw_L_nodes[-1].z,
                                      tw_L_nodes[-1].id, n_cable, H3 / n_cable, sec_pier.id)
    _, up_R_nodes, _ = point_to_lines(0, 0, 1, tw_R_nodes[-1].x, tw_R_nodes[-1].y, tw_R_nodes[-1].z,
                                      tw_R_nodes[-1].id, n_cable, H3 / n_cable, sec_pier.id)
    for i in range(0, n_cable - 1, 2):                             # 上段隔节点设横向联系杆
        Line(start=up_L_nodes[i].id, end=up_R_nodes[i].id, sid=sec_strut.id)
    Line(start=up_L_nodes[-1].id, end=up_R_nodes[-1].id, sid=sec_strut.id)   # 塔顶横梁
    tower_top_L.append(up_L_nodes)
    tower_top_R.append(up_R_nodes)

# ========== 9. 斜拉索（每塔两侧各 n_cable 根，扇形布置） ==========
i_cable_a = int((L1 + L2 + L2) / SEG) - 1                          # 第一塔右侧（边跨侧）索锚起点下标 = 17
i_cable_b = i_cable_a + int((L1 + L3) / SEG) + 1                   # 第二塔左侧索锚起点下标 = 30
i_cable_c = int(((L1 + L2) * 3 + L2 + L3) / SEG) - 1               # 第二塔右侧索锚起点下标 = 47
for tower_L, tower_R, i_main, i_side in ((tower_top_L[0], tower_top_R[0], 0, i_cable_a),
                                         (tower_top_L[1], tower_top_R[1], i_cable_b, i_cable_c)):
    for i in range(n_cable):
        Line(start=deck_L_nodes[i_main + i].id, end=tower_L[n_cable - i - 1].id, sid=sec_cable.id)
        Line(start=deck_R_nodes[i_main + i].id, end=tower_R[n_cable - i - 1].id, sid=sec_cable.id)
        Line(start=deck_L_nodes[i_side + i].id, end=tower_L[i].id, sid=sec_cable.id)
        Line(start=deck_R_nodes[i_side + i].id, end=tower_R[i].id, sid=sec_cable.id)

# ========== 10.（可选）自动划分网格 ==========
# 原示例不含网格设置（在界面里设）。若要脚本内划分：取消下面两行注释，
# 且 MeshParams 必须写在 StruModel.toViewer() 之前，submitAndMesh() 写在其后。
# MeshParams(sizer=Size(isBasic=True, basicSize=1500.0, beamSize=1500.0,
#                       wallSize=1500.0, plateSize=1500.0, densifyLevel=0), toQuad="true")
# 实测（basicSize=1500 mm）：4265 节点 / 5174 单元（梁 3782 + 壳 1392），约 9 s。
# 注意：本例含 450 条线构件与 116 块壳面，basicSize 再减半规模会翻数倍，放大前先与用户确认。

# ========== 11. 收口（结构模型路线） ==========
StruModel.toViewer()
# StruModel.submitAndMesh()      # 需要脚本内划网格时再打开

# ========== 验证要点 ==========
# 构件计数（实测 pypcae/pypcae.stru 与本式一致）：
#   节点 = 3(桥面起点) + 3*58(桥面) + 4*3(桥墩) + 4*2(塔柱下段) + 4*10(塔柱上段) = 237
#   线构件 = 174(主梁) + 2(端横梁) + 116(分段横梁) + 16(桥墩) + 10(塔柱下段)
#            + 52(塔柱上段) + 80(斜拉索) = 450
#   面构件 = 58*2 = 116（桥面板）
#   材料 2（Q345/C60）、截面 5、无支座无荷载（纯几何示例）
# 单位自检：mm-t 制下 Q345 应为 E0=206000 MPa、density=7.85e-9 t/mm3；C60 应为 E0=36500 MPa
# 包围盒（实测）：X[0, 261000]（= 58 段 × 4500）Y[0, 12000]（三片主梁）Z[-12000, 33000]
#                桥面节点 z=0 共 177 个（3 起点 + 3×58）；塔顶 z=33000 = H2+H3；墩底 z=-12000 = -H1
# 说明：save_script 校验会提示"缺少 FemModel 导入/收口""无荷载工况"——纯几何路线下属预期提示
# 界面：几何模型页面执行后视图刷新；有限元模型页面执行本脚本不会刷新（纯几何脚本）
