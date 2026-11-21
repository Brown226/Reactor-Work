# -*- coding: utf-8 -*-
# 分析类型: 线性静力
# 模型描述: 圆柱筒仓壳（C30 混凝土壳 + 内层 HRB400 钢筋层，分层壳截面实现）
# 用户输入参数: R=5.0(m) 半径; H=6.0(m) 筒高; T_WALL=0.20(m) 壳厚;
#              内层钢筋 phi10@150 双向, 保护层 30mm; 水深 6.0m
# 假设: 底部固结; 壳单元法向统一径向朝外; 内层钢筋层位于法向负侧(offset<0, isotropy=1);
#      双向等配筋 -> 钢筋层按各向同性等效层 t_eq=As/s; 贮水静水压力作用于壳内壁(Face2)

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数定义（SI: m / N / Pa） ==========
R = 5.0                    # m, 筒仓半径
H = 6.0                    # m, 筒壁高度
T_WALL = 0.20              # m, 混凝土壳厚度
N_CIRC = 48                # 圆周等分数
N_H = 12                   # 高度等分数
C_COVER = 0.030            # m, 内层钢筋保护层厚度
D_BAR = 0.010              # m, 钢筋直径 (phi10)
S_BAR = 0.150              # m, 钢筋间距 (@150)
GAMMA_W = 10000.0          # N/m^3, 水重度
H_WATER = 6.0              # m, 水深(满水)

T_REBAR = math.pi * D_BAR**2 / 4.0 / S_BAR   # m, 钢筋层等效厚度 As/s=523.6mm^2/m
OFFSET_REBAR = -(T_WALL / 2.0 - C_COVER)     # m, 内层钢筋层中心偏心(法向负侧=-0.07)

# ========== 2. 材料（标准牌号一律查材料库） ==========
MatDB.load()
setting = Setting()        # 默认 m 制 (SI)
mat_c30 = MatDB.assemble(name="C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
mat_rebar = MatDB.assemble(name="HRB400", iType=MaterialType.Rebar,
                           iMark=RebarType.HRB400, setting=setting)

# ========== 3. 截面（分层壳: 混凝土层 + 内层钢筋层） ==========
sec_wall = Section("RCWall200_InnerRebar", SectionType.Surface, [
    SingleLayer(mid=mat_c30.id, t=T_WALL, offset=0.0),                        # 混凝土主层
    SingleLayer(mid=mat_rebar.id, t=T_REBAR, offset=OFFSET_REBAR, isotropy=1),  # 内层钢筋层（isotropy=1 钢筋层）
])

# ========== 4. 节点（圆柱面参数化网格） ==========
# 索引规则: nidx(i,j) = j*N_CIRC + i%N_CIRC; i=圆周向, j=高度向
nods = []
for j in range(N_H + 1):
    zj = j * H / N_H
    for i in range(N_CIRC):
        th = 2.0 * math.pi * i / N_CIRC
        nods.append(Node(R * math.cos(th), R * math.sin(th), zj))

def nidx(i, j):
    return j * N_CIRC + (i % N_CIRC)

# ========== 5. 单元（绕序统一 -> 法向径向朝外） ==========
elems = []
for j in range(N_H):
    for i in range(N_CIRC):
        n1 = nods[nidx(i, j)]
        n2 = nods[nidx(i + 1, j)]
        n3 = nods[nidx(i + 1, j + 1)]
        n4 = nods[nidx(i, j + 1)]
        elems.append(Element(nids=[n1.id, n2.id, n3.id, n4.id],
                             type=ElementType.ShellAssembled, sid=sec_wall.id))

# ========== 6. 集合 ==========
Elset("WallShells", [e.id for e in elems])

# ========== 7. 支座（筒底固结） ==========
Fixed(gnids=[nods[nidx(i, 0)].id for i in range(N_CIRC)], dof=[Dof.All])

# ========== 8. 荷载工况 ==========
all_eids = [e.id for e in elems]
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_eids, value=9.81, dir=[0, 0, -1]))

lc_ll = LoadCase("LL")
# 贮水静水压力: 作用于壳内壁面(Face2, 法向负侧), 筒底参考点压力 = GAMMA_W*H_WATER
lc_ll.add(Wpload(esides=[(e.id, 2) for e in elems],
                 type=WaterPressureType.ShellSurface,
                 value=GAMMA_W * H_WATER, h0=H_WATER, h=0.0))

# ========== 9. 荷载步与分析（线性静力） ==========
step_dl = Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0))
step_ll = Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_ll.id, 1.0))

analy = Analy("StaticAnalysis")
analy.add(step_dl)
analy.add(step_ll)
analy.add(step_all)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
