# -*- coding: utf-8 -*-
# 分析类型: 线性静力
# 模型描述: 矩形平板壳(6m x 4m x 0.2m, C30)，壳截面内嵌双层双向 HRB400 钢筋等效层(Phi10@150)，x=0 端固结形成悬臂板
# 用户输入参数: L=6.0(m) 板长; B=4.0(m) 板宽; T=0.2(m) 板厚; 混凝土 C30; 钢筋 HRB400 Phi10@150 双层双向; 保护层 25mm; 面活载 2.0 kN/m2
# 假设: 1) 未指定单位制，默认 m 制(SI: m/N/Pa/kg)
#       2) 钢筋层采用 smeared 等效: 双向同配筋的钢筋网等效为贴合于壳内层的薄钢板层(等效厚度=每米宽钢筋面积)
#       3) 壳截面由多个 SingleLayer 子截面分层叠加: 混凝土基层(全厚) + 上/下钢筋等效层(按保护层定位)
#       4) 边界: x=0 边全自由度固结(悬臂板); 荷载: 自重 DL + 面活载 LL, 另设 Step_ALL 包络步

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数定义 ==========
L = 6.0          # m, 板长 (x 向)
B = 4.0          # m, 板宽 (y 向)
T = 0.2          # m, 板厚
NX = 24          # x 向网格数
NY = 16          # y 向网格数
COVER = 0.025    # m, 保护层厚度
D_BAR = 0.010    # m, 钢筋直径 (Phi10)
S_BAR = 0.150    # m, 钢筋间距 (@150)
Q_LL = 2000.0    # N/m2, 面活载

# 钢筋等效层参数 (smeared rebar layer)
AS_BAR = math.pi * D_BAR ** 2 / 4.0          # m2, 单根钢筋截面积
T_REBAR = AS_BAR / S_BAR                      # m, 等效钢板层厚度 (每米宽钢筋面积)
Z_REBAR = T / 2.0 - COVER - T_REBAR / 2.0     # m, 钢筋层中心距壳中面距离

# ========== 2. 材料 ==========
MatDB.load()
setting = Setting()                           # 默认 m 制 (SI)
mat_c30 = MatDB.assemble("C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
mat_hrb400 = MatDB.assemble("HRB400", iType=MaterialType.Rebar,
                            iMark=RebarType.HRB400, setting=setting)

# ========== 3. 截面 (分层壳: 混凝土基层 + 上/下内嵌钢筋层) ==========
sec_shell = Section("RC_Shell_T200", SectionType.Surface, [
    SingleLayer(mid=mat_c30.id, t=T, offset=0.0),                                 # 混凝土基层 (全厚, 中面对齐)
    SingleLayer(mid=mat_hrb400.id, t=T_REBAR, offset=Z_REBAR,  isotropy=1),       # 上层钢筋等效层 (isotropy=1 钢筋层)
    SingleLayer(mid=mat_hrb400.id, t=T_REBAR, offset=-Z_REBAR, isotropy=1),       # 下层钢筋等效层
])

# ========== 4. 节点 ==========
nods = []
for i in range(NX + 1):
    for j in range(NY + 1):
        nods.append(Node(x=i * L / NX, y=j * B / NY, z=0.0))

# ========== 5. 单元 ==========
shell_ids = []
for i in range(NX):
    for j in range(NY):
        e = Element(nids=[nods[(NY + 1) * i + j].id,
                          nods[(NY + 1) * (i + 1) + j].id,
                          nods[(NY + 1) * (i + 1) + j + 1].id,
                          nods[(NY + 1) * i + j + 1].id],
                    type=ElementType.ShellAssembled, sid=sec_shell.id)
        shell_ids.append(e.id)

# ========== 6. 集合 ==========
Elset("ShellAll", shell_ids)
fixed_nids = [nods[j].id for j in range(NY + 1)]      # x=0 边 (i=0)
Nset("FixedEdge", fixed_nids)

# ========== 7. 支座 ==========
Fixed(gnids=fixed_nids, dof=[Dof.All])

# ========== 8. 荷载工况 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=shell_ids, value=9.81, dir=[0, 0, -1]))

lc_ll = LoadCase("LL")
lc_ll.add(Esload(geids=shell_ids, type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[Q_LL], dir=[0, 0, -1]))

# ========== 9. 荷载步与分析 ==========
step_dl = Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0))
step_ll = Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0))
step_all.add(LoadCaseCombine(lc_ll.id, 1.0))

analy = Analy("StaticAnalysis")
analy.add(step_dl)
analy.add(step_ll)
analy.add(step_all)

# ========== 10/11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
