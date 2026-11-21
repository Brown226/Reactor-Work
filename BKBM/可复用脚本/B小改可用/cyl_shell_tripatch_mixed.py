# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：圆柱面 TriPatch 离散面壳（混合路线：几何 → 网格 → 自重静力 + 模态）
# 实测环境：PkpmCAE 本机 femesh/genfea；pypcae 2.1.0（last release 20261230）
# 本示例印证的配方与坑位（../../docs/ERRATA.md）：
#   ★#122 TriPatch 离散面在混合路线全链路可用：几何 → 自动网格 → fromViewer →
#        底环固接 → 自重静力（ΣRz = 967025 N ≈ 网格自重）+ 模态（nModal=10，
#        频率 1.859~2.596 Hz，成对出现、无零频）；
#   ★#120 TriPatch 单面写法（outer 边界回路 + patches 面片表）；
#   #51  Job + JobManager 必写，且索引用 Analy.all() 动态取（漏写则算默认空分析）；
#   #7   多分析拆多 Analy + 多 Job，CUR_TASK 开关分次提交（一次只算一个任务）；
#   #19  LoadToMassSetting（模态质量源）是网格设置，必须在 StruModel.toViewer() 之前。
# 路线: 混合（init_ctx(MIXED) 五步时序）
# 模型描述: 开口圆柱面壳 R=10 m × H=20 m，Q235 壳 t=10 mm，圆周 48 段 TriPatch 离散；
#   底环（z=0）全部网格节点 Dof.All 固接（悬臂圆筒），顶环自由；
#   分析 1：DL 自重线性静力；分析 2：模态前 10 阶（质量源 = 密度 + DL 荷载转质量）。
# 网格: basicSize=1.0 m → 2016 节点 / 1920 四边形壳单元
# 运行: ★ 顶部 CUR_TASK 常量切换任务（0=静力 / 1=模态），同脚本分两次运行
# 单位制: SI（m / N / Pa）
# ============================================================================

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx
import math

init_ctx(mode=ExecutionMode.MIXED)      # ★ 混合模式开关：import 之后、clc() 之前
clc()
MatDB.load()

# ========== 1. 参数 ==========
R = 10.0           # m，圆柱面半径
H = 20.0           # m，高度
T = 0.01           # m，壳厚（Q235 t=10mm）
N = 48             # 圆周离散段数
MESH = 1.0         # m，总体网格尺寸
CUR_TASK = 0       # ★ 0 = 自重静力分析; 1 = 模态分析（前 10 阶）

# ========== 2. 几何阶段：材料 / 截面 ==========
setting = Setting()
mat = MatDB.assemble(name="Q235", iType=MaterialType.Steel,
                     iMark=SteelType.Q235, setting=setting)
sec_shell = Section("shell_t10", SectionType.Surface, SingleLayer(mid=mat.id, t=T))

# ========== 3. 几何阶段：节点 / 线 / 单 TriPatch 离散面 ==========
nb = []
nt = []
for i in range(N):
    th = 2.0 * math.pi * i / N
    x = R * math.cos(th)
    y = R * math.sin(th)
    nb.append(Node(x, y, 0.0))
    nt.append(Node(x, y, H))
l_seam = Line(start=nt[0].id, end=nb[0].id)
l_cb = []
l_ct = []
for i in range(N):
    j = (i + 1) % N
    l_cb.append(Line(start=nb[i].id, end=nb[j].id).id)
    l_ct.append(Line(start=nt[i].id, end=nt[j].id).id)
outer = [l_seam.id] + l_cb + [l_seam.id] + l_ct
s_cyl = Surf(outer=outer, type=SurfType.TriPatch, sid=sec_shell.id)
patches = []
for i in range(N):
    j = (i + 1) % N
    patches.append([nt[j].id, nt[i].id, nb[i].id])
    patches.append([nt[j].id, nb[i].id, nb[j].id])
s_cyl.patches = patches
Elset(name="cyl_tripatch", ids=[s_cyl.id])

# ========== 4. 几何阶段：自重工况 + 质量源 + 网格设置（均在 toViewer 之前） ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(value=9.81, dir=[0.0, 0.0, -1.0]))
LoadToMassSetting(loadToMassParas=[[lc_dl.id, 1.0]])
MeshParams(sizer=Size(isBasic=True, basicSize=MESH, beamSize=MESH,
                      wallSize=MESH, plateSize=MESH, densifyLevel=0),
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ========== 5. 混合时序：几何可视化 → 网格 → 读入有限元 ==========
StruModel.toViewer()
StruModel.submitAndMesh()
FemModel.fromViewer()                   # 内部先 clc()，几何对象与 id 作废

# ========== 6. 有限元阶段：约束 / 分析 / 任务指派（编号重取） ==========
base_nids = [n.id for n in Node.all()
             if abs(n.z) < 1.0e-6 and math.hypot(n.x, n.y) > 9.0]
Fixed(gnids=base_nids, dof=[Dof.All])

lc0 = LoadCase.all()[0]
step_dl = Step(name="Step_DL", loadCases=[LoadCaseCombine(lc0.id, 1.0)])
Analy(name="Static_DL", steps=[step_dl])
step_md = Step(name="Step_MD", loadCases=[LoadCaseCombine(lc0.id, 1.0)])
Analy(name="Modal_10", steps=[step_md],
      setting=AnalySetting(anaType=AnaType.MODAL, nModal=10))

names = [a.name for a in Analy.all()]   # ★ 索引 0 恒为默认「分析-1」，动态取
jobs = [Job(name="Job_Static", main=names.index("Static_DL")),
        Job(name="Job_Modal", main=names.index("Modal_10"))]
j = jobs[CUR_TASK]
JobManager(main=j.main, pre=j.pre, uid=j.uid, jobs=jobs)

FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点（实测值取自 2026-10-16 PkpmCAE pypcae 2.1.0） ==========
# 网格：2016 节点 / 1920 四边形壳单元；底环 96 个固接节点；
# 静力（CUR_TASK=0）：61_LoadStep.inp 步名 Step_DL（非 step-1）；
#   o62 反力 96 行，ΣRz = 967025 N（网格自重理论 ≈ 967717 N，曲面离散差 0.07%）；
#   最大位移约 7.45e-5 m；
# 模态（CUR_TASK=1）：o71 特征值 10 阶，频率 1.859/1.859/1.925/1.925/2.090/2.090/
#   2.194/2.194/2.596/2.596 Hz（成对出现 = 轴对称结构特征），无零频（约束完备）；
# ★ 存在性核对均读 genfea-compute-<最新目录>/（按 mtime + nNode/nElem 锁定），
#   不读 pcaestru-mesh/ 下的空模板 inp（#81/#103）。
