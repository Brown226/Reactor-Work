# -*- coding: utf-8 -*-
# 分析类型: 隐式动力（时程分析）
# 模型描述: 顶部带集中质量的悬臂柱，基底正弦脉冲加速度输入
# 用户输入参数: H=3.0(m) 柱高; M_TOP=1000.0(kg) 顶部质量; A_PEAK=2.0(m/s^2) 加速度峰值
# 假设: 半周正弦脉冲持时 0.5 s，总时长 2.0 s；阻尼比 0.05（转质量阻尼）
# 验证基准: 顶部响应先随脉冲放大、脉冲结束后衰减（阻尼）；一阶频率约 8.8 Hz
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数 ==========
H = 3.0            # m
B_SEC = 0.2        # m，方截面边长
M_TOP = 1000.0     # kg，顶部集中质量
A_PEAK = 2.0       # m/s^2，基底加速度峰值
T_PULSE = 0.5      # s，脉冲持时（半周正弦）
S_TIME = 2.0       # s，总计算时长
STEP_LEN = 0.005   # s，积分步长
N_ELEM = 10
DT = 0.01          # s，波曲线采样间隔

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("Sec200", SectionType.Line, Rectangle(mid=mat.id, b=B_SEC, h=B_SEC))

# ========== 4. 节点（柱沿 Z 轴） ==========
nods = [Node(0.0, 0.0, i * H / N_ELEM) for i in range(N_ELEM + 1)]

# ========== 5. 单元 ==========
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id, normal=[0, 1, 0])
         for i in range(N_ELEM)]

# ========== 6. 模型修正（顶部集中质量） ==========
NodeMass(gnids=[nods[N_ELEM].id], mass=M_TOP)

# ========== 7. 支座 ==========
Fixed(gnids=[nods[0].id], dof=[Dof.All])

# ========== 8. 荷载工况（动力波：timeHist 第二列归一化，幅值由 value 缩放） ==========
npt = int(S_TIME / DT) + 1
time_hist = [[round(i * DT, 6),
              math.sin(math.pi * i * DT / T_PULSE) if i * DT <= T_PULSE else 0.0]
             for i in range(npt)]
lc_eq = LoadCase("EQ")
lc_eq.add(Wload(gnids=[nods[0].id], wType=WaveType.Acceleration,
                iType=WaveActionType.Boundary,
                value=A_PEAK, timeHist=time_hist, dir=[1, 0, 0]))

# ========== 9. 分析（隐式动力：sTime/stepLen 三处自洽） ==========
st = Step("Seismic")
st.add(LoadCaseCombine(lc_eq.id, 1.0))
st.sTime = S_TIME                        # 该步时长：构造后赋值
st.nSubstep = int(S_TIME / STEP_LEN)     # = sTime/stepLen

analy = Analy("TimeHist", setting=AnalySetting(
    anaType=AnaType.IMPLICIT, iType=ImpAnaMethod.Direct,
    sTime=S_TIME, stepLen=STEP_LEN,
    iDampType=AnaDampType.RatioToMass, dampRatio=0.05))
analy.add(st)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 顶部位移时程：0.5 s 内受迫振动，之后自由衰减（阻尼比 0.05）
# 2) 响应主频接近 f1 = (1/2pi)*sqrt(3EI/(M*H^3)) ≈ 8.8 Hz
# 3) 峰值位移大于等效静力位移（动力放大效应）
