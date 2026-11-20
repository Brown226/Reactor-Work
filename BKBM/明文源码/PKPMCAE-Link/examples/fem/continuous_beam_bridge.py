# -*- coding: utf-8 -*-
# 示例：三跨连续梁桥 —— DL(自重) + LL(车道均布) + 包络步
# 要点：N 跨 → N+1 个墩位；一端固定铰，其余竖向+横向约束（释放纵向）
# 单位制：SI（m / N / Pa）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 30.0             # m，单跨
N_SPAN = 3              # 跨数 → 4 个墩位
N_ELEM_PER_SPAN = 20    # 每跨单元数
Q_LL = 30000.0          # N/m，车道均布活载
GIRDER_AREA = 7.8       # m^2，主梁截面面积（直接给属性）
GIRDER_IX = 19.0        # m^4
GIRDER_IY = 60.0        # m^4
GIRDER_IZ = 8.0         # m^4

N_ELEM = N_SPAN * N_ELEM_PER_SPAN
TOTAL_LEN = SPAN * N_SPAN

# ========== 2-3. 材料与截面（iKey=0 直接给属性） ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("C50", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C50, setting=setting)
sec = Section("Girder", SectionType.Line,
              Arbitrary(mid=mat.id, area=GIRDER_AREA, Ix=GIRDER_IX, Iy=GIRDER_IY, Iz=GIRDER_IZ),
              iKey=0)

# ========== 4-5. 节点与单元 ==========
nods = [Node(i * TOTAL_LEN / N_ELEM, 0.0, 0.0) for i in range(N_ELEM + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(N_ELEM)]

# ========== 6. 集合 ==========
Elset("GirderAll", [e.id for e in elems])

# ========== 7. 支座（N+1=4 个墩位） ==========
pier_node_ids = [nods[k * N_ELEM_PER_SPAN].id for k in range(N_SPAN + 1)]
Fixed(gnids=[pier_node_ids[0]], dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx])   # 固定铰（梁端）
for nid in pier_node_ids[1:]:
    Fixed(gnids=[nid], dof=[Dof.Uy, Dof.Uz, Dof.Phx])                    # 释放纵向

# ========== 8. 荷载 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=[e.id for e in elems], value=9.81, dir=[0, 0, -1]))  # 自重加速度：SI(m) 用 9.81；mm 制用 9810

lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=[e.id for e in elems], type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[Q_LL], dir=[0, 0, -1]))

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

# ========== 验证要点 ==========
# 1) 反力平衡：4 个墩位竖向反力之和 ≈ (自重 + Q_LL) * TOTAL_LEN
# 2) 边跨跨中挠度大于中跨；中支点负弯矩最大
# 3) 数量自检：N_SPAN=3 → pier 4 个；N_ELEM=60 → 节点 61 个
