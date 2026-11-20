# -*- coding: utf-8 -*-
# 示例：立式圆形料仓 / 工业筒仓（StruModel，纯几何路线）—— 回转体壳 + 环向加劲肋
# 路线：结构（几何）模型；收口 = StruModel.toViewer()（与原示例一致，网格在界面设置后划分）
# 单位制：mm-t 制（setting.iTypeSI = 2）→ 长度 mm / 力 N / 应力·弹模 MPa / 密度 t/mm3
# 来源：PkpmCAE 自带示例 resources/example/1.3通用仿真-固体力学-工业筒仓/建模脚本/立式圆形料仓.py
# 要点：① 回转面（圆柱/圆台）用 Surf(type=SurfType.Cylinder, top=顶边线号, bottom=底边线号)，不传 outer；
#       ② 整圆边线 = Line(start=同一点, end=同一点, center=圆心点号, kp=方向点号, type=LineType.Arc)
#          —— n_seg=1 时"起点=终点"的圆弧线即为一个整圆（本例筒身每层只用 1 条整圆线）；
#       ③ kp（方向点）传"竖直向上参考点"：本例统一用 center_dir（仓顶以上 H_S1=5295 mm 处的轴心点）；
#       ④ Elset 把同类面/线打包（shell_upper 筒身上部 / shell_link 过渡段 / hopper 锥斗 /
#          rib_* 各道环肋及其 _in、_out 边线），便于后续按集合布荷载；
#       ⑤ 相邻面共用同一条边线（环肋面板与肋板共用径向线），不要重复建线。
# 与官方示例的差异（几何形状一致，构件数有两处刻意优化）：
#   - Wire/WireType → Line/LineType；Surf([...]) → Surf(outer=[...])；Elset(name, ids) → 关键字传参；
#   - 空材料 Material(name="material") → MatDB 查库 Q345（标准牌号必须查库，见 ../../AGENT_GUIDE.md）；
#   - 3.1415926 → math.pi；截面/集合名改英文（中文只用于注释）；
#   - 删除软件参数化脚本头（##...## 与 #if ${params.IsNew}），参数改为顶部常量；
#   - 肋板面的第 4 条边原示例另建了一条与径向线完全重合的线，本示例改为共用径向线
#     → 线构件由 920 减为 800（面/集合数不变）；
#   - 肋板定位节点改为"仅在需要肋板时创建"：原示例无条件创建，无肋板的那道环肋会多出 48 个
#     与内外圈重合的冗余节点 → 节点数由 596 减为 548。
# 实测：PkpmCAE pypcae 2.1.0（last release 20261230）——几何路线执行成功（节点 548 / 线 800 /
#       面 271 / 集合 21，落盘 pypcae/pypcae.stru）；另测可选网格 basicSize=600 mm → 1824 节点 /
#       1342 壳单元（1330 四边形 + 12 三角形），耗时约 9 s。

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx
import math

clc()
MatDB.load()

# ========== 1. 全局设置（mm-t 制） ==========
setting = Setting()
setting.iTypeSI = 2                       # 0=自定义 1=m-kg(SI) 2=mm-t

# ========== 2. 材料（标准牌号查库） ==========
mat_steel = MatDB.assemble(name="Q345", iType=MaterialType.Steel,
                           iMark=SteelType.Q345, setting=setting)

# ========== 3. 壳截面（板厚 mm） ==========
sec_rib = Section("rib_plate_t25", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=25))     # 加劲肋
sec_shell_1 = Section("shell_seg1_t30", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=30))
sec_shell_2 = Section("shell_seg2_t45", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=45))
sec_shell_3 = Section("shell_seg3_t60", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=60))
sec_shell_4 = Section("shell_seg4_t40", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=40))
sec_hopper_1 = Section("hopper_up_t40", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=40))  # 锥斗
sec_hopper_2 = Section("hopper_lo_t50", SectionType.Surface, SingleLayer(mid=mat_steel.id, t=50))

# ========== 4. 参数（顶部常量，带单位注释；Z 轴竖直向上，仓顶在 z=0） ==========
R_TOP = 7300.0 / 2      # mm，仓身（圆柱段）半径 = 3650
R_BTN = 3400.0 / 2      # mm，锥斗下口半径 = 1700（由锥面斜率反算，见 ANGLE）
H_S1 = 5295.0           # mm，圆柱段 1 高度（z=0 → -H_S1）
H_S2 = 1800.0           # mm，圆柱段 2 高度
H_S3 = 1385.0           # mm，圆柱段 3 高度
H_S4 = 800.0            # mm，圆柱段 4 高度（过渡段）
H_C1 = H_S4             # mm，锥斗过渡环的"折算高度"：只用于算半径内收量，该段无竖直高度
                        #     （圆心 center_c1 与 center_4 同标高 → 生成一圈水平环形过渡面）
H_C2 = 4220.0           # mm，锥斗段 2 竖直高度
H_C3 = 400.0            # mm，锥斗段 3 竖直高度
H_CONE = H_C1 + H_C2 + H_C3                       # mm，锥斗折算总高 = 5420（用于反算锥面斜率）
ANGLE = math.atan(H_CONE / (R_TOP - R_BTN))       # rad，锥斗母线与水平面夹角 ≈ 70.2°
W_C1 = H_C1 / math.tan(ANGLE)                     # mm，锥斗段 1 环肋外伸宽 ≈ 287.8
W_C2 = 335.0                          # mm，锥斗段 2 环肋外伸宽（原示例 d_t2）

RIB_1_H, RIB_1_W = 90.0, 90.0        # mm，圆柱段 1 顶部环肋：肋高 / 环宽
RIB_2_H, RIB_2_W = 120.0, 120.0      # mm，圆柱段 2 环肋
RIB_3_H, RIB_3_W = 1000.0, 300.0     # mm，圆柱段 3 环肋（肋高 1000，环宽 300）
RIB_4_W = 300.0                      # mm，圆柱段 3 顶部第二道环肋（仅环宽，无肋高）
N_EDGE = 24                          # 环肋周向分段数（每道环肋 24 块面板 + 24 块肋板）
N_SEG = 1                            # 筒身周向分段数（1 = 每层一条整圆线）


# ========== 5. 子函数：生成正 n 边形的节点与圆弧边线 ==========
# n_seg=1 时得到"起点=终点"的整圆线；返回 (节点列表, 圆弧线列表)
def ring_circle(n_seg, radius, x, y, z, center_id, dir_id):
    nodes = []
    for i in range(n_seg):
        nodes.append(Node(x + math.cos(2 * math.pi / n_seg * i) * radius,
                          y + math.sin(2 * math.pi / n_seg * i) * radius, z))
    arcs = []
    for i in range(n_seg - 1):
        arcs.append(Line(start=nodes[i].id, end=nodes[i + 1].id, center=center_id,
                         kp=dir_id, type=LineType.Arc))
    arcs.append(Line(start=nodes[n_seg - 1].id, end=nodes[0].id, center=center_id,
                     kp=dir_id, type=LineType.Arc))          # 闭合（n_seg=1 即整圆）
    return nodes, arcs


# ========== 6. 子函数：一道环向加劲肋（环带面板 + 竖向肋板 + 三个 Elset） ==========
# radius  : 环肋内圈半径；ring_w：环肋外伸宽度（外圈半径 = radius + ring_w）
# rib_h1  : 肋板向内上方挑出高度；rib_h2：肋板顶部相对外圈的高度（两者均为 0 时只做环带、不做肋板）
# cone_ang: 肋板倾斜角（锥斗段用锥面母线角，圆柱段用 90°）
def rib_ring(n_seg, radius, ring_w, x, y, z, center_id, dir_id, cone_ang, rib_h1, rib_h2, sid, name):
    set_all, set_in, set_out = [], [], []
    nodes_in, arcs_in = ring_circle(n_seg, radius, x, y, z, center_id, dir_id)            # 内圈
    nodes_out, arcs_out = ring_circle(n_seg, radius + ring_w, x, y, z, center_id, dir_id)  # 外圈
    set_in += [a.id for a in arcs_in]
    set_out += [a.id for a in arcs_out]

    radials = []                                                   # 内外圈之间的径向线（共用）
    for i in range(n_seg):
        radials.append(Line(start=nodes_in[i].id, end=nodes_out[i].id))

    band = []                                                      # 环带面板（n_seg 块）
    for i in range(n_seg - 1):
        band.append(Surf(outer=[arcs_in[i].id, radials[i].id, arcs_out[i].id, radials[i + 1].id],
                         sid=sid).id)
    band.append(Surf(outer=[arcs_in[n_seg - 1].id, radials[n_seg - 1].id,
                            arcs_out[n_seg - 1].id, radials[0].id], sid=sid).id)
    set_all += band

    if rib_h1 != 0 or rib_h2 != 0:                                 # 肋板（n_seg 块）
        off = rib_h1 / math.sin(cone_ang) * math.cos(cone_ang)     # 肋板内挑水平距离
        rib_nodes = [Node(x + math.cos(2 * math.pi / n_seg * i) * (radius + off),
                          y + math.sin(2 * math.pi / n_seg * i) * (radius + off), z + rib_h1)
                     for i in range(n_seg)]
        top_nodes = [Node(nodes_out[i].x, nodes_out[i].y, nodes_out[i].z + rib_h2)
                     for i in range(n_seg)]
        for i in range(n_seg):
            w1 = Line(start=nodes_in[i].id, end=rib_nodes[i].id)    # 内圈 → 肋板内上点
            w2 = Line(start=rib_nodes[i].id, end=top_nodes[i].id)   # 肋板内上点 → 外圈上方点
            w3 = Line(start=top_nodes[i].id, end=nodes_out[i].id)   # 外圈上方点 → 外圈
            set_in.append(w1.id)
            set_out.append(w3.id)
            set_all.append(Surf(outer=[w1.id, w2.id, w3.id, radials[i].id], sid=sid).id)

    Elset(name=name, ids=set_all)
    Elset(name=name + "_in", ids=set_in)
    Elset(name=name + "_out", ids=set_out)


# ========== 7. 轴心点（圆心 + 圆弧方向点） ==========
X0, Y0, Z0 = 0.0, 0.0, 0.0
center_dir = Node(X0, Y0, Z0 + H_S1)                    # 圆弧方向点（z+ 参考点）
center_0 = Node(X0, Y0, Z0)                             # 仓顶（z=0）
center_1 = Node(X0, Y0, Z0 - H_S1)
center_2 = Node(X0, Y0, Z0 - H_S1 - H_S2)
center_3 = Node(X0, Y0, Z0 - H_S1 - H_S2 - H_S3)
center_4 = Node(X0, Y0, Z0 - H_S1 - H_S2 - H_S3 - H_S4)  # 圆柱段底 = 锥斗顶

# ========== 8. 圆柱段边线（每层一条整圆线） ==========
_, arcs_lvl0 = ring_circle(N_SEG, R_TOP, X0, Y0, center_0.z, center_0.id, center_dir.id)
_, arcs_lvl1 = ring_circle(N_SEG, R_TOP, X0, Y0, center_1.z, center_1.id, center_dir.id)
_, arcs_lvl2 = ring_circle(N_SEG, R_TOP, X0, Y0, center_2.z, center_2.id, center_dir.id)
_, arcs_lvl3 = ring_circle(N_SEG, R_TOP, X0, Y0, center_3.z, center_3.id, center_dir.id)
_, arcs_lvl4 = ring_circle(N_SEG, R_TOP, center_4.x, center_4.y, center_4.z,
                           center_4.id, center_dir.id)

# ========== 9. 锥斗段边线（半径按锥面斜率逐段内收） ==========
z_c1 = Z0 - (H_S1 + H_S2 + H_S3 + H_S4)
z_c2 = z_c1 - H_C2
z_c3 = z_c2 - H_C3
center_c1 = center_4
r_c1 = R_TOP - H_C1 / math.tan(ANGLE)                   # = 3650 - 287.8
_, arcs_c1 = ring_circle(N_SEG, r_c1, center_c1.x, center_c1.y, center_c1.z,
                         center_c1.id, center_dir.id)
center_c2 = Node(X0, Y0, z_c2)
r_c2 = R_TOP - (H_C1 + H_C2) / math.tan(ANGLE)
_, arcs_c2 = ring_circle(N_SEG, r_c2, X0, Y0, z_c2, center_c2.id, center_dir.id)
center_c3 = Node(X0, Y0, z_c3)
r_c3 = R_TOP - (H_C1 + H_C2 + H_C3) / math.tan(ANGLE)   # = R_BTN = 1700
_, arcs_c3 = ring_circle(N_SEG, r_c3, X0, Y0, z_c3, center_c3.id, center_dir.id)

# ========== 10. 回转面（4 段圆柱 + 3 段圆台） ==========
set_shell_up, set_shell_link, set_cone = [], [], []
for i in range(N_SEG):
    set_shell_up.append(Surf(type=SurfType.Cylinder, top=arcs_lvl0[i].id, bottom=arcs_lvl1[i].id,
                             sid=sec_shell_1.id).id)
    set_shell_up.append(Surf(type=SurfType.Cylinder, top=arcs_lvl1[i].id, bottom=arcs_lvl2[i].id,
                             sid=sec_shell_2.id).id)
    set_shell_up.append(Surf(type=SurfType.Cylinder, top=arcs_lvl2[i].id, bottom=arcs_lvl3[i].id,
                             sid=sec_shell_3.id).id)
    set_shell_link.append(Surf(type=SurfType.Cylinder, top=arcs_lvl3[i].id, bottom=arcs_lvl4[i].id,
                               sid=sec_shell_4.id).id)
    set_cone.append(Surf(type=SurfType.Cylinder, top=arcs_lvl4[i].id, bottom=arcs_c1[i].id,
                         sid=sec_hopper_1.id).id)        # 圆台段同样用 SurfType.Cylinder
    set_cone.append(Surf(type=SurfType.Cylinder, top=arcs_c1[i].id, bottom=arcs_c2[i].id,
                         sid=sec_hopper_2.id).id)
    set_cone.append(Surf(type=SurfType.Cylinder, top=arcs_c2[i].id, bottom=arcs_c3[i].id,
                         sid=sec_hopper_2.id).id)
Elset(name="shell_upper", ids=set_shell_up)             # 圆柱-上部（t=30/45/60）
Elset(name="shell_link", ids=set_shell_link)            # 圆柱-连接处（t=40）
Elset(name="hopper", ids=set_cone)                      # 圆锥（锥斗 t=40/50）

# ========== 11. 环向加劲肋（自下而上 6 道） ==========
rib_ring(N_EDGE, r_c2, W_C2, center_c2.x, center_c2.y, center_c2.z,            # 锥斗段 2 环肋
         center_c2.id, center_dir.id, ANGLE, W_C2 * 1.5, W_C2, sec_rib.id, "rib_hopper_2")
rib_ring(N_EDGE, r_c1, W_C1, center_c1.x, center_c1.y, center_c1.z,            # 锥斗段 1 环肋
         center_c1.id, center_dir.id, ANGLE, H_C1 * 0.7, H_C1 * 0.7, sec_rib.id, "rib_hopper_1")
center_31 = Node(center_2.x, center_2.y, center_2.z)                           # 圆柱段 3 下部环肋
rib_ring(N_EDGE, R_TOP, RIB_4_W, center_31.x, center_31.y, center_31.z,
         center_31.id, center_dir.id, math.pi / 2, RIB_3_H, RIB_3_H, sec_rib.id, "rib_shell_3a")
center_32 = Node(center_2.x, center_2.y, center_2.z + RIB_3_H)                 # 圆柱段 3 上部环肋（无肋板）
rib_ring(N_EDGE, R_TOP, RIB_4_W, center_32.x, center_32.y, center_32.z,
         center_32.id, center_dir.id, math.pi / 2, 0.0, 0.0, sec_rib.id, "rib_shell_3b")
center_21 = Node(center_1.x, center_1.y, center_1.z + 1000.0)                  # 圆柱段 2 环肋
rib_ring(N_EDGE, R_TOP, RIB_2_W, center_21.x, center_21.y, center_21.z,
         center_21.id, center_dir.id, math.pi / 2, RIB_2_H, RIB_2_H, sec_rib.id, "rib_shell_2")
center_11 = Node(center_0.x, center_0.y, center_0.z - 1000.0)                  # 圆柱段 1 环肋
rib_ring(N_EDGE, R_TOP, RIB_1_W, center_11.x, center_11.y, center_11.z,
         center_11.id, center_dir.id, math.pi / 2, RIB_1_H, RIB_1_H, sec_rib.id, "rib_shell_1")

# ========== 12.（可选）自动划分网格 ==========
# 原示例不含网格设置。若要脚本内划分：MeshParams 必须写在 toViewer() 之前，submitAndMesh() 写在其后，
# MeshParams(sizer=Size(isBasic=True, basicSize=600.0, beamSize=600.0,
#                       wallSize=600.0, plateSize=600.0, densifyLevel=0), toQuad="true")
# 实测（basicSize=600 mm）：1824 节点 / 1342 壳单元（1330 四边形 + 12 三角形），约 9 s，
#   整圆边线 + 圆柱/圆台回转面均正常划分（未出现历史日志里的 "TMesh error:arc define"）。
# ⚠ 更细的尺寸（如 300 mm）未实测；仓壳板厚 25~60 mm，正式分析建议按板厚的 5~10 倍取值并做收敛性
#   对比；本例存在 53 个重合节点（见验证要点），若网格/计算异常优先排查重合节点与重合边线。

# ========== 13. 收口（结构模型路线） ==========
StruModel.toViewer()
# StruModel.submitAndMesh()      # 需要脚本内划网格时再打开（先确认网格可通过）

# ========== 验证要点 ==========
# 构件计数（实测 pypcae/pypcae.stru 与本式一致）：
#   节点 = 6(轴心点/方向点) + 2(锥斗段轴心) + 4(环肋定位轴心) + 8(整圆边线的起终点，每圈 1 个)
#          + 5 道带肋板环肋 × (24×2 内外圈 + 24 肋板内点 + 24 肋板顶点) + 1 道无肋板环肋 × (24×2)
#          = 20 + 5×96 + 48 = 548
#   线构件 = 8(整圆边线) + 5 道带肋板环肋 × (24×2 圆弧 + 24 径向 + 24×3 肋板边) + 1 道无肋板环肋
#            × (24×2 圆弧 + 24 径向) = 8 + 5×144 + 72 = 800
#            （原示例肋板第 4 边重复建线 → 920；本示例共用径向线 → 800）
#   面构件 = 7(回转面) + 5 道环肋 × (24 环带 + 24 肋板) + 1 道 × 24 环带 = 7 + 240 + 24 = 271
#   构件类型分布（实测 pypcae.stru）：线构件 800 条全部为几何边线（未挂截面，正常——只有需要
#     生成梁单元的线构件才挂 SectionType.Line 截面）；面构件 271 个全部挂壳截面
#   集合 = 6 道环肋 × 3（本体/_in/_out）+ 3（shell_upper/shell_link/hopper）= 21
#   材料 1（Q345）、截面 7（t=25/30/45/60/40/40/50）
# 几何自检（实测包围盒与下式一致）：
#   锥斗下口半径 r_c3 = R_TOP - H_CONE/tan(ANGLE) = 1700 mm = R_BTN ✓
#   标高：仓顶 z=0；圆柱段底 = 锥斗顶 z=-9280；锥斗段 2 底 z=-13500；锥斗下口 z=-13900
#   仓体总高（z=0 → z=-13900）= 13900 mm = 圆柱段 9280 + 锥斗竖直段 4620
#     （H_C1 段是 z=-9280 处一圈水平环形过渡面：半径 3650 → 3362，无竖直高度）
#   包围盒：X/Y = ±3950 mm（= R_TOP 3650 + 最宽环肋外伸 300）；Z = -13900 ~ +5295
#     （+5295 是圆弧方向点 center_dir，不是实体；实体范围 z ∈ [-13900, 0]）
#   圆弧线 296 条（8 条整圆边线 + 6 道环肋 × 24×2）；回转面 7 个（4 圆柱 + 3 圆台/环），
#     平面面 264 个（环带 168 + 肋板 96）
# ⚠ 重合节点 53 个（原示例同样存在）：center_31 与 center_2 同点；rib_shell_3a 的肋板内点/顶点
#   与 rib_shell_3b 的内外圈节点各 24 个同点；4 道环肋的整圆起终点与筒身/锥斗整圆起终点同点。
#   原因是每道环肋独立建圈。平台校验未报错（网格划分按几何重合处理），但如需严格共节点，
#   应把上一道环肋的节点传入下一道复用。
# 说明：save_script 校验会提示"缺少 FemModel 导入/收口""无恒载工况"——纯几何路线下属预期提示
# 界面：几何模型页面执行后视图刷新；本脚本为纯几何脚本，有限元页面执行不会刷新
