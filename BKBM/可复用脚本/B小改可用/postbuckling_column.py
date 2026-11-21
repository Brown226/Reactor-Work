# -*- coding: utf-8 -*-
# 分析类型: 极限承载力分析（POSTBUCK，几何非线性弧长类）
# 模型描述: 悬臂压柱（轴压 + 微小侧向扰动力），追踪荷载-位移全过程
# 用户输入参数: H=3.0(m) 柱高; P_AX=1.0e6(N) 参考轴压; P_LAT=1.0e4(N) 侧向扰动
# 假设: 侧向扰动力取轴压 1% 模拟初始缺陷；位移控制系数上限 2.0
# 验证基准: 弹性欧拉临界力 Pcr = pi^2*E*I/(4*H^2) ≈ 7.53e6 N；
#   极限荷载系数 < Pcr/P_AX = 7.53（缺陷敏感，提前达到极限点）
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
H = 3.0            # m
B_SEC = 0.2        # m，方截面
P_AX = 1.0e6       # N，参考轴压
P_LAT = 1.0e4      # N，侧向扰动力（1% 轴压）
N_ELEM = 10

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("Sec200", SectionType.Line, Rectangle(mid=mat.id, b=B_SEC, h=B_SEC))

# ========== 4-5. 节点与单元（柱沿 Z 轴） ==========
nods = [Node(0.0, 0.0, i * H / N_ELEM) for i in range(N_ELEM + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id, normal=[0, 1, 0])
         for i in range(N_ELEM)]

# ========== 7. 支座 ==========
Fixed(gnids=[nods[0].id], dof=[Dof.All])

# ========== 8. 荷载工况（轴压 + 侧向扰动分置） ==========
lc_ax = LoadCase("AXIAL")
lc_ax.add(Cload(gnids=[nods[N_ELEM].id], dof=[FDof.Fz], value=[-P_AX]))
lc_lat = LoadCase("LAT")
lc_lat.add(Cload(gnids=[nods[N_ELEM].id], dof=[FDof.Fx], value=[P_LAT]))

# ========== 9. 分析（极限承载：maxLoadCoef/dLamRef/iDispKey/maxDispCoef 必配） ==========
step = Step("Step_PUSH")
step.add(LoadCaseCombine(lc_ax.id, 1.0)).add(LoadCaseCombine(lc_lat.id, 1.0))
analy = Analy("PostBuck", setting=AnalySetting(
    anaType=AnaType.POSTBUCK, iNLType=NLType.GeoNonlinear,
    maxLoadCoef=10.0, dLamRef=0.1,
    iDispKey=LimitDispControl.DispCoef, maxDispCoef=2.0))
analy.add(step)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 荷载系数-位移曲线斜率逐渐降低（几何非线性软化）
# 2) 达到极限荷载系数后曲线下降或按位移控制终止（maxDispCoef=2.0）
# 3) 极限荷载系数应小于弹性屈曲值 Pcr/P_AX ≈ 7.53（含缺陷）
