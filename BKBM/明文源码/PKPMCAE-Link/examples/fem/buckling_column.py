# -*- coding: utf-8 -*-
# 分析类型: 屈曲（线性特征值屈曲）
# 模型描述: 两端铰接压杆，轴向单位荷载下的屈曲荷载系数
# 用户输入参数: L=3.0(m) 柱高; B=0.05(m) 截面宽; H=0.1(m) 截面高; P_REF=1000.0(N) 参考轴力
# 假设: 柱沿 Z 轴，两端约束侧向平动；底部约束扭转自由度 Phz 消除扭转刚体模态
# 验证基准: Pcr = pi^2*E*Imin/L^2 = 235.3 kN → 一阶荷载系数 ≈ 235.3（P_REF=1000 N）
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
L = 3.0            # m
B, H = 0.05, 0.1   # m，矩形截面 b×h（弱轴惯性矩 Imin = h*b^3/12 = 1.0417e-6 m^4）
P_REF = 1000.0     # N，参考轴压力（屈曲荷载 = 荷载系数 × P_REF）
N_ELEM = 10

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("Sec50x100", SectionType.Line, Rectangle(mid=mat.id, b=B, h=H))

# ========== 4. 节点（柱沿 Z 轴） ==========
nods = [Node(0.0, 0.0, i * L / N_ELEM) for i in range(N_ELEM + 1)]

# ========== 5. 单元 ==========
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id, normal=[0, 1, 0])
         for i in range(N_ELEM)]

# ========== 7. 支座（两端铰接） ==========
Fixed(gnids=[nods[0].id], dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phz])   # 底部：平动+扭转约束
Fixed(gnids=[nods[N_ELEM].id], dof=[Dof.Ux, Dof.Uy])               # 顶部：仅侧向约束（轴向滑动）

# ========== 8. 荷载工况 ==========
lc_ax = LoadCase("AXIAL")
lc_ax.add(Cload(gnids=[nods[N_ELEM].id], dof=[FDof.Fz], value=[-P_REF]))

# ========== 9. 分析（屈曲：nModal 必配） ==========
analy = Analy("BucklingAnalysis",
              setting=AnalySetting(anaType=AnaType.BUCKLING, nModal=3, iNLType=NLType.ALinear))
analy.add(Step("Step_AX").add(LoadCaseCombine(lc_ax.id, 1.0)))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 一阶屈曲荷载系数 lambda1 ≈ pi^2*E*Imin/L^2/P_REF
#    = 9.8696*2.06e11*1.0417e-6/9/1000 ≈ 235.3
# 2) 一阶振型为绕弱轴的半波正弦弯曲
# 3) 二阶荷载系数约为绕强轴屈曲，远大于一阶
