# -*- coding: utf-8 -*-
# 示例：几何模型 → 网格划分 → 有限元计算（混合路线，同一脚本跑完全过程）
# 模型：单跨简支梁（通用几何线构件），均布活载 + 自重，线性静力
# 单位制：SI（m / N / Pa）
# 路线时序（不可颠倒）：
#   init_ctx(mode=ExecutionMode.MIXED) → clc() → 几何建模 + 网格设置
#   → StruModel.toViewer() → StruModel.submitAndMesh() → FemModel.fromViewer()
#   → 有限元阶段（编号重新取）→ FemModel.toViewer() → FemModel.submitAndSolve()
# 界面：几何模型页面与有限元模型页面都可执行本脚本；几何页面只刷新 StruModel.toViewer()，
#       要看有限元模型与计算结果请切到有限元模型页面
# ★ 关键坑（实测）：必须用 Job + JobManager 把"当前分析任务"指向自建的 Analy——软件会自动生成
#   一个默认分析"分析-1"（只含一个空荷载步 step-1），不指派时 submitAndSolve() 算的是它，
#   位移与反力全为 0，而 run_script 仍返回 success、日志仍写"任务执行成功!"（静默零结果）。
# 实测：PkpmCAE pypcae 2.1.0（last release 20261230）全流程跑通，结果见文末验证要点。

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)   # ★ 混合模式开关：形参名固定 mode，位置在 import 之后、clc() 之前
clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
SPAN = 6.0            # m，跨度
SEC_B = 0.30          # m，截面宽
SEC_H = 0.60          # m，截面高
Q_LL = 20000.0        # N/m，均布活载
MESH_SIZE = 0.50      # m，网格尺寸（→ 约 12 个梁单元）
ANALY_NAME = "StaticAnalysis"   # 分析名（第 10 步按名字取索引，别硬编码）

# ========== 2-3. 材料与截面（标准牌号一律查库） ==========
MatDB.load()
setting = Setting()                   # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
beam_sec = Section("Beam300x600", SectionType.Line,
                   Rectangle(mid=mat.id, b=SEC_B, h=SEC_H))

# ========== ① 几何阶段：节点 + 线构件 ==========
n_left  = Node(0.0, 0.0, 0.0)
n_right = Node(SPAN, 0.0, 0.0)
beam_line = Line(start=n_left.id, end=n_right.id, type=LineType.Straight,
                 sid=beam_sec.id, normal=[0, 1, 0])   # X 向梁：截面 Y 向取 [0,1,0]（不得与杆轴平行）

# ========== ①b 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE, beamSize=MESH_SIZE),
           toQuad="true")

# ========== ①c 几何收口 + 网格划分 ==========
StruModel.toViewer()                  # 1 几何模型可视化（几何页面在此刷新）
StruModel.submitAndMesh()             # 2 网格划分，生成 pypcae.fem.in（仅 MIXED 模式生成）
FemModel.fromViewer()                 # 3 读入网格后的有限元模型（内部先 clc()，几何对象与 id 作废）

# ========== ② 有限元阶段：编号一律重新取 ==========
all_elems = Element.all()
beam_eids = [e.id for e in all_elems if e.dimension == 1]        # 网格生成的梁单元
left_nids  = [n.id for n in Node.all() if abs(n.x - 0.0)  < 1e-6]  # 左端节点（按坐标重筛）
right_nids = [n.id for n in Node.all() if abs(n.x - SPAN) < 1e-6]  # 右端节点

# ========== 7. 支座（简支：左端固定铰，右端滑动铰，均加 Phx 防扭转刚体模态） ==========
Fixed(gnids=left_nids,  dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx])
Fixed(gnids=right_nids, dof=[Dof.Uy, Dof.Uz, Dof.Phx])            # 释放 Ux（纵向滑动）

# ========== 8. 荷载工况（DL / LL 各自独立，禁止混装） ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=beam_eids, value=9.81, dir=[0, 0, -1]))    # 自重：value 是加速度（SI 用 9.81）

lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=beam_eids, type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[Q_LL],
                 iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))       # dir 是方向矢量，不是自由度名

# ========== 9. 荷载步与分析（含 Step_ALL 包络步） ==========
step_dl = Step(name="Step_DL", loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
step_ll = Step(name="Step_LL", loadCases=[LoadCaseCombine(lc_ll.id, 1.0)])
step_all = Step(name="Step_ALL", loadCases=[LoadCaseCombine(lc_dl.id, 1.0),
                                            LoadCaseCombine(lc_ll.id, 1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl, step_ll, step_all])   # 不传 setting = 默认线性静力

# ========== 10. ★ 指定当前分析任务（漏掉 → 算软件默认的"分析-1"空步，结果全 0） ==========
# 软件会自动生成一个默认分析（Analy.all() 里名为"分析-1"，只含一个空荷载步 step-1）；
# submitAndSolve() 只算 JobManager 指向的当前任务，不指派就算那个空分析，且日志仍报"成功"。
analy_names = [a.name for a in Analy.all()]
main_idx = analy_names.index(ANALY_NAME)          # 自建分析的真实索引（不要硬编码）
job = Job(name="Job_Beam", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 11. 收口（有限元） ==========
FemModel.toViewer()                  # 4 有限元模型可视化（有限元页面在此刷新）
FemModel.submitAndSolve()            # 5 模型检查 + 提交计算

# ========== 验证要点（理论解对照；实测值取自 2026-10-12 PkpmCAE pypcae 2.1.0） ==========
# 模型：nNode=13、nElem=12（MESH_SIZE=0.5 m → 12 个梁单元）；61_LoadStep.inp 应为 *loadStep 3
#       （Step_DL nCase=1 / Step_LL nCase=1 / Step_ALL nCase=2）——若看到 *loadStep 1 且名为
#       "step-1"，说明第 10 步的 Job/JobManager 没生效，算的是默认空分析
# 截面：I = b·h3/12 = 0.0054 m4；W = b·h2/6 = 0.018 m3；自重 q_DL = ρ·A·g = 13861.5 N/m
# 跨中挠度 δ = 5qL4/(384EI)（欧拉-伯努利梁，不含剪切）：
#   Step_DL  理论 0.2103 mm   实测 0.2155 mm  (+2.5%)
#   Step_LL  理论 0.3034 mm   实测 0.3110 mm  (+2.5%)
#   Step_ALL 理论 0.5137 mm   实测 0.5265 mm  (+2.5%)
#   ★ +2.5% 不是误差：程序梁单元含剪切变形，δ_shear/δ_bend = 9.6·EI/(k·G·A·L2)
#     = 9.6×1.1124e9 / (0.8333×7.923e10×0.18×36) = 2.50%，与实测偏差完全吻合
# 支座反力 ΣRz（o62_ReactionForce.out）：
#   Step_DL 理论 83169.2 N  实测 83169.2 N（比值 1.0000）
#   Step_LL 理论 120000.0 N 实测 120000.0 N（比值 1.0000）
#   Step_ALL 理论 203169.2 N 实测 203170.0 N（比值 1.0000）
# 应力：节点 Mises 最大 实测 8.465 MPa，理论 σ = M/W = 152.4 kN·m / 0.018 m3 = 8.47 MPa（-0.06%）
# 网格收敛性：MESH_SIZE 取 0.5 / 0.25 两套，跨中挠度差应 < 1%（梁单元位移收敛快，
#   差别主要来自剪切项与单元数，见 ../../reference/verification.md）
# 核对文件：<项目>/genfea-compute*/OutStatic/o11_NodeDisp.out（每步一个 (iStep,time) 行 +
#   13 行 (iNum,ux,uy,uz)）、o62_ReactionForce.out（(iFix,iNode,Rx,Ry,Rz)）、o52_NodeMisesStress.out；
#   .out 用 encoding="gbk" 读，同目录 .inp 用 "utf-8"（见 ../../docs/ERRATA.md）
# 界面：几何页面与有限元页面都能执行本脚本；几何页面只刷新 StruModel.toViewer()，
#   要看网格/荷载/结果请切到有限元模型页面
