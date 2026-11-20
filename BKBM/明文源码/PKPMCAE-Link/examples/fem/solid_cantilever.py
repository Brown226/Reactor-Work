# -*- coding: utf-8 -*-
# 分析类型: 静力
# 模型描述: 实体（Solid 8 节点六面体）悬臂梁；两段网格界面 Binding 绑定，端部 Coupling 参考点加载
# 用户输入参数: L=1.0(m) 全长; W=0.1(m) 截面宽; H=0.1(m) 截面高; P=10000.0(N) 端部集中力
# 假设: 两段独立网格在 x=0.5 界面重合节点处 Binding(NodeToNode) 绑定；
#       端截面 4 节点刚性耦合到参考点 RP，集中力作用于 RP（避免单点应力奇异）
# 验证基准: 端部挠度 delta = P*L^3/(3*E*I) = 1.94e-3 m（I = W*H^3/12 = 8.333e-6 m^4）
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
L = 1.0            # m
W, H = 0.1, 0.1    # m
P = 10000.0        # N
NX_SEG = 5         # 每段沿 x 单元数（两段共 10 个）

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("SolidSec", SectionType.Solid, SolidSect(mid=mat.id))

# ========== 4-5. 两段独立网格（界面 x=0.5 节点各自独立，测试 Binding） ==========
# grid[ix][iy][iz]，ix: 0..NX_SEG，iy/iz: 0..1；单元节点序：底面 4 点 + 顶面 4 点
def build_block(x0, x1):
    grid = []
    for ix in range(NX_SEG + 1):
        col = []
        for iy in range(2):
            col.append([Node(x0 + (x1 - x0) * ix / NX_SEG, W * iy, H * iz) for iz in range(2)])
        grid.append(col)
    es = []
    for ix in range(NX_SEG):
        n = [grid[ix][0][0], grid[ix + 1][0][0], grid[ix + 1][1][0], grid[ix][1][0],
             grid[ix][0][1], grid[ix + 1][0][1], grid[ix + 1][1][1], grid[ix][1][1]]
        es.append(Element(nids=[p.id for p in n], type=ElementType.Solid, sid=sec.id))
    return grid, es

grid_a, elems_a = build_block(0.0, L / 2)     # 固定段
grid_b, elems_b = build_block(L / 2, L)       # 自由段

# ========== 6. 集合 ==========
face_a = [grid_a[NX_SEG][iy][iz].id for iy in range(2) for iz in range(2)]  # A 界面节点
face_b = [grid_b[0][iy][iz].id for iy in range(2) for iz in range(2)]       # B 界面节点
end_b = [grid_b[NX_SEG][iy][iz].id for iy in range(2) for iz in range(2)]   # B 端截面节点
Nset("FaceA", face_a)
Nset("FaceB", face_b)
Nset("EndB", end_b)

# ========== 7. 支座与相互作用 ==========
Fixed(gnids=[grid_a[0][iy][iz].id for iy in range(2) for iz in range(2)], dof=[Dof.All])
Binding(tarNodes=face_a, srcNodes=face_b,
        type=BindingType.NodeToNode, iKey=DofMode.Both)          # 界面绑定
rp = Node(L, W / 2, H / 2)                                       # 端面参考点
Coupling(tarNode=rp.id, srcNodes=end_b,
         type=CouplingType.Rigid, iKey=DofMode.Both)             # 端面刚耦合

# ========== 8. 荷载工况（集中力施加在参考点） ==========
lc = LoadCase("LL")
lc.add(Cload(gnids=[rp.id], dof=[FDof.Fz], value=[-P]))

# ========== 9. 荷载步与分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_LL").add(LoadCaseCombine(lc.id, 1.0)))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) RP 竖向位移 ≈ P*L^3/(3*E*I) = 1.94e-3 m（实体三维效应允许 ~10% 偏差）
# 2) 绑定界面两侧位移连续（界面处位移差 ≈ 0）
# 3) 固定端反力合计 = P = 10000 N，力矩平衡 M = P*L
