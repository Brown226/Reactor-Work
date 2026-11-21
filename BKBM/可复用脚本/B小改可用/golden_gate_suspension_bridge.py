# -*- coding: utf-8 -*-
# 示例：金门大桥悬索桥 —— 双塔双缆全桥（静力 DL/LL/包络 + 模态前 30 阶，JobManager 切换任务）
# 要点：Cable 主缆(抛物线) + Link 吊索 + 鱼骨式桥面系(脊骨梁+横挑梁)；塔腿 z=0 处与桥面边节点共享、
#       主缆过塔顶与鞍座节点共享；缆索恒载张拉用 Etem 负温度等效(保留单元轴向刚度)；
#       主缆中间节点面外 Uy 约束(平面缆索面内简化)；塔底与两岸锚碇固结
# 单位制：SI（m / N / Pa）

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数定义（SI：m / N / Pa） ==========
L_SIDE   = 343.0     # m，边跨长度
L_MAIN   = 1280.0    # m，主跨长度
N_SIDE   = 22        # 边跨分段数（吊索间距约15.6m）
N_MAIN   = 84        # 主跨分段数（吊索间距约15.2m，与实桥50ft一致）
H_SADDLE = 152.0     # m，塔顶鞍座距桥面高度
SAG_MAIN = 144.0     # m，主跨主缆垂度
SAG_SIDE = 8.0       # m，边跨主缆相对弦线的垂度
Z_ANCHOR = 3.0       # m，锚碇处主缆中心距桥面高度
Z_TBASE  = -60.0     # m，塔底标高（桥面以下，水下桥墩）
Y_CABLE  = 13.7      # m，主缆面横向半距（缆距27.4m）
D_CABLE  = 0.92      # m，主缆直径
D_HANGER = 0.12      # m，吊索直径
Q_LL     = 35000.0   # N/m，桥面等代活载（6车道）

X_T1 = L_SIDE                     # 塔1 纵向位置
X_T2 = L_SIDE + L_MAIN            # 塔2 纵向位置
N_STA = 2 * N_SIDE + N_MAIN       # 桥面总分段数 128
I_T1 = N_SIDE                     # 塔1 站号
I_T2 = N_SIDE + N_MAIN            # 塔2 站号
Z_LEVELS = [-60.0, -30.0, 0.0, 25.0, 50.0, 75.0, 100.0, 125.0, 152.0]  # 塔腿分层标高
Z_STRUT  = [-30.0, 50.0, 100.0, 152.0]                                # 塔柱横梁标高

# 初拉力估算常量
A_DECK  = 2.5                      # m^2，桥面系等效面积
A_CROSS = 0.8 * 1.2                # m^2，横挑梁截面面积
W_DECK_M   = A_DECK * 7850.0 * 9.81                          # N/m，桥面系自重
W_CROSS_ST = A_CROSS * 7850.0 * 9.81 * (2.0 * Y_CABLE)       # N/站，横挑梁自重
A_CABLE = math.pi / 4.0 * D_CABLE * D_CABLE
W_CABLE_M = A_CABLE * 7850.0 * 9.81                          # N/m，主缆自重
DX_MAIN = L_MAIN / N_MAIN
w_main = W_DECK_M / 2.0 + W_CROSS_ST / DX_MAIN / 2.0 + W_CABLE_M   # 单缆面等效线载
H_CABLE = w_main * L_MAIN * L_MAIN / (8.0 * SAG_MAIN)              # 主缆水平分力 N

# 桥面站位 x 坐标（0..1966）
xs = [i * L_SIDE / N_SIDE for i in range(N_SIDE)]
xs += [X_T1 + j * L_MAIN / N_MAIN for j in range(N_MAIN + 1)]
xs += [X_T2 + k * L_SIDE / N_SIDE for k in range(1, N_SIDE + 1)]

def cable_z(x):
    # 主缆抛物线线形
    if x <= X_T1:
        xi = x / L_SIDE
        return Z_ANCHOR + (H_SADDLE - Z_ANCHOR) * xi - 4.0 * SAG_SIDE * xi * (1.0 - xi)
    if x <= X_T2:
        xi = (x - X_T1) / L_MAIN
        return H_SADDLE - 4.0 * SAG_MAIN * xi * (1.0 - xi)
    xi = (x - X_T2) / L_SIDE
    return H_SADDLE + (Z_ANCHOR - H_SADDLE) * xi - 4.0 * SAG_SIDE * xi * (1.0 - xi)

# ========== 2. 材料（标准牌号从材料库调用） ==========
MatDB.load()
setting = Setting()          # 默认 m 制（SI）
mat = MatDB.assemble("Q345", iType=MaterialType.Steel, iMark=SteelType.Q345, setting=setting)
mat.expansion = 1.2e-5     # 钢材线膨胀系数 /℃（温度等效张拉必需）
E_STEEL = 2.06e11          # Pa，Q345 弹性模量（材料库值，用于温度张拉量计算）

# ========== 3. 截面 ==========
sec_deck   = Section("桥面系", SectionType.Line,
                     Arbitrary(mid=mat.id, area=2.5, Ix=100.0, Iy=455.0, Iz=36.0), iKey=0)
sec_cross  = Section("横挑梁", SectionType.Line, Rectangle(mid=mat.id, b=0.8, h=1.2))
sec_hanger = Section("吊索",   SectionType.Line, Circle(mid=mat.id, d=D_HANGER))
sec_cable  = Section("主缆",   SectionType.Line, Circle(mid=mat.id, d=D_CABLE))
sec_leg    = Section("塔腿",   SectionType.Line,
                     Box(mid=mat.id, b=6.0, h=9.0, u=0.30, t=0.30, d=0.30, f=0.30))
sec_strut  = Section("塔横梁", SectionType.Line, Rectangle(mid=mat.id, b=1.5, h=2.5))

# ========== 4. 节点 ==========
# 桥面脊骨节点与两侧边节点（鱼骨式）
spine_nodes = [Node(x, 0.0, 0.0) for x in xs]
edge_nodes = []
for x in xs:
    edge_nodes.append([Node(x, -Y_CABLE, 0.0), Node(x, Y_CABLE, 0.0)])

# 桥塔节点：z=0 与桥面边节点共享；塔顶即主缆鞍座节点
leg_node_map = {}    # (塔站号, 左右侧, 标高) -> Node
for it in (I_T1, I_T2):
    for s in (0, 1):
        y = -Y_CABLE if s == 0 else Y_CABLE
        for z in Z_LEVELS:
            if abs(z) < 1.0e-6:
                leg_node_map[(it, s, z)] = edge_nodes[it][s]
            else:
                leg_node_map[(it, s, z)] = Node(xs[it], y, z)
tower_top = {}
for it in (I_T1, I_T2):
    for s in (0, 1):
        tower_top[(it, s)] = leg_node_map[(it, s, H_SADDLE)]

# 主缆节点（塔顶与鞍座共享；端部为锚碇点）
cable_nodes = {}
anchor_ids = []
for i in range(N_STA + 1):
    for s in (0, 1):
        if i == I_T1 or i == I_T2:
            cable_nodes[(i, s)] = tower_top[(i, s)]
        else:
            y = -Y_CABLE if s == 0 else Y_CABLE
            nd = Node(xs[i], y, cable_z(xs[i]))
            cable_nodes[(i, s)] = nd
            if i == 0 or i == N_STA:
                anchor_ids.append(nd.id)

# ========== 5. 单元 ==========
# 桥面脊骨梁
deck_elems = [Element(nids=[spine_nodes[i].id, spine_nodes[i + 1].id],
                      type=ElementType.BeamEuler, sid=sec_deck.id) for i in range(N_STA)]
# 横挑梁（脊骨 -> 两侧吊点）
cross_elems = []
for i in range(N_STA + 1):
    for s in (0, 1):
        cross_elems.append(Element(nids=[spine_nodes[i].id, edge_nodes[i][s].id],
                                   type=ElementType.BeamEuler, sid=sec_cross.id))
# 吊索（桥面边节点 -> 主缆节点；塔位站不设），并记录恒载平衡张拉对应温降
A_HANGER = math.pi / 4.0 * D_HANGER * D_HANGER
hanger_elems = []
hanger_dtm = []
for i in range(1, N_STA):
    if i == I_T1 or i == I_T2:
        continue
    dxa = 0.5 * (xs[i + 1] - xs[i - 1])
    f0 = 0.5 * (W_DECK_M * dxa + W_CROSS_ST)
    dth = -f0 / (E_STEEL * A_HANGER * 1.2e-5)
    for s in (0, 1):
        eh = Element(nids=[edge_nodes[i][s].id, cable_nodes[(i, s)].id],
                     type=ElementType.Link, sid=sec_hanger.id)
        hanger_elems.append(eh)
        hanger_dtm.append((eh.id, dth))
# 主缆（锚碇 -> 塔顶 -> 锚碇，连续），分段张拉力 T=H*sqrt(1+m^2) 对应温降
cable_elems = []
cable_dtm = []
for s in (0, 1):
    for i in range(N_STA):
        ec = Element(nids=[cable_nodes[(i, s)].id, cable_nodes[(i + 1, s)].id],
                     type=ElementType.Cable, sid=sec_cable.id)
        cable_elems.append(ec)
        dxi = xs[i + 1] - xs[i]
        slp = (cable_z(xs[i + 1]) - cable_z(xs[i])) / dxi
        t0 = H_CABLE * math.sqrt(1.0 + slp * slp)
        cable_dtm.append((ec.id, -t0 / (E_STEEL * A_CABLE * 1.2e-5)))
# 塔腿与塔横梁
tower_leg_elems = []
tower_strut_elems = []
for it in (I_T1, I_T2):
    for s in (0, 1):
        for k in range(len(Z_LEVELS) - 1):
            na = leg_node_map[(it, s, Z_LEVELS[k])]
            nb = leg_node_map[(it, s, Z_LEVELS[k + 1])]
            tower_leg_elems.append(Element(nids=[na.id, nb.id],
                                           type=ElementType.BeamEuler, sid=sec_leg.id))
    for zs in Z_STRUT:
        na = leg_node_map[(it, 0, zs)]
        nb = leg_node_map[(it, 1, zs)]
        tower_strut_elems.append(Element(nids=[na.id, nb.id],
                                       type=ElementType.BeamEuler, sid=sec_strut.id))

# ========== 6. 集合 ==========
Elset("桥面系", [e.id for e in deck_elems])
Elset("横挑梁", [e.id for e in cross_elems])
Elset("吊索",   [e.id for e in hanger_elems])
Elset("主缆",   [e.id for e in cable_elems])
Elset("桥塔",   [e.id for e in tower_leg_elems + tower_strut_elems])

# ========== 7. 支座 ==========
leg_fixed_ids = []
for it in (I_T1, I_T2):
    for s in (0, 1):
        leg_fixed_ids.append(leg_node_map[(it, s, Z_TBASE)].id)
Fixed(gnids=leg_fixed_ids, dof=[Dof.All])                                  # 塔底固结
Fixed(gnids=anchor_ids,   dof=[Dof.All])                                   # 两岸锚碇固结
Fixed(gnids=[spine_nodes[0].id],     dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx])  # 桥台固定铰
Fixed(gnids=[spine_nodes[N_STA].id], dof=[Dof.Uy, Dof.Uz, Dof.Phx])          # 桥台滑动铰
# 主缆中间节点面外（横向Uy）约束：平面缆索面外线刚度为零，按面内受力简化约束
cable_mid_ids = []
for i in range(N_STA + 1):
    if i == I_T1 or i == I_T2:
        continue
    for s in (0, 1):
        cable_mid_ids.append(cable_nodes[(i, s)].id)
Fixed(gnids=cable_mid_ids, dof=[Dof.Uy])

# ========== 8. 荷载工况 ==========
all_elem_ids = [e.id for e in (deck_elems + cross_elems + hanger_elems +
                               cable_elems + tower_leg_elems + tower_strut_elems)]
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_elem_ids, value=9.81, dir=[0, 0, -1]))
# 主缆与吊索的恒载平衡张拉：以负温度收缩等效（单元保留完整轴向刚度）
for eid, dtc in cable_dtm:
    lc_dl.add(Etem([eid], dtc))   # Etem 须全位置传参（文档载明的例外）
for eid, dth in hanger_dtm:
    lc_dl.add(Etem([eid], dth))

lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=[e.id for e in deck_elems],
                 type=LoadDistributionType.Uniform, subType=LoadSubType.Force,
                 value=[Q_LL], dir=[0, 0, -1]))

# ========== 9. 荷载步与分析 ==========
# 9.1 线性静力（DL / LL / 包络三步）
analy = Analy("StaticAnalysis")
analy.add(Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))
analy.add(Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0)))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_ll.id, 1.0))
analy.add(step_all)

# 9.2 模态分析（前 30 阶，基于弹性刚度+质量；不含缆索张拉的应力刚化）
Analy("ModalAnalysis", setting=AnalySetting(anaType=AnaType.MODAL, nModal=30))

# ========== 10. 分析任务（静力/模态；当前任务=静力，改为 jobs[1] 即切到模态） ==========
job0 = Job("StaticJob", main=0)
job1 = Job("ModalJob", main=1, uid="ggmd30")
jobs = [job0, job1]
JobManager(main=jobs[0].main, pre=jobs[0].pre, uid=jobs[0].uid, jobs=jobs)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 数量自检：节点 673 个（脊骨129+边节点258+塔腿32+缆254）；单元 932 个
#    （桥面128+横挑梁258+吊索250+主缆256+塔腿32+塔横梁8）
# 2) 反力平衡：Step_LL 竖向反力合计 = Q_LL*1966 = 68.81 MN（实测精确吻合）
# 3) 主缆轴力：H = w*L^2/(8f) ≈ 304 MN；DL+LL 塔顶处实测 ≈ 335 MN（应力 504 MPa × 0.665 m^2）
# 4) 恒载平衡：Step_DL 主跨跨中挠度 ≈ -0.14 m（温度张拉与恒载基本平衡）；
#    Step_LL ≈ -0.68 m；Step_ALL 与两步线性叠加精确一致
# 5) 模态（当前任务切到 jobs[1] 计算）：总质量 ≈ 1.52e8 kg（=静力自重反力/g）；
#    1 阶横弯 ≈ 0.026 Hz、1 阶竖弯 ≈ 0.183 Hz；
#    30 阶累计质量参与 纵 83% / 横 91% / 竖 55%（竖向模态密集，谱分析应用需加大 nModal）
