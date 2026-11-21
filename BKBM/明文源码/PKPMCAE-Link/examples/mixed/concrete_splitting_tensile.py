# -*- coding: utf-8 -*-
# 示例：混凝土圆柱劈裂抗拉（Brazilian splitting）试验 —— 混合路线 + 刚性垫条力控制
# 路线：**混合**（几何 → 网格 → 有限元 → 计算，单脚本跑完）
# 单位制：SI（m / N / Pa / kg·m^-3）；Setting() 默认档（实测 iTypeSI=0）；mm 输入已换算为 m
# 模型：C30 圆柱试件 Φ150 × H150 mm（GB/T 50081 标准圆柱），轴线沿 Z；±X 两侧各一条
#       20 mm 宽 × 150 mm 通长刚性垫条；力控制 P = 50 kN 单调压入；线性静力
# 要点（★ ①②③ 都是实测才确定的坑，手册未写）：
#   ① **垫条边界必须做成几何断点**：圆周若只用一条整圆线 Line(start=end)，垫条带内可能一个
#      网格节点都没有 → "20 mm 宽垫条"静默退化成一条线荷载。做法：把圆周按断点角
#      [-TH_PAD, +TH_PAD, 90°, 180°-TH_PAD, 180°+TH_PAD, 270°] 切成 6 段圆弧线（每段 < 180°，
#      劣弧无歧义），6 段弧 → 6 片 Surf(Cylinder) 侧面片；同端 6 条弧围合成 Surf(Plane) 圆盘端面；
#      8 个面 → Solid 闭合实体。圆弧线必须同时给 center + kp；kp 统一取"圆心正上方"的方向点，
#      实测规律：**弧的凸向 = (kp-center) × (start-center)**，故 kp 在 +z 侧时各段弧按逆时针取劣弧。
#   ② **刚性垫条 = Coupling(CouplingType.Rigid) + 悬空参考点**，集中力 Cload 加在参考点上
#      （不要直接怼在单个表面节点上）；参考点在 fromViewer() 之后新建，相对试件表面外移 T_PAD，
#      因力与偏移共线 → r×F = 0，不引入附加力矩。垫条带节点按坐标筛（r≈R 且 |y| ≤ W_PAD/2），
#      能筛到是因为 ① 里 ±TH_PAD 已是真实几何边线（实测每侧 38 个节点）。
#   ③ ★ **参考点是耦合主节点、带 6 个自由度**：只约束它的 3 个平动时，绕"过该点的 X/Y/Z 轴"的
#      3 个刚体转动不被任何约束阻止（转动不移动该点本身）→ 总刚奇异 → 求解器返回带虚假刚体转动的解
#      （实测 uy 虚假漂移 -77 μm、拟合残余刚体转角 4.6e-4 rad），且 **o62 反力全为 0**，而
#      run_script 仍返回 success、日志仍写"任务执行成功!"（静默奇异解，见 ../../docs/ERRATA.md #69）。
#      修复：Fixed(gnids=[rp_fix.id], dof=[Dof.All])。
#   ④ 混合五步时序不可颠倒；有限元阶段编号一律重新取（fromViewer 内部先 clc()）；Analy 之后必须
#      Job + JobManager 指派当前分析任务，否则算软件默认的「分析-1」空分析、结果全 0（#51）。
# 实测（PkpmCAE pypcae 2.1.0 / last release 20261230，全流程 **18.4 s**，模型检查通过，
#       复跑两次网格与结果**完全一致**）：
#   几何 15 节点 / 12 圆弧线 / 8 面（6 圆柱面片 + 2 圆盘）/ 1 实体 / 1 材料 / 1 截面；
#   网格 **1479 节点 / 7219 四面体**（*meshGen 自动置 1 = Tmesh）；单元体积合计 2.631150e-3 m³
#     （理论 πR²H = 2.650719e-3 m³，**−0.74%** 为曲面离散）；
#   **ΣRx = +49999.99 N，与施加的 50 kN 比值 1.000000**；ΣRy = ΣRz = 0，ΣMx = ΣMy = ΣMz = 0；
#   拟合残余刚体转角 3.4e-7 rad（约束修复前 4.6e-4 rad，相差 3 个数量级）；
#   加载带 ux = −27.49 μm，最大合位移 0.0277 mm；±Y 面 uy = +2.52 / −2.35 μm（反对称 ✓ 横向劈裂张开）；
#   中心 20 mm 球域（13 节点）Mises 均值 **4.870** / 最大 5.261 MPa，弹性理论解 **4.974 MPa**
#     → 偏差 **−0.4%**；峰值 Mises 24.289 MPa 出现在垫条边缘（仅 12 个节点 > 15 MPa）。

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx
import math

init_ctx(mode=ExecutionMode.MIXED)   # ★ import 之后、clc() 之前；形参名固定 mode
clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
D_SPEC    = 0.150            # m，试件直径 150 mm（GB/T 50081 标准圆柱试件）
R_SPEC    = D_SPEC / 2.0     # m，半径 75 mm
H_SPEC    = 0.150            # m，试件高度（= 轴向承压长度 L）150 mm
W_PAD     = 0.020            # m，刚性垫条宽度 20 mm（沿周向的弦宽）
W_HALF    = W_PAD / 2.0      # m，垫条半宽 10 mm
T_PAD     = 0.010            # m，加载参考点相对试件表面的外移量（等效垫条/压头厚度）
MESH_SIZE = 0.0125           # m，全局网格尺寸 ≈ D/12（改小可收敛，单元数按 h^-3 增长）
P_TOTAL   = 50.0e3           # N，劈裂总压力 50 kN（力控制，单次单调加载）
ANALY_NAME = "Analy_Splitting"

TH_PAD = math.asin(W_HALF / R_SPEC)      # rad，垫条半张角 ≈ 7.662°
KP_Z   = H_SPEC + R_SPEC                 # m，圆弧方向点标高（+z 参考点，非实体几何点）
TOL_R  = 1.0e-4                          # m，判定"落在圆柱面上"的径向容差（0.1 mm）
TOL_Y  = 1.0e-4                          # m，判定"落在垫条带内"的横向容差（0.1 mm）

# 圆周断点角（逆时针递增，全部 < 180°，保证取到的是劣弧）：
#   -TH_PAD -> TH_PAD 为 +X 侧垫条带；PI-TH_PAD -> PI+TH_PAD 为 -X 侧垫条带
ANGS = [-TH_PAD, TH_PAD, 0.5 * math.pi,
        math.pi - TH_PAD, math.pi + TH_PAD, 1.5 * math.pi]
N_ARC = len(ANGS)                        # = 6 段圆弧 / 每端

# ========== 2. 材料与截面（标准牌号必须查库） ==========
MatDB.load()
setting = Setting()                                   # 默认 SI（m / N / Pa / kg·m^-3）
mat_c30 = MatDB.assemble(name="C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
sec_spec = Section("sec_C30_solid", SectionType.Solid, SolidSect(mid=mat_c30.id))

# ========== 3. ① 几何阶段：节点 -> 圆弧线 -> 面 -> 实体 ==========
n_kp   = Node(0.0, 0.0, KP_Z)          # 圆弧方向点（所有圆弧共用，z+ 侧）
n_cbot = Node(0.0, 0.0, 0.0)           # 底面圆心（z=0）
n_ctop = Node(0.0, 0.0, H_SPEC)        # 顶面圆心（z=H）
n_bot  = [Node(R_SPEC * math.cos(a), R_SPEC * math.sin(a), 0.0)     for a in ANGS]
n_top  = [Node(R_SPEC * math.cos(a), R_SPEC * math.sin(a), H_SPEC)  for a in ANGS]


def make_ring_arcs(ring_nodes, center_id):
    """按逆时针顺序把一圈断点连成 N_ARC 段圆弧线，返回线构件 id 列表"""
    ids = []
    for i in range(N_ARC):
        ids.append(Line(start=ring_nodes[i].id,
                        end=ring_nodes[(i + 1) % N_ARC].id,
                        center=center_id, kp=n_kp.id,
                        type=LineType.Arc).id)
    return ids


arc_bot = make_ring_arcs(n_bot, n_cbot.id)     # 底面圆周 6 段弧
arc_top = make_ring_arcs(n_top, n_ctop.id)     # 顶面圆周 6 段弧

# 侧面：6 片圆柱面（bottom=低标高边线，top=高标高边线，不传 outer）
s_lat = [Surf(bottom=arc_bot[i], top=arc_top[i], type=SurfType.Cylinder).id
         for i in range(N_ARC)]
# 上下端面：各由 6 条圆弧围合成一个平面圆盘
s_bot = Surf(outer=arc_bot, type=SurfType.Plane).id
s_top = Surf(outer=arc_top, type=SurfType.Plane).id
# 实体：8 个面包围（6 侧面 + 2 端面），挂 Solid 截面
specimen = Solid(outer=s_lat + [s_bot, s_top],
                 type=SolidType.General, sid=sec_spec.id)

# ========== 4. ①b 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="tMeshOnly",       # 实体为主 -> 四面体主导
           toQuad="true")                 # 字符串，不是布尔值

# ========== 5. ①c 几何收口 + 网格划分 + 转入有限元 ==========
StruModel.toViewer()          # 1 几何模型可视化（几何页面在此刷新；含 Solid -> meshGen 自动置 1）
StruModel.submitAndMesh()     # 2 自动划分网格（MIXED 模式下生成 pypcae.fem.in）
FemModel.fromViewer()         # 3 读入有限元模型（内部先 clc()，几何对象与 id 全部作废）

# ========== 6. ② 有限元阶段：编号一律重新取，筛出两条垫条带节点 ==========
all_nodes = Node.all()
n_solid   = len([e for e in Element.all() if e.dimension == 3])

band_r = []      # +X 侧垫条带（加载侧）
band_l = []      # -X 侧垫条带（支承侧）
for nd in all_nodes:
    rr = math.sqrt(nd.x * nd.x + nd.y * nd.y)
    if abs(rr - R_SPEC) <= TOL_R and abs(nd.y) <= W_HALF + TOL_Y:
        if nd.x > 0.0:
            band_r.append(nd.id)
        elif nd.x < 0.0:
            band_l.append(nd.id)

# ========== 7. 刚性垫条 = 参考点 + 刚性耦合（参考点在 fromViewer 之后新建） ==========
rp_load = Node(R_SPEC + T_PAD, 0.0, 0.5 * H_SPEC)      # +X 侧加载参考点
rp_fix  = Node(-(R_SPEC + T_PAD), 0.0, 0.5 * H_SPEC)   # -X 侧支承参考点

Coupling(tarNode=[rp_load.id], srcNodes=band_r,
         type=CouplingType.Rigid, iKey=DofMode.Both)   # 主=参考点，从=垫条带节点
Coupling(tarNode=[rp_fix.id], srcNodes=band_l,
         type=CouplingType.Rigid, iKey=DofMode.Both)

# ========== 8. 约束（支承侧参考点 6 个自由度全约束 = 刚性夹持的压力机垫座） ==========
# ★ 必须连转动一起约束：rp_fix 是刚性耦合的主节点，具有 6 个自由度；只约束 3 个平动时，
#   绕"过 rp_fix 的 X / Y / Z 轴"的 3 个刚体转动不被任何约束阻止（转动不移动 rp_fix 本身）
#   -> 总刚奇异 -> 求解器返回带虚假刚体转动的解，且 o62 反力全为 0（实测已复现）。
Fixed(gnids=[rp_fix.id], dof=[Dof.All])

# ========== 9. 荷载工况（试验荷载 PL，力控制） ==========
lc_pl = LoadCase("PL")
lc_pl.add(Cload(gnids=[rp_load.id], dof=[FDof.Fx], value=[-P_TOTAL]))   # 沿 -X 压入 50 kN

# ========== 10. 荷载步与分析（不传 setting = 默认线性静力） ==========
step_pl = Step(name="Step_PL", loadCases=[LoadCaseCombine(lc_pl.id, 1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_pl])

# ========== 11. ★ 指定当前分析任务（漏掉 -> 算默认空分析"分析-1"，结果全 0） ==========
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)     # 动态取索引，勿硬编码
job = Job(name="Job_Splitting", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 12. 收口（混合路线五步齐） ==========
FemModel.toViewer()           # 4 有限元模型可视化（有限元页面在此刷新）
FemModel.submitAndSolve()     # 5 模型检查 + 提交计算

# ========== 验证要点（均为 2026-10-13 实测值，PkpmCAE pypcae 2.1.0 / 20261230） ==========
# 几何（读 <项目>/pypcae/pypcae.stru）：节点 15（1 个圆弧方向点 + 2 个端面圆心 + 每端 6 个断点）
#   / 线 12（每端 6 段圆弧）/ 面 8（6 片圆柱侧面 + 2 个圆盘端面）/ 体 1 / 材料 1（C30）/ 截面 1（SolidSect）
#   包围盒 X/Y = ±75 mm，Z = 0~150 mm；另有一个 z = 225 mm 的圆弧方向点（kp 参考点，非实体）
# 网格（读 <项目>/pcaestru-mesh/fe_modelSource.json）：1479 节点 / 7219 四面体，两次复跑完全相同
#   ★ 体积核对（判几何是否闭合）：逐个 V = |det(b-a, c-a, d-a)|/6 求和 = 2.631150e-3 m³，
#     理论 πR²H = 2.650719e-3 m³ → **−0.74%**。若为理论值的一半 → 某段圆弧取成了优弧，实体只闭了一半
#   垫条带节点：+X 侧 38 个、−X 侧 38 个（读 genfea-compute*/18_Coupling.inp 的 nSrc 核对）
# 静力平衡（★ 最硬的判据，o62_ReactionForce.out，GBK 编码）：
#   *reactionForce 1 39 0 → 39 条：1 条是参考点 1481（刚性耦合下反力为 0，属正常，
#     荷载经耦合转到了 38 个从节点上）+ 38 条是支承垫条带从节点
#   ΣRx = +49999.99 N = 施加荷载 50 kN，**比值 1.000000**；ΣRy = −0.002 N、ΣRz = +0.001 N ≈ 0
#   ⚠ ΣRx = 0 而位移不为 0 → 第 8 步只约束了参考点的平动（见要点 ③ / ERRATA #69）；
#     自查：对全部网格节点做刚体运动最小二乘拟合，残余转角应在 1e-6 rad 量级
#   ⚠ 位移反力全 0 → 第 11 步 Job/JobManager 没生效（查 61_LoadStep.inp 的 *loadStep 步名
#     应为 Step_PL，若是 step-1 就是算了默认空分析，#51）
# 应力对标弹性理论解（圆盘直径受压，荷载沿 X、承压长度 L = H）：
#   中心应力：σ_t（垂直加载方向的劈裂拉应力）= 2P/(πDL) = **1.4147 MPa**
#             σ_c（沿加载方向）= −6P/(πDL) = **−4.2441 MPa**
#             σ_z = ν(σ_t+σ_c) = **−0.5659 MPa**
#     → 理论 Mises = √{½[(σc−σt)²+(σt−σz)²+(σz−σc)²]} = **4.974 MPa**
#     实测中心 20 mm 球域（13 节点）均值 **4.870 MPa**、最大 5.261 MPa → 偏差 **−0.4%** ✓
#     （本任务的文本结果只有 Mises，无应力分量：OutStatic 下仅 o52/o53_NodeMises*、
#       o43_ElemMisesConcrete；用 Mises 对标即可反证三个主应力量级都对）
#   位移对标：加载带 ux = −27.49 μm（直径缩短 27.5 μm）；±Y 面 uy = +2.52 / −2.35 μm
#     → 横向直径伸长 4.9 μm，**反对称 ✓**（劈裂张开方向正确）；最大合位移 0.0277 mm
#   应力集中：峰值 Mises 24.289 MPa 在垫条边缘（|y| = 8.6~21.7 mm、x ≈ ±60~75 mm），
#     全模型仅 12 个节点 > 15 MPa → 属"刚性垫条"理想化的局部效应，**不得当强度判据**；
#     垫条平均接触压应力 P/(W_PAD·H) = 16.67 MPa，峰值已超 C30 f_ck = 20.1 MPa，
#     真实试验中此处会先局部压碎（故规范限定垫条宽度）
#   线性外推：令 σ_t = f_tk = 2.01 MPa → 劈裂荷载 P_f = f_tk·πDL/2 ≈ **71.0 kN**，
#     本例 50 kN ≈ 0.70 P_f，仍在线弹性范围内；要做破坏全过程需换混凝土塑性损伤本构
#     （材料库 C30 的 iModel=2 条目）+ AnalySetting(iNLType=NLType.MaterNonlinear) + 多 Step 分级
#   自重：ρ·V_mesh·g = 2500 × 2.631150e-3 × 9.81 = 64.5 N，仅为试验荷载的 **0.129%** → 本例不计
# 求解规模：neq = 4206，nElem = 7219，求解 1 s（genfea-compute*/log.out begin→end）
# 核对文件（文本）：<项目>/genfea-compute*/OutStatic/o11_NodeDisp.out（iNum,ux,uy,uz）、
#   o52_NodeMisesStress.out、o53_NodeMisesConcrete.out、o62_ReactionForce.out（iFix,iNode,Rx..Mz）；
#   ⚠ .out 用 encoding="gbk"、同目录 .inp 用 "utf-8"（见 ../../docs/platform_tools.md）
# save_script 校验：通过，仅 1 条**预期**警告"连通性异常: 1/2 个单元与主体结构不连接（无共享节点）"
#   —— 指的是 2 个悬空加载参考点，它们靠 Coupling 而非共享节点连到主体，属刚性垫条的正常构造
# 界面：几何模型页面与有限元模型页面都能执行本脚本；几何页面只刷新 StruModel.toViewer()、
#   有限元页面只刷新 FemModel.toViewer()，要看网格/垫条/约束/结果请切到有限元模型页面
