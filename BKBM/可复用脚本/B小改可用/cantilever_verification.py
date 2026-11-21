# -*- coding: utf-8 -*-
# 示例：悬臂梁验证算例 —— 最小规模验证模型正确性的标准做法
# 验证基准：delta = P*L^3/(3EI)；sigma_max = P*L*(h/2)/I
# 单位制：SI（m / N / Pa）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
L = 1.0             # m
B, H = 0.05, 0.1    # m
P = 5000.0          # N，自由端竖向集中力
N_ELEM = 10         # 梁单元数

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("Sec50x100", SectionType.Line, Rectangle(mid=mat.id, b=B, h=H))

# ========== 4-5. 节点与单元 ==========
nods = [Node(i * L / N_ELEM, 0.0, 0.0) for i in range(N_ELEM + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(N_ELEM)]

# ========== 7. 支座：固定端 ==========
Fixed(gnids=[nods[0].id], dof=[Dof.All])

# ========== 8. 荷载 ==========
lc = LoadCase("LL")
lc.add(Cload(gnids=[nods[N_ELEM].id], dof=[FDof.Fz], value=[-P]))

# ========== 9. 分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_LL").add(LoadCaseCombine(lc.id, 1.0)))

# ========== 10. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 理论值（人工核对用） ==========
# I = 0.05*0.1^3/12 = 4.167e-6 m^4
# delta_tip = P*L^3/(3EI) = 5000/(3*2.06e11*4.167e-6) = 1.941e-3 m
# sigma_max = P*L*(H/2)/I = 5000*1*0.05/4.167e-6 = 6.0e7 Pa = 60 MPa
# 通过标准：位移误差 < 2%（10 个梁单元足够）
