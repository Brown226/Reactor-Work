# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：连接器（Connector）· 混合路线 —— 几何 → 自动网格 → 有限元 → 连接器 → 求解
# 实测环境：PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0（last release 20261230）
# 实测日期：2026-10-15
# ----------------------------------------------------------------------------
# ★ 本示例印证的两件事：
#   ① 连接器可用（推翻原 ERRATA「sep-modelcheck 崩溃 0xc0000409」的旧记载，现 #115）；
#   ② ★ 混合路线用连接器的正确姿势 —— Connector 只认「节点号」，而 FemModel.fromViewer()
#      内部先 clc() 使几何阶段编号全部作废，且网格会新增节点（编号不可预知）
#      ⇒ 连接器必须写在 fromViewer() 之后，并用 Node.all() 按坐标重筛节点号。
# ----------------------------------------------------------------------------
# 模型：两根 C30 矩形截面杆（0.1×0.1 m，各长 1.0 m）沿 X 向串联；两段在 x=1.0 处
#       刻意使用「同坐标独立节点」（不共享 Node），靠 Connector(Ux, k=1.0e6 N/m) 连接；
#       左端全固定，右端约束 Uy/Uz/Phx（只放开 Ux），右端施加 Fx = 1000 N（工况 LL）。
# 传力路径（唯一，串联）：右端 → 杆B → 连接器 → 杆A → 左端固定
# ----------------------------------------------------------------------------
# 实测结果（2026-10-15）：
#   几何/网格   10 节点 / 8 单元（每段杆 4 个梁单元）
#   模型检查    ModelCheckResult.json = {"error":{},"warning":{}}
#   求解        nNode:10 / nElem:8 / neq:47，2 个荷载步正常结束
#   连接器内力  o63_ConnectForce.out = ±1000 N（★ 等于全部施加荷载 ⇒ 确实参与传力）
#   落盘证据    19_ConnectElem.inp → *connectElem 1 / "1 0 2 3 1 0"（iNum=1, iType=0 标准连接,
#               iNodes=2,3, mDof=1, iCoord=0 总体系）/ iDofs=1(Ux) / iSects=1
# ----------------------------------------------------------------------------
# ★★ 本示例踩到并已修复的坑（重要，见 ERRATA #115 与 supports.md）：
#   首版右端只约束 [Uy, Uz] → genfea 报「主对角元为零（zero pivot）/ Pardiso:矩阵分解有错 /
#   **Error:solveLinearEquaOne出错」。用 neq 差值核账法定位：nNode×6 − neq = 60 − 48 = 12
#   = 左端6 + 右端2 + 中间2节点×2，账目吻合 ⇒ 奇异源是「未被消除的刚体自由度」，
#   即杆B段与右端的**扭转 Phx**：两端 Phx 仅由杆件扭转刚度 [[GJ/L,-GJ/L],...] 相连
#   （该子矩阵本身奇异），无接地约束 → 扭转刚体模态。
#   修复：右端补 Dof.Phx → neq 48 → 47（正好少 1），一次通过。
#   ⇒ 通则：**梁/杆系模型中，凡扭转自由度未被支座或相邻构件接地的自由端，必须补 Phx**。
# ----------------------------------------------------------------------------
# ★ 另一条重要结论：连接器**不消除自由度**（与 Embeded/Coupling 不同）——它只是把
#   两节点的对应自由度用弹簧刚度耦合进总刚。故 neq 核账时 Connector 的消除数记 0。
# ----------------------------------------------------------------------------
# 验证要点（存在性核对）：
#   ① sep-modelcheck 无 0xc0000409、ModelCheckResult 无 error；② 网格 cells>0；
#   ③ 求解正常结束；④ o63_ConnectForce.out 存在非空、内力非 0；
#   ⑤ 61_LoadStep.inp 步名为自建 Step_*（不是 step-1）
# ⚠️ save_script 会警告「连通性异常: 1/2 个单元与主体结构不连接（无共享节点）」——
#    属**假阳性**（#114）：本例刻意不共享节点、靠连接器连接，校验器只按共享节点判连通。
# ⚠️ 未验证路径：非线性本构 / 阻尼·摩擦·失效·阻止开关 / Rotation 转动连接器 /
#    iCoord=Fixed|Follow + vx,vy 局部系 / 动力分析下的连接器
# ============================================================================
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)      # ★ import 之后、clc() 之前；形参名固定 mode
clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
B_BAR   = 0.100            # m，杆截面宽
H_BAR   = 0.100            # m，杆截面高
L_BAR   = 1.000            # m，每段杆长度
K_CONN  = 1.0e6            # N/m，连接器线刚度
FX      = 1000.0           # N，端部水平荷载
MESH    = 0.250            # m，网格尺寸（每段杆 4 个单元）
TOL     = 1.0e-6           # 坐标筛选容差
ANALY_NAME = "Analy_ConnMixed"

# ========== 2. 材料 / 截面（标准牌号查库；★ Section 用 type=，assemble 用 iType=） ==========
setting = Setting()                       # 默认 m 制（SI）
MatDB.load()
mat = MatDB.assemble("C30", iType=MaterialType.Concrete, iMark=ConcreteType.C30, setting=setting)
sec = Section(name="BarRect", type=SectionType.Line, sub=[Rectangle(mat.id, B_BAR, H_BAR)])

# ========== 3. 节点（连接点共享同一 Node 对象） ==========
#  杆A: x=0 -> 1 ；杆B: x=1 -> 2 ；连接器接在 x=1 处的两个"同坐标独立节点"之间
nA0 = Node(0.0,           0.0, 0.0)
nA1 = Node(L_BAR,         0.0, 0.0)       # 杆A 右端（连接器 start）
nB1 = Node(L_BAR + 0.0,   0.0, 0.0)       # ★ 与 nA1 同坐标的独立节点（连接器 end）
nB2 = Node(2.0*L_BAR,     0.0, 0.0)

# ========== 4. 构件（线构件挂线截面 → 网格后成梁单元） ==========
barA = BeamColumn(nids=[nA0.id, nA1.id], iMark=ComponentType.BEAM, sid=sec.id, normal=[0, 1, 0])
barB = BeamColumn(nids=[nB1.id, nB2.id], iMark=ComponentType.BEAM, sid=sec.id, normal=[0, 1, 0])

# ========== 5. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH),
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ========== 6. 几何收口 + 网格划分 + 读回有限元模型 ==========
StruModel.toViewer()
StruModel.submitAndMesh()
FemModel.fromViewer()                     # ★ 内部先 clc()：几何阶段编号全部作废

# ========== 7. 有限元阶段：按坐标重筛节点（网格新增节点编号不可预知） ==========
pos = {n.id: (n.x, n.y, n.z) for n in Node.all()}
def at(x):                                # 取 x 处的全部节点（可能有多个：梁端节点 + 网格节点）
    return [nid for nid, (px, py, pz) in pos.items()
            if abs(px - x) <= TOL and abs(py) <= TOL and abs(pz) <= TOL]

nids_left  = at(0.0)                      # 左端（固定）
nids_mid   = at(L_BAR)                    # ★ 中间截面：两根杆各自的端节点（同坐标、不共节点）
nids_right = at(2.0*L_BAR)                # 右端（加载）

# ========== 8. 约束 ==========
Fixed(gnids=nids_left,  dof=[Dof.All])              # 左端全固定
Fixed(gnids=nids_right, dof=[Dof.Uy, Dof.Uz, Dof.Phx])   # 右端：放开 Ux；★ 必须补 Phx 防扭转刚体模态
Fixed(gnids=nids_mid,   dof=[Dof.Uy, Dof.Uz])       # 中间节点同样只放开 Ux

# ========== 9. 连接器（★ 只能写在这里：fromViewer() 之后） ==========
#  中间截面有 2 个同坐标节点（杆A右端 / 杆B左端），取其两个作为连接器两端
csec = ConnectorSection(name="ConnSpr_Ux",
                        iType=ConnSectType.Translation,        # 平动
                        keyStiff=ConnStiffType.Linear,         # 线弹性
                        consElas=K_CONN,                       # ★ 实际刚度，非 0
                        keyDamp=ConnDampType.Off,
                        keyFriction=ConnFrictionType.Off,
                        keyFail=ConnFailType.Off,
                        keyLock=ConnLockType.Off)
conn = Connector(start=nids_mid[0], end=nids_mid[-1],
                 iDofs=[Dof.Ux], iSects=[csec.id],             # 自由度号 ↔ 截面号 一一对应
                 iCoord=ConnCoordType.Auto)

# ========== 10. 荷载工况 ==========
lc_ll = LoadCase(name="LL")
lc_ll.add(Cload(gnids=nids_right, dof=[FDof.Fx], value=FX / max(1, len(nids_right))))

# ========== 11. 荷载步 → 分析 ==========
step_ll = Step(name="Step_LL")
step_ll.add(LoadCaseCombine(lc_ll.id, 1.0))
step_all = Step(name="Step_ALL")
step_all.add(LoadCaseCombine(lc_ll.id, 1.0))
analy = Analy(name=ANALY_NAME)
analy.add(step_ll)
analy.add(step_all)

# ========== 12. 分析任务指派（★ 漏掉则算默认空分析、结果全 0） ==========
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)
job = Job(name="Job_ConnMixed", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 13. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
