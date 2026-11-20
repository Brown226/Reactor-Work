# -*- coding: utf-8 -*-
# 示例：四边简支板（壳单元）—— 面荷载 + 边界约束
# 验证：薄板弯曲理论 w_max = alpha*q*a^4/(D)，方板 alpha≈0.00406
# 单位制：SI（m / N / Pa）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
L = 4.0             # m，板边长（方形板）
T = 0.12            # m，板厚
NX = NY = 20        # 网格划分
Q = 5000.0          # N/m^2，面荷载

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
sec = Section("Slab120", SectionType.Surface, SingleLayer(mid=mat.id, t=T))

# ========== 4. 节点（网格） ==========
nods = []
for i in range(NX + 1):
    for j in range(NY + 1):
        nods.append(Node(i * L / NX, j * L / NY, 0.0))

def nid(i, j):
    return nods[i * (NY + 1) + j].id

# ========== 5. 单元（四节点壳，绕序一致保证法向统一） ==========
elems = []
for i in range(NX):
    for j in range(NY):
        elems.append(Element(nids=[nid(i, j), nid(i + 1, j), nid(i + 1, j + 1), nid(i, j + 1)],
                             type=ElementType.ShellAssembled, sid=sec.id))

# ========== 7. 支座（四边 Uz；左下角点补 Ux,Uy 防面内刚体） ==========
edge_ids = []
for i in range(NX + 1):
    edge_ids.extend([nid(i, 0), nid(i, NY)])
for j in range(1, NY):
    edge_ids.extend([nid(0, j), nid(NX, j)])
Fixed(gnids=edge_ids, dof=[Dof.Uz])
Fixed(gnids=[nid(0, 0)], dof=[Dof.Ux, Dof.Uy])

# ========== 8. 荷载 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=[e.id for e in elems], value=9.81, dir=[0, 0, -1]))  # 自重加速度：SI(m) 用 9.81；mm 制用 9810

lc_ll = LoadCase("LL")
lc_ll.add(Esload(geids=[e.id for e in elems], type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[Q], dir=[0, 0, -1]))

# ========== 9. 分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))
analy.add(Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0)))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_ll.id, 1.0))
analy.add(step_all)

# ========== 10. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 理论验证 ==========
# D = E*T^3/(12*(1-nu^2)) = 3.0e10*0.12^3/11.52 = 4.5e6 N·m
# 仅 LL：w_max ≈ 0.00406 * q * a^4 / D = 0.00406*5000*4^4/4.5e6 ≈ 1.16e-3 m
# （约 1.2 mm，L/3400 量级，薄板小变形适用，结果合理）
# 计入自重 DL 后另加 rho*g*T = 2500*9.81*0.12 ≈ 2943 N/m^2 的等效面载。
