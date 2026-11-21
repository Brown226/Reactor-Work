# -*- coding: utf-8 -*-
# 分析类型: 谐响应分析
# 模型描述: 简支梁跨中竖向简谐激励（旋转机械类荷载），频率扫描 1~60 Hz
# 用户输入参数: SPAN=6.0(m) 跨度; F0=10000.0(N) 激励幅值
# 验证基准: 跨中位移幅值在一阶自振频率 f1 ≈ 38.7 Hz 附近出现共振峰
#   f1 = pi/(2*L^2)*sqrt(EI/(rho*A)) = pi/72*sqrt(2.06e11*0.0054/1413) ≈ 38.7 Hz
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 6.0         # m
N_ELEM = 12        # 偶数，跨中有节点
F0 = 10000.0       # N，简谐力幅值
F_MIN, F_MAX, N_PT = 1.0, 60.0, 120   # Hz，扫频范围与点数

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("Beam300x600", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.6))

# ========== 4-5. 节点与单元 ==========
nods = [Node(i * SPAN / N_ELEM, 0.0, 0.0) for i in range(N_ELEM + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(N_ELEM)]

# ========== 7. 支座 ==========
Fixed(gnids=[nods[0].id], dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx])      # 固定铰
Fixed(gnids=[nods[N_ELEM].id], dof=[Dof.Uy, Dof.Uz, Dof.Phx])         # 滑动铰

# ========== 8. 荷载工况（跨中简谐力，谐响应按幅值输入） ==========
lc_h = LoadCase("HARM")
lc_h.add(Cload(gnids=[nods[N_ELEM // 2].id], dof=[FDof.Fz], value=[-F0]))

# ========== 9. 分析（谐响应：显式频率点列表 freqArray + nFreq，构造后赋值） ==========
# 注意：minFreq/maxFreq/nPoints 构造参数对当前求解器无效（inp 标注"无用"），
#       必须显式给定激励频率点列表 freqArray 与频率点数 nFreq
freq_arr = [F_MIN + (F_MAX - F_MIN) * i / (N_PT - 1) for i in range(N_PT)]
anaSetting = AnalySetting(anaType=AnaType.HARMONIC,
                       iDampType=AnaDampType.RatioToMass, dampRatio=0.05)
anaSetting.freqArray = freq_arr
anaSetting.nFreq = N_PT
analy = Analy("Harmonic", setting=anaSetting)
analy.add(Step("Step_H").add(LoadCaseCombine(lc_h.id, 1.0)))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 幅频曲线峰值出现在 f1 ≈ 38.7 Hz 附近
# 2) 低频段（远离共振）幅值 ≈ 静力位移 F*L^3/(48EI) = 1.06e-4 m
# 3) 峰值放大倍数 ≈ 1/(2*dampRatio) = 10 倍量级
