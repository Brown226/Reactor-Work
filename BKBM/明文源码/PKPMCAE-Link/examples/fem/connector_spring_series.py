# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：连接器（Connector）弹簧串联传力 —— 「连接器为唯一传力路径」最小验证模型
# 实测环境：PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0（last release 20261230）
# 实测日期：2026-10-15
# ----------------------------------------------------------------------------
# ★ 本示例的意义：推翻 ERRATA 原「Connector/ConnectorSection 暂不可用（sep-modelcheck 崩溃
#   0xc0000409）」的记载（现 #119）。受荷节点 n3 不挂任何单元 ⇒ 荷载 100% 经连接器传递，
#   因此「连接器内力 = 施加荷载」是"连接器确实参与总刚组装并传力"的**最硬判据**，
#   可排除"写了不报错但不起作用"这类静默失效。
# ----------------------------------------------------------------------------
# 模型：n1(0,0,0) 全固定 ─ e1(Link, Φ100 Q345) ─ n2(1,0,0)
#                ══[Connector: Ux, k=1.0e6 N/m, Auto 坐标系]══ n3(2,0,0) ← 无任何单元
#       n2/n3 约束 Uy、Uz（只放开 Ux）；荷载 LL：n3 上 Fx = 1000 N
# 传力路径（唯一，串联）：n3 → 连接器 → n2 → 杆 e1 → n1(固定)
#   k_bar  = EA/L = 2.06e11 × 7.853982e-3 / 1 ≈ 1.61792e9 N/m
#   k_conn = 1.0e6 N/m
#   k_total = 1/(1/k_conn + 1/k_bar) ≈ 999382 N/m
# ----------------------------------------------------------------------------
# 实测结果（2026-10-15，与理论解对照）：
#   模型检查   ModelCheckResult.json = {"error":{},"warning":{}}
#   求解       nNode:3 / nElem:1 / neq:2，2 个荷载步正常结束
#   连接器内力 o63_ConnectForce.out = ±1000 N（理论 1000 N，偏差 +0.0000%）★ 等于全部荷载
#   ux(n3)     o11_NodeDisp.out = 1.00062e-3 m（理论 1.000618e-3，偏差 +0.0002%）
#   ux(n2)     o11_NodeDisp.out = 6.18078e-7 m（理论 6.180774e-7，偏差 +0.0001%）
#   支座反力   o62_ReactionForce.out：n1 Rx = -1000 N ⇒ ΣFx = 0 平衡
#   落盘证据   19_ConnectSect.inp / 19_ConnectElem.inp（*connectElem 1 → 1 0 2 3 1 0）
# ----------------------------------------------------------------------------
# 验证要点（存在性核对）：
#   ① sep-modelcheck 不再 0xc0000409；② ModelCheckResult 无 error；③ 求解正常结束；
#   ④ o63_ConnectForce.out 存在、非空，内力 = 施加荷载（不是 0）；
#   ⑤ ux(n3) 与串联通刚度理论解同量级
# 三条硬约束（违反即失败，ERRATA #119/#120）：
#   · 模型至少要有一个单元 —— 零单元模型会在 genfea 报 readElemLoadInfo出错:*elemLoad:-1
#     （前兆信号：modelcheck 报「模型未定义截面/材料」，别误判成材料截面写错）
#   · 两端节点的其余自由度要有约束兜住（本例只放开 Ux）
#   · consElas 必须填实际刚度（填 0 = 无刚度，静默无效）
# ⚠️ 未验证路径：非线性本构 / 阻尼·摩擦·失效·阻止开关 / Rotation 转动连接器 /
#    iCoord=Fixed|Follow + vx,vy 局部系 / 动力分析下的连接器 —— 用前先小模型试
# ============================================================================
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
K_CONN = 1.0e6              # N/m，连接器线刚度
FX     = 1000.0             # N，  节点水平荷载
L_BAR  = 1.0                # m，  杆单元长度
D_BAR  = 0.100              # m，  杆截面直径 Φ100
ANALY_NAME = "Analy_ConnC"

# ========== 2. 材料 / 截面（★ Section 用 type=，MatDB.assemble 用 iType=） ==========
setting = Setting()
MatDB.load()
mat = MatDB.assemble("Q345", iType=MaterialType.Steel, iMark=SteelType.Q345, setting=setting)
sec = Section(name="BarCircle", type=SectionType.Line, sub=[Circle(mat.id, D_BAR)])

# ========== 3. 节点 ==========
n1 = Node(0.0,       0.0, 0.0)
n2 = Node(L_BAR,     0.0, 0.0)
n3 = Node(2.0*L_BAR, 0.0, 0.0)      # ★ 该节点不挂任何单元，只靠连接器传力

# ========== 4. 单元（仅 1 根杆：n1-n2） ==========
e1 = Element(nids=[n1.id, n2.id], type=ElementType.Link, sid=sec.id)

# ========== 5. 连接器截面 + 连接器（n2 → n3） ==========
csec = ConnectorSection(name="ConnSpr_Ux",
                        iType=ConnSectType.Translation,
                        keyStiff=ConnStiffType.Linear,
                        consElas=K_CONN,
                        keyDamp=ConnDampType.Off,
                        keyFriction=ConnFrictionType.Off,
                        keyFail=ConnFailType.Off,
                        keyLock=ConnLockType.Off)
conn = Connector(start=n2.id, end=n3.id,
                 iDofs=[Dof.Ux], iSects=[csec.id],
                 iCoord=ConnCoordType.Auto)

# ========== 6. 约束 ==========
Fixed(gnids=[n1.id], dof=[Dof.All])
Fixed(gnids=[n2.id, n3.id], dof=[Dof.Uy, Dof.Uz])     # 只放开 Ux

# ========== 7. 荷载工况 ==========
lc_ll = LoadCase(name="LL")
lc_ll.add(Cload(gnids=[n3.id], dof=[FDof.Fx], value=FX))

# ========== 8. 荷载步 → 分析 ==========
step_ll = Step(name="Step_LL")
step_ll.add(LoadCaseCombine(lc_ll.id, 1.0))
step_all = Step(name="Step_ALL")
step_all.add(LoadCaseCombine(lc_ll.id, 1.0))
analy = Analy(name=ANALY_NAME)
analy.add(step_ll)
analy.add(step_all)

# ========== 9. 任务指派 ==========
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)
job = Job(name="Job_ConnC", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 10. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
