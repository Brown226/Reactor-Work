# -*- coding: utf-8 -*-
# 示例：实体简支梁（混合路线）—— 规则长方体 Solid + **六面体扫掠网格** + 顶面 Ebsload 均布面压 + 线性静力
# 路线：**混合**（几何 → 网格 → 有限元 → 计算，单脚本跑完）
# 建模模式：通用几何模型（Line → Surf → Solid）
# 单位制：SI（m / N / Pa / kg·m^-3）；Setting() 默认档（实测 iTypeSI=0）
# 模型：C30 矩形截面梁 b×h = 0.30×0.60 m、跨度 L = 6.00 m；两端简支；顶面全跨均布压力
#       p = q/b = 66666.67 Pa（对应线荷载 q = 20 kN/m，合力 120 kN）；计入自重
#
# 要点（★ 四条均为 2026-10-14 实测才确定的结论，手册未写）：
#   ① ★ **实体"简支"只能约束端面底边，不能约束整个端面**（本示例最重要的教训）：
#      实体单元节点**没有转动自由度**，把左端面**全部节点**约束 Ux+Uy+Uz 等于强制端截面
#      保持平面且不能水平移动 → **抑制了端部转角** → 左端实际接近**固端**，而不是铰。
#      ✗ 反面实测（同几何同网格，仅边界不同）：左端面 15 节点 Fixed(Ux,Uy,Uz) + 右端面 15 节点
#        Fixed(Uy,Uz) → 左右端竖向反力 **62.4% / 37.6%**（≈ 一端固定一端简支的 5/8:3/8）、
#        左端出现 **−89358 N·m** 自平衡水平力偶（ΣRx≈0 但单节点 |Rx|max = 48434 N）、
#        Step_LL 跨中 uz = −8.77856e−4 m；
#      ✓ 正面做法（本示例）：两端只约束端面**底边**（z=0）节点的 Uz，左端底边中点补 Ux+Uy、
#        右端底边中点补 Uy → 反力分配 **50.000% / 50.000%**、左端水平力偶 **+0.000**、
#        Step_LL 跨中 uz = −2.13560e−3 m（端截面可自由转动）。
#      ★ 自查判据：看**左右端 ΣRz 是否 50/50** + **左端 Σ(z−h/2)·Rx 是否为 0**；
#        只看 ΣRx≈0 会漏判（两版 ΣRx 都≈0，差别全在力偶里）。
#   ② ★ **规则长方体用软件默认网格参数即可得到纯六面体扫掠网格**：
#      `meshPattern="sweepAndTMesh"` + `hexMeshPattern="sweepOnly"`（默认值）→ 320 个八节点六面体、
#      **0 个四面体**，单元体积合计与理论值**完全相等**（1.080000 m³，偏差 0.0000%）。
#      与本库另两个实体示例（球、圆柱用 `tMeshOnly`，体积偏差 −2.5% / −0.74%）形成对比：
#      **平面边界的实体不要降级 tMeshOnly**，六面体单元数少、无曲面离散误差。
#   ③ ★ **`Ebsload` 的 side 号必须运行时按单元节点坐标判定，不能硬编码**：
#      自动网格生成的单元其局部节点序不保证与建模顺序一致。做法：按手册「体单元面号」表
#      （八节点 Face1=4-3-2-1 / Face2=5-6-7-8 / …；四面体 Face1=3-2-1 / …）逐单元检查
#      "哪个面的全部节点都落在 z = h 上"，取该面在表中的 1-based 序号。
#      本例 80 个顶面单元面**全部命中 Face2**；写入 `52_ElemLoad.inp` 为
#      `iType=11`(BodySurface)、`value=66666.6667`、`iCoords` 全为 2。
#      另实测（本次，六面体扫掠网格）：**`Ebsload` 与"协调等效节点力"（`Cload`，F_i = p·A_i）的
#      ΣRx/ΣRy/ΣRz、对原点力矩、跨中位移逐位相同**，二者可互换。等效节点力即均布面压的一致
#      荷载向量：F_i = p × 该节点相邻顶面单元面的面积份额，不依赖 side 号解释。
#   ④ **混合五步时序 + `Job`/`JobManager` 指派**（漏掉 → 算默认空分析「分析-1」、结果全 0，
#      见 ../../docs/ERRATA.md #51）；`FemModel.fromViewer()` 内部先 `clc()`，编号一律重新取。
# 假设：
#   1) 素混凝土、均质线弹性，不计钢筋、不计开裂
#   2) 支承集中在两端底边一条线（各 3 个节点），端部存在局部应力集中
#   3) 均布压力覆盖全跨（含端部），顶面为自由面，不施加位移约束
#   4) 计入自重（`Emload.value` 是加速度，SI 用 9.81；mm-t 制用 9810）
# 实测：PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0（last release 20261230），全流程约 13 s，
#       模型检查 `{"error":{},"warning":{}}`，3 个荷载步全部收敛（详见文末验证要点）。

# ========== 0. 导入（混合路线五行；init_ctx 紧随其后、clc 之前） ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)   # ★ import 之后、clc() 之前；形参名固定 mode
clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
L_SPAN    = 6.00             # m，跨度，沿 X 向 0 -> L_SPAN
B_SEC     = 0.30             # m，截面宽，沿 Y 向 -B/2 -> +B/2
H_SEC     = 0.60             # m，截面高，沿 Z 向 0 -> H_SEC（Z 竖直向上）
HALF_B    = B_SEC / 2.0      # m，截面半宽
Q_LINE    = 20000.0          # N/m，全跨均布线荷载 20 kN/m
P_TOP     = Q_LINE / B_SEC   # Pa，顶面均布压力 = 66666.67（合力 = P_TOP * L * B = 120000 N）
A_TOP     = L_SPAN * B_SEC   # m^2，顶面面积 = 1.80
MESH_SIZE = 0.15             # m，网格尺寸 = 截面宽的 1/2、梁高的 1/4（→ X40 x Y2 x Z4 = 320 六面体）
G_ACC     = 9.81             # m/s^2，重力加速度（SI）
TOL       = 1.0e-6           # m，坐标判定容差
ANALY_NAME = "Analy_SolidBeam"

# 体单元面号表（1-based 局部节点序，取自手册「单元面编号规则」）；仅用于运行时判定顶面 side 号
FACE_TABLE = {
    4:  [[3, 2, 1], [1, 2, 4], [2, 3, 4], [3, 1, 4]],
    10: [[3, 2, 1], [1, 2, 4], [2, 3, 4], [3, 1, 4]],
    5:  [[4, 3, 2, 1], [1, 2, 5], [2, 3, 5], [3, 4, 5], [4, 1, 5]],
    15: [[4, 3, 2, 1], [1, 2, 5], [2, 3, 5], [3, 4, 5], [4, 1, 5]],
    6:  [[3, 2, 1], [4, 5, 6], [1, 2, 5, 4], [2, 3, 6, 5], [3, 1, 4, 6]],
    8:  [[4, 3, 2, 1], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]],
    20: [[4, 3, 2, 1], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]],
}

# ========== 2. 材料与截面（标准牌号一律查库；体构件用 SectionType.Solid） ==========
MatDB.load()
setting = Setting()                                    # 默认档 = m / N / Pa / kg·m^-3
mat_c30 = MatDB.assemble(name="C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
sec_beam = Section("sec_C30_solid", SectionType.Solid, SolidSect(mid=mat_c30.id))

# ========== 3. ① 几何阶段：节点 → 棱线 → 平面 → 实体 ==========
n_bot = [Node(0.0,    -HALF_B, 0.0),
         Node(L_SPAN, -HALF_B, 0.0),
         Node(L_SPAN,  HALF_B, 0.0),
         Node(0.0,     HALF_B, 0.0)]
n_top = [Node(0.0,    -HALF_B, H_SEC),
         Node(L_SPAN, -HALF_B, H_SEC),
         Node(L_SPAN,  HALF_B, H_SEC),
         Node(0.0,     HALF_B, H_SEC)]

# 12 条棱线：只作面/体边界，一律**不挂 sid**（挂了会额外生成梁单元，见 ../../docs/ERRATA.md #47）
ln_bot = [Line(start=n_bot[i].id, end=n_bot[(i + 1) % 4].id).id for i in range(4)]
ln_top = [Line(start=n_top[i].id, end=n_top[(i + 1) % 4].id).id for i in range(4)]
ln_ver = [Line(start=n_bot[i].id, end=n_top[i].id).id for i in range(4)]

# 6 个平面：outer 传**线构件 id**、四条边闭环；面构件同样不挂 sid（不生成壳单元）
s_bot = Surf(outer=ln_bot, type=SurfType.Plane).id     # 底面 z = 0
s_top = Surf(outer=ln_top, type=SurfType.Plane).id     # 顶面 z = H_SEC（加载面）
s_lat = []
for i in range(4):                                     # 2 个 L×h 侧面 + 2 个 b×h 端面
    j = (i + 1) % 4
    s_lat.append(Surf(outer=[ln_bot[i], ln_ver[i], ln_top[i], ln_ver[j]],
                      type=SurfType.Plane).id)

# 实体：outer 传**面构件 id**；只有体构件挂截面
beam_solid = Solid(outer=[s_bot, s_top] + s_lat,
                   type=SolidType.General, sid=sec_beam.id)

# ========== 4. ①b 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
# 模式全部取软件默认（强制口径）：体网格六面体主导 + 六面体扫掠 + 面网格四边形主导。
# 尺寸依据：最小特征尺寸 = 截面宽 0.30 m → 取 0.15 m（宽的 1/2、梁高的 1/4），
#           预估 X40 × Y2 × Z4 = 320 个六面体；梁高方向 4 层单元可分辨弯曲应力梯度。
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="sweepAndTMesh",     # 体网格：六面体主导（复杂区自动补四面体）
           hexMeshPattern="sweepOnly",      # 六面体类型：扫掠网格
           hexFtPattern="FT",               # 边界恢复（扫掠时不生效）
           toQuad="true")                   # 面网格：四边形主导（字符串，不是布尔值）

# ========== 5. ①c 几何收口 + 网格划分 + 转入有限元 ==========
StruModel.toViewer()          # 1 几何模型可视化（含 Solid → meshGen 自动置 1 = Tmesh）
StruModel.submitAndMesh()     # 2 自动划分网格（MIXED 模式下生成 pypcae.fem.in）
FemModel.fromViewer()         # 3 读入有限元模型（内部先 clc()，几何对象与 id 全部作废）

# ========== 6. ② 有限元阶段：编号一律重新取 ==========
node_pos = {}
for nd in Node.all():
    node_pos[nd.id] = (nd.x, nd.y, nd.z)

solid_elems = [e for e in Element.all() if e.dimension == 3]
solid_eids = [e.id for e in solid_elems]

# 支座节点：仅端面**底边**（z = 0）；每端再单独取底边中点（y = 0）作水平约束点
left_bot   = [nid for nid in node_pos
              if abs(node_pos[nid][0]) <= TOL and abs(node_pos[nid][2]) <= TOL]
right_bot  = [nid for nid in node_pos
              if abs(node_pos[nid][0] - L_SPAN) <= TOL and abs(node_pos[nid][2]) <= TOL]
left_mid   = [nid for nid in left_bot  if abs(node_pos[nid][1]) <= TOL]
right_mid  = [nid for nid in right_bot if abs(node_pos[nid][1]) <= TOL]
left_side  = [nid for nid in left_bot  if nid not in left_mid]   # 底边除中点外的节点
right_side = [nid for nid in right_bot if nid not in right_mid]

# 守卫：宁可报错停下，也不静默少约束 / 少加载（本软件多起"日志报成功但结果错"的坑）
if len(solid_eids) == 0:
    raise RuntimeError("GUARD_NO_SOLID_ELEMENT: mesh produced 0 solid elements")
if len(left_mid) != 1 or len(right_mid) != 1:
    raise RuntimeError("GUARD_HINGE_POINT_MISSING: need exactly 1 node at (0,0,0) and (L,0,0); got "
                       + repr(len(left_mid)) + " / " + repr(len(right_mid)))
if len(left_side) < 2 or len(right_side) < 2:
    raise RuntimeError("GUARD_BOT_EDGE_TOO_FEW: bottom edge needs >=2 nodes besides mid point; got "
                       + repr(len(left_side)) + " / " + repr(len(right_side)))


def read_conn(elem):
    """读回单元连接节点号；不同版本属性名可能不同，逐个候选探测"""
    for key in ("nids", "nodes", "nodeIds", "node_ids", "nIds"):
        cand = getattr(elem, key, None)
        if cand:
            return [int(v) for v in cand]
    return []


def poly_area(pts):
    """空间多边形面积：以首顶点为扇心做三角剖分求和（网格面为平面）"""
    total = 0.0
    p0 = pts[0]
    for k in range(1, len(pts) - 1):
        pa = pts[k]
        pb = pts[k + 1]
        ax, ay, az = pa[0] - p0[0], pa[1] - p0[1], pa[2] - p0[2]
        bx, by, bz = pb[0] - p0[0], pb[1] - p0[1], pb[2] - p0[2]
        cx = ay * bz - az * by
        cy = az * bx - ax * bz
        cz = ax * by - ay * bx
        total += 0.5 * (cx * cx + cy * cy + cz * cz) ** 0.5
    return total


# 运行时定位顶面（z = H_SEC）上的体单元面号 → Ebsload 的 esides = [[单元号, side 号], ...]
top_esides = []
top_area_sum = 0.0
conn_unreadable = 0
face_unhandled = 0
for e in solid_elems:
    conn = read_conn(e)
    table = FACE_TABLE.get(len(conn))
    if table is None:
        if len(conn) == 0:
            conn_unreadable += 1
        else:
            face_unhandled += 1
        continue
    for fi in range(len(table)):
        nids_f = [conn[local - 1] for local in table[fi]]
        on_top = True
        for nid in nids_f:
            pz = node_pos.get(nid)
            if pz is None or abs(pz[2] - H_SEC) > TOL:
                on_top = False
                break
        if on_top:
            top_esides.append([e.id, fi + 1])          # side 号 = 面表序号（1-based）
            top_area_sum += poly_area([node_pos[nid] for nid in nids_f])
            break

if len(top_esides) == 0 and conn_unreadable > 0:
    raise RuntimeError("GUARD_ELEM_NIDS_UNREADABLE: cannot read element connectivity")
if len(top_esides) == 0:
    raise RuntimeError("GUARD_NO_TOP_FACE: no solid element face found at z = H_SEC")
if abs(top_area_sum - A_TOP) > 1.0e-6:                 # 防"漏面导致荷载偏小"
    raise RuntimeError("GUARD_TOP_AREA_MISMATCH: sum(top face area) = " + repr(top_area_sum)
                       + " m^2, expected " + repr(A_TOP) + " m^2; unreadable="
                       + repr(conn_unreadable) + ", unhandled=" + repr(face_unhandled))

# ========== 7. 支座：两端简支（真铰接）——只约束端面底边 ==========
Fixed(gnids=left_side,  dof=[Dof.Uz])                        # 左端底边（除中点）：竖向支承
Fixed(gnids=right_side, dof=[Dof.Uz])                        # 右端底边（除中点）：竖向支承
Fixed(gnids=left_mid,   dof=[Dof.Ux, Dof.Uy, Dof.Uz])        # 左端底边中点：固定铰
Fixed(gnids=right_mid,  dof=[Dof.Uy, Dof.Uz])                # 右端底边中点：滚动铰（释放 Ux）
# 每个节点只被约束一次（中点不重复出现在 left_side/right_side 里），避免重复约束

# ========== 8. 荷载工况（DL / LL 各自独立 LoadCase） ==========
lc_dl = LoadCase("DL")                                   # 恒载：自重
lc_dl.add(Emload(geids=solid_eids, value=G_ACC, dir=[0, 0, -1]))

lc_ll = LoadCase("LL")                                   # 活载：顶面均布面压（软件原生表面荷载）
lc_ll.add(Ebsload(esides=top_esides, value=P_TOP,
                  iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))

# ========== 9. 荷载步与分析（线性静力；含 Step_ALL 包络步） ==========
step_dl  = Step(name="Step_DL",  loadCases=[LoadCaseCombine(lid=lc_dl.id, coef=1.0)])
step_ll  = Step(name="Step_LL",  loadCases=[LoadCaseCombine(lid=lc_ll.id, coef=1.0)])
step_all = Step(name="Step_ALL", loadCases=[LoadCaseCombine(lid=lc_dl.id, coef=1.0),
                                            LoadCaseCombine(lid=lc_ll.id, coef=1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl, step_ll, step_all])   # 不传 setting = 线性静力

# ========== 10. ★ 指派当前分析任务（漏掉 → 算默认空分析「分析-1」，结果全 0） ==========
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)   # 动态取索引，勿硬编码
job = Job(name="Job_SolidBeam", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 11. 收口（混合路线五步齐） ==========
FemModel.toViewer()           # 4 有限元模型可视化（有限元页面在此刷新）
FemModel.submitAndSolve()     # 5 模型检查 + 提交计算

# ========== 验证要点（均为 2026-10-14 实测值；PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0） ==========
# 几何（<项目>/pypcae/pypcae.stru）：节点 8 / 线 12 / 面 6 / 体 1 / 材料 1（C30）/ 截面 1（SolidSect）
# 网格（<项目>/pcaestru-mesh/）：**615 节点 / 320 个八节点六面体（0 个四面体）**；
#   UserMeshParameter.txt（GBK）：`*meshSize 0.15 0.15 0.15 0.15 0`、`*meshGen 1`（含 Solid 自动置 1）、
#   `*meshPattern sweepAndTMesh`、`*mesh 0`（四边形主导）；
#   耗时 tmesh 1.6 s + femesh 1.6 s + mesh-save 1.3 s；
#   ★ 单元体积合计 = **1.080000 m³**，理论 6.0×0.3×0.6 = 1.080000 m³ → **偏差 0.0000%**
#     （平面边界 + 六面体扫掠无离散误差；对比球面 −2.5%、圆柱 −0.74%）
# 约束（genfea-compute*/31_DofFixed.inp）：**4 组共 6 个节点**——
#   组1 `1 1 0 1 1 1` 左端底边 2 节点(仅 Uz)、组2 同掩码 右端底边 2 节点、
#   组3 `0 0 0 1 1 1` 左端底边中点(Ux+Uy+Uz)、组4 `1 0 0 1 1 1` 右端底边中点(Uy+Uz)
#   （掩码语义：**0=约束、1=放开**）
# 荷载（genfea-compute*/52_ElemLoad.inp）：DL `iType=10`(惯性力) 320 单元 value=9.81；
#   LL `iType=11`(BodySurface) **mElem=80**、value=**66666.6666666667**、vector=[0,0,-1]、
#   **iCoords 全部 = 2**（八节点 Face2 = 5-6-7-8，运行时判定全部命中同一个面号）
# 任务指派（genfea-compute*/61_LoadStep.inp）：`*loadStep 3` → Step_DL(nCase=1) / Step_LL(1) / Step_ALL(2)
#   ——若看到 `*loadStep 1` 且步名 `step-1`，说明第 10 步 Job/JobManager 没生效
# 求解（genfea-compute*/log.out）：nNode=615、nElem=320、**neq=1836**、3 步、约 1.4 s、无 fatal；
#   ModelCheckResult.json = `{"error": {}, "warning": {}}`
# ★ 静力平衡（o62_ReactionForce.out，GBK；最硬的判据）：
#   ΣRz = **26487.000 / 120000.000 / 146487.000 N**（Step_DL/LL/ALL）
#     自重理论 ρ·V_mesh·g = 2500×1.080000×9.81 = 26487.000 N → **比值 1.000000**
#     面压理论 p·A_top = 66666.6667×1.80 = 120000.000 N → **比值 1.000000**
#   ΣRx = ΣRy = −0.000 N；对原点 Mx = +0.000 N·m；
#   My = −79461.000 / −360000.000 / −439461.000 N·m（= −Σ x·Rz，因左端水平力偶为 0）
#   → 竖向合力作用点 **x_R = 3.0000 m（跨中）、y_R = 0.000000 m**
#   ★ 简支判据：**左端 ΣRz : 右端 ΣRz = 50.000% : 50.000%**（三步全部），
#     左端水平力偶 Σ(z−h/2)·Rx = **+0.000 N·m**
#     （整端面约束 Ux 的反面版本为 62.4%/37.6% 与 −89358 N·m，见头部要点①）
# 位移（o11_NodeDisp.out）：最大值在跨中侧面中性轴 (x=3.00, y=−0.15, z=0.30) 节点 278；
#   uz = −4.72051e−4 / −2.13560e−3 / −2.60765e−3 m，合位移 4.78023e−4 / 2.16270e−3 / 2.64072e−3 m
#   对照欧拉-伯努利梁 δ = 5qL^4/(384EI)（E=3.0e10、I=b·h^3/12=0.0054、
#   q_DL=ρ·A·g=4414.5、q_LL=20000、q_ALL=24414.5 N/m）：理论 4.59907e−4 / 2.08333e−3 / 2.54317e−3 m
#   → 实测 **+2.64% / +2.51% / +2.54%**，量级与剪切变形项 9.6·EI/(k·G·A·L²) = **2.30%** 一致
#   （G=E/2(1+ν)=1.25e10、k=5/6、A=0.18、L=6）——实体含剪切变形，偏大属预期，**不是网格太粗**；
#   与本库 mixed/stru_to_fem_mixed.py 的梁单元算例同为 +2.5% 量级
# 应力（o52/o53 节点、o43 单元）：最大 Mises 在跨中底面 (x=3.00, y=−0.15, z=0.00) 节点 28：
#   **1.0749 / 4.8735 / 5.9484 MPa**（Step_DL/LL/ALL；o52 平均值、o53 与 o43 的 max 同值）
#   对照弯曲应力 σ = M/W（M=qL²/8、W=b·h²/6=0.018）：Step_ALL 理论 6.104 MPa → 实测 −2.5%
# ⚠ 上述对照只作**复测基准**：教科书公式与软件的单元定义/输出约定可能不一致，偏差不等于错误。
# 核对文件编码：`OutStatic/*.out` 用 **gbk** 读，同目录 `.inp` 用 **utf-8**（见 ../../docs/ERRATA.md）
# 界面：几何页面与有限元页面都能执行本脚本；几何页面只刷新 StruModel.toViewer()，
#   要看网格/约束/荷载/结果云图请切到**有限元模型页面**
# 网格尺寸与边界的其他档位（更细网格、按垫板宽度分布支承）属建模设定变更，须由使用者决定，
#   见 ../../reference/mesh.md「★ 单元类型与网格模式选型」与 ../../reference/supports.md
