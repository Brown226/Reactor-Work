# -*- coding: utf-8 -*-
# 示例：实心球体自重静力（混合路线）—— 球冠面拼整球 + 实体网格 + 线性静力
# 路线：**混合**（几何 → 网格 → 有限元 → 计算，单脚本跑完）
# 单位制：SI（m / N / Pa / kg·m^-3）；Setting() 默认档（实测 iTypeSI=0，各单位取 0 档 = m/N/kg/Pa）
# 模型：R=1.0 m 实心球，C30 混凝土；DL=自重；底部极区（z<=-0.9R，20 个节点）全固定；线性静力
# 要点（★ 两条都是实测才确定的坑，手册未写）：
#   ① 球面拓扑：一个整球 = 上/下两个球冠面 Surf(type=SurfType.Crown, bottom=赤道整圆线 id,
#      center=球心节点号)，且**两个球冠面必须各自引用一条赤道整圆线、两条线的方向点 kp 相反**
#      （一条 kp=北极、一条 kp=南极）——上下半球靠 kp 朝向区分。
#      ✗ 反例（实测均划出 0 个体单元、但日志仍报"任务执行成功!"）：
#        - 两个 Crown 共用同一条整圆线 → 两面序列化后完全相同（outer=[0,0]），实体不闭合；
#        - Crown 传 top=顶点节点号（想用它区分上下）→ 同样 0 单元。
#   ② 分析任务指派：软件会自动生成一个默认分析「分析-1」（只含一个空荷载步 step-1）。
#      不建 Job/JobManager 时 submitAndSolve() 算的是这个默认空分析 → 位移与反力**全为 0**，
#      而 run_script 返回 success、日志末尾也是"任务执行成功!"（静默零结果，见 ../../docs/ERRATA.md）。
#      正确写法：Job(name=..., main=自建分析在 Analy.all() 中的索引) + JobManager(main=同索引, jobs=[job])。
#   ③ 整圆线 = Line(start=X, end=X, center=球心, kp=方向点, type=LineType.Arc)（起点=终点）；
#   ④ 体构件挂 SectionType.Solid + SolidSect(mid=材料号)；含 Solid 时 *meshGen 自动置 1（Tmesh）；
#   ⑤ 混合五步时序不可颠倒；有限元阶段编号一律重新取（fromViewer 内部先 clc()）。
# 实测（PkpmCAE pypcae 2.1.0 / last release 20261230，全流程 18.1 s，模型检查通过）：
#   网格 ~880 节点 / ~4200 四面体（两次实测 892/4277 与 877/4196，tmesh 结果有小幅波动，
#   别把单元数当硬判据）；单元体积合计 4.085 m3（理论 4.1888，-2.5% 为曲面离散）；
#   ΣRz = 100185~100187 N，与 ρ·V_mesh·g **完全相等（比值 1.0000）**——反力平衡才是硬判据；
#   ΣRx = ΣRy = 0；最大合位移 0.0033 mm；节点 Mises 最大 0.187 MPa（<< C30 抗压 20.1 MPa）。

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)   # ★ import 之后、clc() 之前；形参名固定 mode
clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
R = 1.0                 # m，球半径
MESH_SIZE = 0.2         # m，网格尺寸（≈ R/5；改 0.1 可收敛体积误差，单元数约 ×8）
GRAV = 9.81             # m/s2，自重加速度（SI 用 9.81；mm-t 制用 9810）
Z_FIX = -0.9 * R        # m，底部极区约束标高（z <= Z_FIX 的节点全固定）
ANALY_NAME = "Static_Sphere"

# ========== 2. 材料与截面 ==========
MatDB.load()
setting = Setting()                       # 默认档 = m / N / Pa / kg·m^-3
mat = MatDB.assemble(name="C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
solid_sec = Section("solid_C30", SectionType.Solid, SolidSect(mid=mat.id))

# ========== 3. ① 几何阶段：节点 → 整圆线 → 球冠面 → 实体 ==========
n_center = Node(0.0, 0.0, 0.0)            # 球心（Crown 的 center）
n_eq = Node(R, 0.0, 0.0)                  # 赤道整圆线的起点 = 终点
n_north = Node(0.0, 0.0, R)               # 北极（上半球赤道线的方向点 kp）
n_south = Node(0.0, 0.0, -R)              # 南极（下半球赤道线的方向点 kp）

cir_up = Line(start=n_eq.id, end=n_eq.id, center=n_center.id,
              kp=n_north.id, type=LineType.Arc)      # 赤道整圆线（朝向 +z）
cir_dn = Line(start=n_eq.id, end=n_eq.id, center=n_center.id,
              kp=n_south.id, type=LineType.Arc)      # 赤道整圆线（朝向 -z）

s_up = Surf(type=SurfType.Crown, bottom=cir_up.id, center=n_center.id)   # 上半球面
s_dn = Surf(type=SurfType.Crown, bottom=cir_dn.id, center=n_center.id)   # 下半球面
ball = Solid(outer=[s_up.id, s_dn.id], type=SolidType.General, sid=solid_sec.id)

# ========== 4. ①b 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="tMeshOnly",       # 实体为主 → 四面体
           toQuad="true")                 # 字符串，不是布尔值

# ========== 5. ①c 几何收口 + 网格 + 转入有限元 ==========
StruModel.toViewer()                      # 1 几何模型可视化（几何页面在此刷新）
StruModel.submitAndMesh()                 # 2 自动划分网格（MIXED 模式下生成 pypcae.fem.in）
FemModel.fromViewer()                     # 3 读入有限元模型（内部先 clc()，几何对象与 id 作废）

# ========== 6. ② 有限元阶段：编号一律重新取 ==========
all_nodes = Node.all()
bot_nids = [n.id for n in all_nodes if n.z <= Z_FIX]                 # 底部极区节点（实测 20 个）
solid_eids = [e.id for e in Element.all() if e.dimension == 3]       # 实体单元（dimension==3）

# ========== 7. 约束 ==========
Fixed(gnids=bot_nids, dof=[Dof.All])

# ========== 8. 荷载工况（自重，独立 DL 工况） ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=solid_eids, value=GRAV, dir=[0, 0, -1]))      # value 是加速度；geids 留空=全局

# ========== 9. 荷载步与分析（不传 setting = 默认线性静力） ==========
step_dl = Step(name="Step_DL", loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl])

# ========== 10. ★ 指定当前分析任务（漏掉这一步 → 算默认空分析，结果全 0） ==========
analy_names = [a.name for a in Analy.all()]          # 实测含软件自动生成的"分析-1"，索引 0
main_idx = analy_names.index(ANALY_NAME)             # 自建分析的真实索引（本例为 1，不要硬编码）
job = Job(name="Job_Sphere", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 11. 收口（混合路线五步齐） ==========
FemModel.toViewer()                     # 4 有限元模型可视化（有限元页面在此刷新）
FemModel.submitAndSolve()               # 5 模型检查 + 提交计算

# ========== 验证要点（均为 2026-10-12 实测值） ==========
# 几何：2 条整圆线 + 2 个球冠面 + 1 个实体；包围盒 X/Y/Z 均 [-1, 1] m
# 网格：约 880 节点 / 4200 四面体（两次实测 892/4277、877/4196，tmesh 有小幅波动）；
#       *meshGen 自动置 1；单元体积合计 4.085 m3，理论 V = 4/3·π·R3 = 4.1888 m3 → -2.5%（曲面离散）
# 静力平衡（★ 最硬的判据，用网格体积而不是理论体积）：
#       ΣRz 应 = ρ·V_mesh·g = 2500 × 4.085 × 9.81 ≈ 100185 N
#       实测 ΣRz = 100185.2 N（比值 1.0000）；ΣRx = ΣRy = 0（对称）；约束节点 20 个
#       若 ΣRz = 0 → 第 10 步 Job/JobManager 没生效（查 61_LoadStep.inp 步名是否为 step-1）
#       若单元数 = 0 → 球面没闭合（查两个 Crown 是否各用一条 kp 反向的整圆线）
# 变形与应力：最大合位移 0.0033 mm（最大下沉在球顶附近，uz = -0.0032 mm）；
#       节点 Mises 最大 0.187 MPa，出现在底部极区约束处（应力集中），远小于 C30 抗压 20.1 MPa
# 核对文件（文本）：<项目>/genfea-compute*/OutStatic/o11_NodeDisp.out（iNum,ux,uy,uz）、
#       o62_ReactionForce.out（iFix,iNode,Rx,Ry,Rz）、o52_NodeMisesStress.out（iNum,mises）；
#       ⚠ .out/.inp 用 encoding="gbk"（.out）/ "utf-8"（.inp）读，见 ../../docs/ERRATA.md
# 界面：几何页面与有限元页面都能执行本脚本；几何页面只刷新 StruModel.toViewer()，
#       要看网格/约束/结果请切到有限元模型页面
