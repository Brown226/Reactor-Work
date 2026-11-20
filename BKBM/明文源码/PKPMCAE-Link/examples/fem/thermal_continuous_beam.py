# -*- coding: utf-8 -*-
# 分析类型: 静力（温度 + 支座沉降）
# 模型描述: 两跨连续梁，整体升温 30℃（Etem）+ 中支座沉降 0.02 m（Cdisp），TEM/SETT/包络三步
# 用户输入参数: SPAN=6.0(m) 单跨; N_SPAN=2 跨数; DT_T=30.0(℃) 温升; SETTLE=-0.02(m) 中支座沉降
# 假设: 两端轴向约束（Ux），温度应力为轴压；材料已填 expansion
# 验证基准: 均匀温升轴力 N = -E*A*alpha*DT = -2.06e11*0.18*1.2e-5*30 = -1.335e7 N（压力）
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SPAN = 6.0         # m，单跨
N_SPAN = 2         # 跨数 → N_SPAN+1 个支座
N_ELEM_PER = 6     # 每跨单元数
DT_T = 30.0        # ℃，整体温升
SETTLE = -0.02     # m，中支座沉降（向下为负）

# ========== 2-3. 材料与截面（温度荷载必须填 expansion） ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
mat.expansion = 1.2e-5             # 温度荷载必需：显式确保热膨胀系数（库未含时此赋值兜底）
sec = Section("Beam300x600", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.6))

# ========== 4-5. 节点与单元 ==========
n_elem = N_SPAN * N_ELEM_PER
nods = [Node(i * SPAN * N_SPAN / n_elem, 0.0, 0.0) for i in range(n_elem + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(n_elem)]
all_eids = [e.id for e in elems]

# ========== 7. 支座（两支座竖向 + 两端轴向 + 抗扭） ==========
# 注意 1：中支座的竖向约束由 Cdisp（强迫位移）提供——Cdisp 不能施加在 Fixed 已约束的自由度上
# 注意 2：Etem 必须全位置传参（关键字传参会触发原生层崩溃 0xc0000409，平台校验强制）
Fixed(gnids=[nods[0].id, nods[n_elem].id], dof=[Dof.Uz, Dof.Phx])  # 边支座竖向 + 抗扭
Fixed(gnids=[nods[0].id, nods[n_elem].id], dof=[Dof.Ux, Dof.Uy])   # 两端轴向约束（温度应力来源）
Fixed(gnids=[nods[N_ELEM_PER].id], dof=[Dof.Phx])                  # 中支座仅抗扭（竖向见 Cdisp）
Fixed(gnids=[n.id for n in nods], dof=[Dof.Uy])                    # 面外约束

# ========== 8. 荷载工况（温度与沉降各自独立） ==========
lc_tem = LoadCase("TEM")
lc_tem.add(Etem(all_eids, DT_T))                               # 整梁均匀升温（位置参数！）
lc_set = LoadCase("SETT")
lc_set.add(Cdisp(gnids=[nods[N_ELEM_PER].id], dof=[Dof.Uz], value=[SETTLE]))

# ========== 9. 荷载步与分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_TEM").add(LoadCaseCombine(lc_tem.id, 1.0)))
analy.add(Step("Step_SETT").add(LoadCaseCombine(lc_set.id, 1.0)))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_tem.id, 1.0)).add(LoadCaseCombine(lc_set.id, 1.0))
analy.add(step_all)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) TEM 步：全梁轴力 N = -E*A*alpha*DT = -1.335e7 N（均匀受压，弯矩为 0）
# 2) SETT 步：中支座沉降引起负弯矩，边支座反力减小（甚至受拉）
# 3) 反力竖向合计恒为 0（无外竖向荷载）
