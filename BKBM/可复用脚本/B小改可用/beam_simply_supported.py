# -*- coding: utf-8 -*-
# 示例：简支梁（入门）—— FemModel 有限元模型，线性静力
# 验证基准：跨中挠度 delta = 5qL^4/(384EI)；跨中弯矩 M = qL^2/8
# 单位制：SI（m / N / Pa）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数定义 ==========
SPAN = 6.0          # m，跨度
N_ELEM = 12         # 单元数（偶数，保证跨中有节点）
Q = 10000.0         # N/m，均布荷载（LL）
B, H = 0.3, 0.6     # m，矩形截面宽×高

# ========== 2. 材料 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)

# ========== 3. 截面 ==========
sec = Section("Beam300x600", SectionType.Line, Rectangle(mid=mat.id, b=B, h=H))

# ========== 4. 节点 ==========
nods = [Node(i * SPAN / N_ELEM, 0.0, 0.0) for i in range(N_ELEM + 1)]

# ========== 5. 单元 ==========
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(N_ELEM)]

# ========== 6. 集合 ==========
Elset("AllBeams", [e.id for e in elems])

# ========== 7. 支座 ==========
Fixed(gnids=[nods[0].id], dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx])    # 固定铰
Fixed(gnids=[nods[N_ELEM].id], dof=[Dof.Uy, Dof.Uz, Dof.Phx])       # 滑动铰（释放纵向 Ux）

# ========== 8. 荷载工况 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=[e.id for e in elems], value=9.81, dir=[0, 0, -1]))  # 自重加速度：SI(m) 用 9.81；mm 制用 9810

lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=[e.id for e in elems], type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[Q], dir=[0, 0, -1]))

# ========== 9. 荷载步与分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))
analy.add(Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0)))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_ll.id, 1.0))
analy.add(step_all)

# ========== 10. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 理论验证（人工核对，勿放入脚本执行段） ==========
# I = B*H^3/12 = 0.3*0.6^3/12 = 5.4e-3 m^4
# 仅 LL：delta_mid = 5*Q*L^4/(384*E*I) = 5*1e4*6^4/(384*2.06e11*5.4e-3)
#                  ≈ 1.518e-4 m ≈ 0.152 mm
# M_mid = Q*L^2/8 = 45 kN·m；sigma = M*(H/2)/I ≈ 2.5e6 Pa = 2.5 MPa
