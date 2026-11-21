# -*- coding: utf-8 -*-
# 分析类型: 规范谱分析（抗震反应谱）
# 模型描述: 三层单跨混凝土框架，8度（0.2g 量级按默认值）多遇地震、II 类场地、一组，X 向
# 用户输入参数: SPAN=6.0(m); FLOOR_H=3.0(m); N_FLOOR=3
# 假设: 柱脚固结；阻尼比 0.05；CQC 振型组合；可不挂荷载步
# 验证基准: 基底剪力与顶点位移非零且量级合理；模态质量参与系数达标
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 6.0          # m
FLOOR_H = 3.0       # m
N_FLOOR = 3         # 层数 → N_FLOOR+1 层节点
N_MODE = 15         # 谱分析振型数

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
sec_col  = Section("Col500", SectionType.Line, Rectangle(mid=mat.id, b=0.5, h=0.5))
sec_beam = Section("Beam300x600", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.6))

# ========== 4. 节点（4 柱 × (N_FLOOR+1) 层） ==========
base_xy = [(0.0, 0.0), (SPAN, 0.0), (SPAN, SPAN), (0.0, SPAN)]
nods = []
for iz in range(N_FLOOR + 1):
    for (x, y) in base_xy:
        nods.append(Node(x, y, iz * FLOOR_H))
NP = len(base_xy)

# ========== 5. 单元 ==========
elems = []
for iz in range(N_FLOOR):                    # 柱
    for ip in range(NP):
        elems.append(Element(nids=[nods[iz * NP + ip].id, nods[(iz + 1) * NP + ip].id],
                             type=ElementType.BeamEuler, sid=sec_col.id, normal=[0, 1, 0]))
for iz in range(1, N_FLOOR + 1):             # 各层环梁（法向不得与杆轴平行：X 向梁 [0,1,0]，Y 向梁 [1,0,0]）
    for ip in range(NP):
        elems.append(Element(nids=[nods[iz * NP + ip].id, nods[iz * NP + (ip + 1) % NP].id],
                             type=ElementType.BeamEuler, sid=sec_beam.id,
                             normal=[0, 1, 0] if ip % 2 == 0 else [1, 0, 0]))

# ========== 7. 支座 ==========
Fixed(gnids=[nods[ip].id for ip in range(NP)], dof=[Dof.All])

# ========== 8. 荷载工况（谱分析忽略自重，但本版本求解器要求至少一个加载步） ==========
all_eids = [e.id for e in elems]
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_eids, value=9.81, dir=[0, 0, -1]))

# ========== 9. 分析（规范谱：烈度/场地/分组必配） ==========
analy = Analy("SpectrumX", setting=AnalySetting(
    anaType=AnaType.SPECTRUM, iType=SpectrumAnaMethod.Code,
    intensity=SeismicIntensity.Eight, seismicLevel=SeismicLevel.Frequent,
    siteType=SiteClass.Class2, iGroup=DesignEarthquakeGroup.Group1,
    iCombine=ModalCombine.CQC, nModalSpectrum=N_MODE,
    iDampType=AnaDampType.RatioToMass, dampRatio=0.05,
    direction=[1.0, 0, 0]))
analy.add(Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) X 向基底剪力非零；振型组合采用 CQC
# 2) 顶点位移为 mm ~ cm 量级（多遇地震弹性）
# 3) 累计质量参与系数应 ≥ 90%（不足时增大 nModalSpectrum）
# 4) 层间位移沿高度下大上小
