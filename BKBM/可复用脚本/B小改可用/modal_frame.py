# -*- coding: utf-8 -*-
# 示例：三层框架模态分析 —— AnalySetting(anaType=MODAL, nModal=...)
# 验证：一阶频率量级 f1 ≈ (1.8751)^2/(2*pi)*sqrt(EI/(rho*A*L^4))（悬臂估算）
# 单位制：SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 6.0          # m
FLOOR_H = 3.0       # m
N_FLOOR = 3         # 层数 → N+1 层节点
N_MODAL = 10        # 待求特征值个数

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
NP = len(base_xy)   # 每层 4 节点

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

# ========== 9. 分析（模态：必须 setting + nModal） ==========
analy = Analy("ModalAnalysis",
              setting=AnalySetting(anaType=AnaType.MODAL, nModal=N_MODAL))

# ========== 10. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 前 6 阶不应出现 ≈0 频率（柱脚已固结，无刚体模态）
# 2) 一阶为整体侧移振型；频率量级与悬臂估算式一致
# 3) 谱分析时检查累计质量参与系数 ≥ 90%
