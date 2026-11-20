# -*- coding: utf-8 -*-
# 示例：平面刚架 —— 两柱一梁，柱脚固结，梁跨中集中力
# 单位制：SI（m / N / Pa）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 6.0          # m，柱距
HEIGHT = 4.0        # m，柱高
P = 20000.0         # N，梁跨中集中力

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec_col  = Section("Col400", SectionType.Line, Rectangle(mid=mat.id, b=0.4, h=0.4))
sec_beam = Section("Beam300x500", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.5))

# ========== 4. 节点（连接点共享同一 Node 对象） ==========
n_base_l = Node(0.0, 0.0, 0.0)
n_top_l  = Node(0.0, 0.0, HEIGHT)
n_mid    = Node(SPAN / 2, 0.0, HEIGHT)
n_top_r  = Node(SPAN, 0.0, HEIGHT)
n_base_r = Node(SPAN, 0.0, 0.0)

# ========== 5. 单元 ==========
e_col_l  = Element(nids=[n_base_l.id, n_top_l.id], type=ElementType.BeamEuler, sid=sec_col.id)
e_beam_l = Element(nids=[n_top_l.id, n_mid.id],   type=ElementType.BeamEuler, sid=sec_beam.id)
e_beam_r = Element(nids=[n_mid.id, n_top_r.id],   type=ElementType.BeamEuler, sid=sec_beam.id)
e_col_r  = Element(nids=[n_base_r.id, n_top_r.id], type=ElementType.BeamEuler, sid=sec_col.id)
elems = [e_col_l, e_beam_l, e_beam_r, e_col_r]

# ========== 7. 支座 ==========
Fixed(gnids=[n_base_l.id], dof=[Dof.All])
Fixed(gnids=[n_base_r.id], dof=[Dof.All])

# ========== 8. 荷载 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=[e.id for e in elems], value=9.81, dir=[0, 0, -1]))  # 自重加速度：SI(m) 用 9.81；mm 制用 9810

lc_ll = LoadCase("LL")
lc_ll.add(Cload(gnids=[n_mid.id], dof=[FDof.Fz], value=[-P]))

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

# ========== 定性验证 ==========
# 梁跨中弯矩应介于简支（PL/4=30 kN·m）与固端（PL/8=15 kN·m）之间；
# 柱脚出现水平反力（框架效应）；节点位移连续。
