# -*- coding: utf-8 -*-
# 分析类型: 静力
# 模型描述: 悬臂挡水墙（壳单元）承受静水压力（Wpload），三角形分布水压
# 用户输入参数: WIDTH=4.0(m) 墙宽; H_WATER=3.0(m) 水深; THK=0.2(m) 墙厚
# 假设: 底部固结；水压力参考点取墙底（h=0），水面坐标 h0=3.0，墙底参考压力 rho*g*H = 29430 Pa
# 验证基准: 墙面总水压力 = 0.5*rho*g*H^2*B = 0.5*9810*9*4 = 1.766e5 N（底部反力水平分量）
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
WIDTH = 4.0        # m，墙宽（X 向）
H_WATER = 3.0      # m，水深（Z 向）
THK = 0.2          # m，墙厚
NX, NZ = 8, 6      # 网格划分
RHO_G = 9810.0     # N/m^3，水容重

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
sec = Section("Wall200", SectionType.Surface, SingleLayer(mid=mat.id, t=THK))

# ========== 4. 节点（墙面位于 XZ 平面，法向 ±Y） ==========
# nods[iz*(NX+1)+ix]，ix: 0..NX，iz: 0..NZ
nods = []
for iz in range(NZ + 1):
    for ix in range(NX + 1):
        nods.append(Node(WIDTH * ix / NX, 0.0, H_WATER * iz / NZ))

# ========== 5. 单元（ShellAssembled，绕序一致 → 法向统一为 +Y） ==========
elems = []
for iz in range(NZ):
    for ix in range(NX):
        n1 = nods[iz * (NX + 1) + ix]
        n2 = nods[iz * (NX + 1) + ix + 1]
        n3 = nods[(iz + 1) * (NX + 1) + ix + 1]
        n4 = nods[(iz + 1) * (NX + 1) + ix]
        elems.append(Element(nids=[n1.id, n2.id, n3.id, n4.id],
                             type=ElementType.ShellAssembled, sid=sec.id))

# ========== 7. 支座（底部固结） ==========
Fixed(gnids=[nods[ix].id for ix in range(NX + 1)], dof=[Dof.All])

# ========== 8. 荷载工况（静水压力：value 为参考点水压力，h0 水面坐标，h 参考点坐标） ==========
lc_wp = LoadCase("WP")
lc_wp.add(Wpload(esides=[(e.id, 1) for e in elems],
                 type=WaterPressureType.ShellSurface,
                 value=RHO_G * H_WATER, h0=H_WATER, h=0.0))

# ========== 9. 荷载步与分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_WP").add(LoadCaseCombine(lc_wp.id, 1.0)))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 底部 Y 向反力合计 ≈ 0.5*rho*g*H^2*B = 1.766e5 N（三角形水压力合力）
# 2) 底部反力矩 ≈ 合力 × H/3 = 1.766e5 × 1.0 = 1.766e5 N·m（合力作用点距底 H/3）
# 3) 墙面位移沿高度向上增大，最大值在墙顶
