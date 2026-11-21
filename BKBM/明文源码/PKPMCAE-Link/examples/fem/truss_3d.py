# -*- coding: utf-8 -*-
# 分析类型: 静力
# 模型描述: 平面 Warren 桁架（Link 杆单元），自重 + 上弦集中活载，DL/LL/包络三步
# 用户输入参数: SPAN=12.0(m) 跨度; N_PANEL=4 节间数; H_TRUSS=2.0(m) 桁高; D_ROD=0.1(m) 杆件直径; P_TOP=20000.0(N) 上弦节点活载
# 假设: 桁架位于 XZ 平面，全部节点约束面外自由度 Uy；杆件两端铰接仅传轴力
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 12.0        # m
N_PANEL = 4        # 节间数 → 下弦 N_PANEL+1 个节点
H_TRUSS = 2.0      # m
D_ROD = 0.1        # m，圆截面直径
P_TOP = 20000.0    # N，上弦节点竖向活载

# ========== 2. 材料 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)

# ========== 3. 截面 ==========
sec = Section("RodD100", SectionType.Line, Circle(mid=mat.id, d=D_ROD))

# ========== 4. 节点 ==========
# nb[i]: 下弦节点 i（0..N_PANEL）；nt[i]: 上弦节点 i（0..N_PANEL-1），位于节间中点上方
nb = [Node(i * SPAN / N_PANEL, 0.0, 0.0) for i in range(N_PANEL + 1)]
nt = [Node((i + 0.5) * SPAN / N_PANEL, 0.0, H_TRUSS) for i in range(N_PANEL)]

# ========== 5. 单元（Link 杆单元，仅轴力） ==========
elems = []
for i in range(N_PANEL):        # 下弦杆
    elems.append(Element(nids=[nb[i].id, nb[i + 1].id], type=ElementType.Link, sid=sec.id))
for i in range(N_PANEL - 1):    # 上弦杆
    elems.append(Element(nids=[nt[i].id, nt[i + 1].id], type=ElementType.Link, sid=sec.id))
for i in range(N_PANEL):        # 腹杆（Warren 斜杆）
    elems.append(Element(nids=[nb[i].id, nt[i].id], type=ElementType.Link, sid=sec.id))
    elems.append(Element(nids=[nt[i].id, nb[i + 1].id], type=ElementType.Link, sid=sec.id))

# ========== 6. 集合 ==========
all_nids = [n.id for n in nb] + [n.id for n in nt]
all_eids = [e.id for e in elems]
Elset("AllRods", all_eids)

# ========== 7. 支座 ==========
Fixed(gnids=[nb[0].id], dof=[Dof.Ux, Dof.Uz])        # 左端固定铰
Fixed(gnids=[nb[N_PANEL].id], dof=[Dof.Uz])          # 右端滑动铰（释放 Ux）
Fixed(gnids=all_nids, dof=[Dof.Uy])                  # 全部节点面外约束

# ========== 8. 荷载工况 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_eids, value=9.81, dir=[0, 0, -1]))          # 自重
lc_ll = LoadCase("LL")
lc_ll.add(Cload(gnids=[n.id for n in nt], dof=[FDof.Fz], value=[-P_TOP]))

# ========== 9. 荷载步与分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))
analy.add(Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0)))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_ll.id, 1.0))
analy.add(step_all)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 竖向反力合计 = 自重（9.81*7850*pi*d^2/4*杆总长） + N_PANEL*P_TOP = 自重 + 80000 N
# 2) 下弦受拉、上弦受压，端节间斜杆内力最大
# 3) 静定结构：m=15 杆 + r=3 反力 = 2j=18，无机构
