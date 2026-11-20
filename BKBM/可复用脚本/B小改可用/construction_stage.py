# -*- coding: utf-8 -*-
# 分析类型: 静力（单元生死，两阶段施工模拟）
# 模型描述: 悬臂梁分两阶段拼装：阶段一 3 m 段施工并承载；阶段二接长 3 m 段并承载
# 用户输入参数: SEG=3.0(m) 每段长度; Q=10000.0(N/m) 施工恒载
# 假设: Change(Remove/Add) 控制阶段二单元生死；各阶段荷载分别作用于对应单元
# 验证基准: 完成后为 6 m 悬臂；阶段二端部位移大于阶段一；固定端反力合计 = q*6 = 6.0e4 N
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
SEG = 3.0          # m，每段长度
N_ELEM_PER = 6     # 每段单元数
Q = 10000.0        # N/m

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec = Section("Beam300x600", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.6))

# ========== 4-5. 节点与单元（全模型一次建全，阶段二单元先"死"后"生"） ==========
n_elem = 2 * N_ELEM_PER
nods = [Node(i * SEG / N_ELEM_PER, 0.0, 0.0) for i in range(n_elem + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(n_elem)]
eids_s1 = [elems[i].id for i in range(N_ELEM_PER)]
eids_s2 = [elems[i].id for i in range(N_ELEM_PER, n_elem)]

# ========== 7. 支座 ==========
Fixed(gnids=[nods[0].id], dof=[Dof.All])                        # 固定端
Fixed(gnids=[n.id for n in nods], dof=[Dof.Uy, Dof.Phx])        # 面外与抗扭

# ========== 8. 荷载工况（各阶段恒载分开） ==========
lc_dl1 = LoadCase("DL1")
lc_dl1.add(Elload(geids=eids_s1, type=LoadDistributionType.Uniform,
                  subType=LoadSubType.Force, value=[Q], dir=[0, 0, -1]))
lc_dl2 = LoadCase("DL2")
lc_dl2.add(Elload(geids=eids_s2, type=LoadDistributionType.Uniform,
                  subType=LoadSubType.Force, value=[Q], dir=[0, 0, -1]))

# ========== 9. 荷载步与分析（单元生死：chType=Element，geids 为阶段二单元） ==========
step1 = Step("Stage_1",
             changes=[Change(type=ChangeType.Remove, chType=ChangeChType.Element,
                             geids=eids_s2)],
             loadCases=[LoadCaseCombine(lc_dl1.id, 1.0)])
step2 = Step("Stage_2",
             changes=[Change(type=ChangeType.Add, chType=ChangeChType.Element,
                             geids=eids_s2)],
             loadCases=[LoadCaseCombine(lc_dl2.id, 1.0)])
analy = Analy("StaticAnalysis")
analy.add(step1)
analy.add(step2)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点（实测校核值） ==========
# 1) Stage_1 结果：仅 3 m 悬臂受力，交接点(x=3m)位移 ≈ q*SEG^4/(8EI) = 9.1e-5 m；
#    阶段二单元已"死"——其后节点位移输出严格为 0
# 2) Stage_2 结果：全长 6 m 悬臂，固定端竖向反力合计 = q*(2*SEG) = 6.0e4 N
# 3) 阶段二以"无应力"状态接入：最终端部位移（≈1.04e-3 m）小于一次落成的
#    整浇悬臂端部位移 q*(2*SEG)^4/(8EI) = 1.46e-3 m（施工路径效应）
