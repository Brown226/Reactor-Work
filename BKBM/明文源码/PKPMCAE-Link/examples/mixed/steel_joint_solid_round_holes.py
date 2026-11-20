# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：J-1 栓焊混合梁柱节点三维实体（混合路线 · 真圆弧孔 + 真圆柱螺栓 + 实体分割分区网格）
# 实测环境：PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0 / tmesh·femesh v2026.5.2.25
# 实测结果（v3）：26948 单元 / 六面体 20560（76.3%）/ 四面体 5650（21.0%）
#                 tmesh「模型识别扫掠体个数」13 → 14 / 扭曲四边形告警消失 / 一次通过
# 对照：v1 无孔整体 20964 单元（六面体 96.7%）；v2 开孔未分割 51515 单元（六面体 25.5%、有告警）
# 本示例印证的配方与坑位（../docs/ERRATA.md）：
#   ★#93 用「实体分割」间接实现分区网格 —— 网格模式是全局单例，但几何拆成多个实体后各实体独立划分；
#        含孔段留四面体、无孔段扫掠六面体，两段用 Binding(NodeToSurf) 绑定
#   ★#94 真圆弧孔（16 段 Arc + 16 片 Cylinder 孔壁，半径严格 13.000000 mm）与真圆柱螺栓
#        （Ø24、N=16 → 384 个节点全部落在半径 12.000000 mm）；「几何圆度←曲面类型 / 网格圆度←断点数 N」
#   ★#95 圆弧构造会产生孤立节点（圆心点 + kp 方向点，本例共 74 个，被 0 个单元引用）
#        —— 不致求解失败，但一切"按坐标筛节点"的检查须先剔除
#   ★#96 分割面同坐标的三条出路 —— 本例采用 (b) 留 1 mm 间隙 + Binding 显式 tol
#   #103 核对产物一律读 genfea-compute-*/，不要读 pcaestru-mesh/ 下的空模板 inp
# 流程印证（../reference/execution_contract.md §6c「小模型先行」）：
#   v1 基线 → v2 开孔暴露问题 → 2 个小模型（<1KB、400~1000 单元、秒级）分别验证
#   「圆弧内环+圆盘端面是否成立」与「孤立节点是否致奇异」→ v3 一次通过、未消耗重试额度
# ============================================================================
# 钢结构节点极限承载力分析 — J-1 栓焊混合梁柱节点 三维实体有限元模型（混合路线）
# 依据: 《钢结构节点极限承载力分析设计文档》§2.3 / §4 / §7.1
# 本版（v3）改动:
#   ★① 孔/螺栓改为真圆弧真圆柱: 每圈 16 段圆弧线 LineType.Arc + 16 片 SurfType.Cylinder 孔壁,
#        孔壁节点严格落在 Ø26 / Ø24 圆上（几何为真圆，不再是八边形）
#   ★② 梁按"分割"重建: 连接区梁段(含 6 孔, 四面体) + 一般区梁段(无孔, 扫掠六面体),
#        使开孔区域之外的梁体恢复六面体网格
#   其余(材料/边界/绑定/荷载/分析)与 v2 一致
# 单位制: SI (m / N / Pa / kg/m^3)
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx
import math

init_ctx(mode=ExecutionMode.MIXED)
clc()

# ================= 1. 参数 =================
COL_H = 0.400; COL_B = 0.400; COL_TW = 0.013; COL_TF = 0.021
COL_L = 4.000; COL_Z0 = -COL_L / 2.0
COL_HW = COL_H / 2.0 - COL_TF          # 0.179
COL_TWH = COL_TW / 2.0                 # 0.0065

BM_H = 0.600; BM_B = 0.200; BM_TW = 0.011; BM_TF = 0.017
BM_L = 3.000
BM_Y0 = COL_B / 2.0                    # 0.2
BM_Y1 = BM_Y0 + BM_L                   # 3.2
BM_HW = BM_H / 2.0 - BM_TF             # 0.283
BM_TWH = BM_TW / 2.0                   # 0.0055

STF_N = 4
SP_T = 0.010; SP_W = 0.240; SP_HW = 0.275
SP_GAP = 0.001                         # 剪切板与梁腹板的几何间隙（避免同坐标节点重复）
SP_X0 = BM_TWH + SP_GAP                # 0.0065
SP_X1 = SP_X0 + SP_T                   # 0.0165

BOLT_D = 0.024; BOLT_R = BOLT_D / 2.0  # 0.012
HOLE_D = 0.026; HOLE_R = HOLE_D / 2.0  # 0.013 (M24 标准圆孔)
BOLT_L = 0.051
BOLT_YS = [0.250, 0.320, 0.390]
BOLT_ZS = [0.050, -0.050]
BOLT_HOLES = [(y, z) for y in BOLT_YS for z in BOLT_ZS]

SPLIT_Y = 0.460                        # 梁分割面（连接区段终点）
SPLIT_GAP = 0.001                      # 分割面几何间隙（靠绑定连接）
MESH_SIZE = 0.020
N_ARC = 16                             # 每圈圆弧段数（几何为真圆，弧段仅作网格控制点）
N_AXIAL = 1.0e6
DISP_TIP = 0.020
RP_OFF = 0.100
TOL = 1.0e-6
ANALY_NAME = "Joint_J1_Elastic"

COL_PROF = [(-COL_B / 2.0, -COL_B / 2.0), ( COL_B / 2.0, -COL_B / 2.0),
            ( COL_B / 2.0, -COL_HW),      ( COL_TWH, -COL_HW),
            ( COL_TWH,  COL_HW),          ( COL_B / 2.0,  COL_HW),
            ( COL_B / 2.0,  COL_B / 2.0), (-COL_B / 2.0,  COL_B / 2.0),
            (-COL_B / 2.0,  COL_HW),      (-COL_TWH,  COL_HW),
            (-COL_TWH, -COL_HW),          (-COL_B / 2.0, -COL_HW)]

BM_PROF = [(-BM_B / 2.0, -BM_H / 2.0), ( BM_B / 2.0, -BM_H / 2.0),
           ( BM_B / 2.0, -BM_HW),      ( BM_TWH, -BM_HW),
           ( BM_TWH,  BM_HW),          ( BM_B / 2.0,  BM_HW),
           ( BM_B / 2.0,  BM_H / 2.0), (-BM_B / 2.0,  BM_H / 2.0),
           (-BM_B / 2.0,  BM_HW),      (-BM_TWH,  BM_HW),
           (-BM_TWH, -BM_HW),          (-BM_B / 2.0, -BM_HW)]
BM_FACE_XP = 3          # 边 q3->q4 生成的侧面 = 梁腹板 x=+BM_TWH 面
BM_FACE_XN = 9          # 边 q9->q10 生成的侧面 = 梁腹板 x=-BM_TWH 面

# ================= 2. 材料与截面 =================
MatDB.load()
setting = Setting()
mat_steel = MatDB.assemble(name="Q345", iType=MaterialType.Steel,
                           iMark=SteelType.Q345, setting=setting)
sec_solid = Section("sec_Q345_solid", SectionType.Solid, SolidSect(mid=mat_steel.id))

# ================= 3. 辅助函数 =================
def make_arc_ring(x, yc, zc, r, kp_id, cn):
    """在 x = const 平面上，用 N_ARC 段圆弧围成一个整圆；断点角逆时针递增（每段 < 180°）。
    返回弧线构件 id 列表。圆心节点 cn、方向点 kp_id 由调用方提供。"""
    pts = [Node(x, yc + r * math.cos(2.0 * math.pi * k / N_ARC),
                   zc + r * math.sin(2.0 * math.pi * k / N_ARC)) for k in range(N_ARC)]
    return [Line(start=pts[k].id, end=pts[(k + 1) % N_ARC].id,
                 center=cn.id, kp=kp_id, type=LineType.Arc).id for k in range(N_ARC)]


def x_tunnel_arcs(x_hi, x_lo, holes, hr):
    """沿 X 方向的通孔：两个整圆环（弧线）+ N_ARC 片圆柱孔壁面。
    返回 (高 x 面内环列表, 低 x 面内环列表, 孔壁面 id 列表)"""
    inner_hi, inner_lo, walls = [], [], []
    for (yc, zc) in holes:
        n_kp = Node(x_hi + 0.05, yc, zc)          # 方向点：圆心 +X 侧
        c_hi = Node(x_hi, yc, zc)
        c_lo = Node(x_lo, yc, zc)
        a_hi = make_arc_ring(x_hi, yc, zc, hr, n_kp.id, c_hi)
        a_lo = make_arc_ring(x_lo, yc, zc, hr, n_kp.id, c_lo)
        inner_hi.append(a_hi)
        inner_lo.append(a_lo)
        for k in range(N_ARC):
            walls.append(Surf(bottom=a_lo[k], top=a_hi[k], type=SurfType.Cylinder).id)
    return inner_hi, inner_lo, walls


def add_prism(profile, base, du, dv, dw, length, sid, side_inners=None, extra_surfs=None):
    """二维闭合轮廓沿 dw 拉伸生成通用几何体构件（可选: 指定侧面开洞 + 附加边界曲面）"""
    ea, eb = [], []
    for (pu, pv) in profile:
        ea.append(Node(base[0] + pu * du[0] + pv * dv[0],
                       base[1] + pu * du[1] + pv * dv[1],
                       base[2] + pu * du[2] + pv * dv[2]))
    for (pu, pv) in profile:
        eb.append(Node(base[0] + pu * du[0] + pv * dv[0] + length * dw[0],
                       base[1] + pu * du[1] + pv * dv[1] + length * dw[1],
                       base[2] + pu * du[2] + pv * dv[2] + length * dw[2]))
    n = len(profile)
    la = [Line(start=ea[i].id, end=ea[(i + 1) % n].id) for i in range(n)]
    lb = [Line(start=eb[i].id, end=eb[(i + 1) % n].id) for i in range(n)]
    lv = [Line(start=ea[i].id, end=eb[i].id) for i in range(n)]
    sa = Surf(outer=[q.id for q in la], type=SurfType.Plane)
    sb = Surf(outer=[q.id for q in lb], type=SurfType.Plane)
    ss = []
    for i in range(n):
        j = (i + 1) % n
        inn = side_inners[i] if (side_inners is not None and i in side_inners) else None
        ss.append(Surf(outer=[la[i].id, lv[i].id, lb[i].id, lv[j].id],
                       type=SurfType.Plane, inners=inn))
    outer = [sa.id, sb.id] + [q.id for q in ss]
    if extra_surfs:
        outer = outer + list(extra_surfs)
    return Solid(outer=outer, type=SolidType.General, sid=sid)


def add_box(x0, x1, y0, y1, z0, z1, sid):
    prof = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return add_prism(prof, (0.0, 0.0, z0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0),
                     (0.0, 0.0, 1.0), z1 - z0, sid)


def add_box_xholes(x0, x1, y0, y1, z0, z1, holes, hr, sid):
    """轴对齐长方体，沿 X 开通圆孔（圆弧孔）"""
    nb = [Node(x0, y0, z0), Node(x1, y0, z0), Node(x1, y1, z0), Node(x0, y1, z0),
          Node(x0, y0, z1), Node(x1, y0, z1), Node(x1, y1, z1), Node(x0, y1, z1)]
    lb = [Line(start=nb[0].id, end=nb[1].id), Line(start=nb[1].id, end=nb[2].id),
          Line(start=nb[2].id, end=nb[3].id), Line(start=nb[3].id, end=nb[0].id)]
    lt = [Line(start=nb[4].id, end=nb[5].id), Line(start=nb[5].id, end=nb[6].id),
          Line(start=nb[6].id, end=nb[7].id), Line(start=nb[7].id, end=nb[4].id)]
    lv = [Line(start=nb[0].id, end=nb[4].id), Line(start=nb[1].id, end=nb[5].id),
          Line(start=nb[2].id, end=nb[6].id), Line(start=nb[3].id, end=nb[7].id)]
    inner_hi, inner_lo, walls = x_tunnel_arcs(x1, x0, holes, hr)
    s_bot = Surf(outer=[q.id for q in lb], type=SurfType.Plane)
    s_top = Surf(outer=[q.id for q in lt], type=SurfType.Plane)
    s_y0 = Surf(outer=[lb[0].id, lv[0].id, lt[0].id, lv[1].id], type=SurfType.Plane)
    s_x1 = Surf(outer=[lb[1].id, lv[1].id, lt[1].id, lv[2].id],
                type=SurfType.Plane, inners=inner_hi)
    s_y1 = Surf(outer=[lb[2].id, lv[2].id, lt[2].id, lv[3].id], type=SurfType.Plane)
    s_x0 = Surf(outer=[lb[3].id, lv[3].id, lt[3].id, lv[0].id],
                type=SurfType.Plane, inners=inner_lo)
    outer = [s_bot.id, s_top.id, s_y0.id, s_x1.id, s_y1.id, s_x0.id] + list(walls)
    return Solid(outer=outer, type=SolidType.General, sid=sid)


def add_bolt_cyl(yc, zc, sid):
    """螺栓等效圆柱体：整圆（16 段圆弧）+ 16 片圆柱侧面 + 2 个圆盘端面"""
    x0, x1 = -BOLT_L / 2.0, BOLT_L / 2.0
    n_kp = Node(x1 + 0.05, yc, zc)
    c0 = Node(x0, yc, zc)
    c1 = Node(x1, yc, zc)
    a0 = make_arc_ring(x0, yc, zc, BOLT_R, n_kp.id, c0)
    a1 = make_arc_ring(x1, yc, zc, BOLT_R, n_kp.id, c1)
    lat = [Surf(bottom=a0[k], top=a1[k], type=SurfType.Cylinder).id for k in range(N_ARC)]
    d0 = Surf(outer=a0, type=SurfType.Plane).id
    d1 = Surf(outer=a1, type=SurfType.Plane).id
    return Solid(outer=lat + [d0, d1], type=SolidType.General, sid=sid)


# ================= 4. 几何阶段: 构件 =================
col = add_prism(COL_PROF, (0.0, 0.0, COL_Z0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0),
                (0.0, 0.0, 1.0), COL_L, sec_solid.id)

# ★ 梁分割: 连接区段(含 6 个圆孔) + 一般区段(无孔, 可扫掠成六面体)
bm_hi, bm_lo, bm_walls = x_tunnel_arcs(BM_TWH, -BM_TWH, BOLT_HOLES, HOLE_R)
beam_a = add_prism(BM_PROF, (0.0, BM_Y0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0),
                   (0.0, 1.0, 0.0), SPLIT_Y - BM_Y0, sec_solid.id,
                   side_inners={BM_FACE_XP: bm_hi, BM_FACE_XN: bm_lo},
                   extra_surfs=bm_walls)
bm_yb = SPLIT_Y + SPLIT_GAP
beam_b = add_prism(BM_PROF, (0.0, bm_yb, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0),
                   (0.0, 1.0, 0.0), BM_Y1 - bm_yb, sec_solid.id)

stf_ids = []
for (zs, ze) in [(BM_HW, BM_HW + BM_TF), (-BM_HW - BM_TF, -BM_HW)]:
    stf_ids.append(add_box(COL_TWH, COL_B / 2.0, -COL_HW, COL_HW, zs, ze, sec_solid.id).id)
    stf_ids.append(add_box(-COL_B / 2.0, -COL_TWH, -COL_HW, COL_HW, zs, ze, sec_solid.id).id)

sp_ids = [add_box_xholes(SP_X0, SP_X1, BM_Y0, BM_Y0 + SP_W, -SP_HW, SP_HW,
                         BOLT_HOLES, HOLE_R, sec_solid.id).id,
          add_box_xholes(-SP_X1, -SP_X0, BM_Y0, BM_Y0 + SP_W, -SP_HW, SP_HW,
                         BOLT_HOLES, HOLE_R, sec_solid.id).id]

bolt_ids = [add_bolt_cyl(yc, zc, sec_solid.id).id for (yc, zc) in BOLT_HOLES]

all_comp_ids = [col.id, beam_a.id, beam_b.id] + stf_ids + sp_ids + bolt_ids

Elset(name="col", ids=[col.id])
Elset(name="ba", ids=[beam_a.id])
Elset(name="bb", ids=[beam_b.id])
for k in range(STF_N):
    Elset(name="stf" + str(k), ids=[stf_ids[k]])
Elset(name="sp1", ids=[sp_ids[0]])
Elset(name="sp2", ids=[sp_ids[1]])
for k in range(len(bolt_ids)):
    Elset(name="bolt" + str(k), ids=[bolt_ids[k]])

# ================= 5. 几何阶段: 荷载与网格设置 =================
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_comp_ids, value=9.81, dir=[0.0, 0.0, -1.0]))

MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ================= 6. 收口 -> 网格 -> 有限元 =================
StruModel.toViewer()
StruModel.submitAndMesh()
FemModel.fromViewer()

# ================= 7. 有限元阶段 =================
node_pos = {}
for nd in Node.all():
    node_pos[nd.id] = (nd.x, nd.y, nd.z)
solid_eids = [e.id for e in Element.all() if e.dimension == 3]
nsets = {}
for ns in Nset.all():
    nsets[ns.name] = set(ns.ids)


def need(name):
    s = nsets.get(name)
    if not s:
        raise RuntimeError("GUARD_SET_MISSING: " + name + " ; available=" + repr(sorted(nsets.keys())))
    return s


col_nodes = need("col(node)")
ba_nodes = need("ba(node)")
bb_nodes = need("bb(node)")
beam_nodes = ba_nodes | bb_nodes
sp1_nodes = need("sp1(node)")
sp2_nodes = need("sp2(node)")
bolt_nodes = [need("bolt" + str(k) + "(node)") for k in range(len(bolt_ids))]
stf_nodes = [need("stf" + str(k) + "(node)") for k in range(STF_N)]

if len(solid_eids) == 0:
    raise RuntimeError("GUARD_NO_SOLID_ELEMENT")

# 7.1 柱底固接
base_nids = [nid for nid in col_nodes if abs(node_pos[nid][2] - COL_Z0) < TOL]
if len(base_nids) < 4:
    raise RuntimeError("GUARD_BASE: " + repr(len(base_nids)))
Fixed(gnids=base_nids, dof=[Dof.Ux, Dof.Uy, Dof.Uz])

# 7.2 柱顶轴力 -> 参考点
top_nids = [nid for nid in col_nodes if abs(node_pos[nid][2] - (COL_Z0 + COL_L)) < TOL]
rp_top = Node(0.0, 0.0, COL_Z0 + COL_L + RP_OFF)
Coupling(tarNode=[rp_top.id], srcNodes=top_nids, type=CouplingType.Rigid, iKey=DofMode.Both)

# 7.3 梁端强迫位移 -> 参考点
tip_nids = [nid for nid in beam_nodes if abs(node_pos[nid][1] - BM_Y1) < TOL]
rp_tip = Node(0.0, BM_Y1 + RP_OFF, 0.0)
Coupling(tarNode=[rp_tip.id], srcNodes=tip_nids, type=CouplingType.Rigid, iKey=DofMode.Both)

# 7.4 梁分割面绑定（连接区段 -> 一般区段）
ab_slave = [nid for nid in ba_nodes if abs(node_pos[nid][1] - SPLIT_Y) < TOL]
ab_master = [nid for nid in bb_nodes if abs(node_pos[nid][1] - bm_yb) < TOL]
if len(ab_slave) < 4 or len(ab_master) < 4:
    raise RuntimeError("GUARD_SPLIT_TIE: " + repr(len(ab_slave)) + "/" + repr(len(ab_master)))
Binding(tarNodes=ab_master, srcNodes=ab_slave,
        type=BindingType.NodeToSurf, iKey=DofMode.Both, iTol=1, tol=0.02)

# 7.5 翼缘全熔透焊缝 -> 柱翼缘外表面
col_ff_out = [nid for nid in col_nodes if abs(node_pos[nid][1] - COL_B / 2.0) < TOL]
beam_end = [nid for nid in ba_nodes if abs(node_pos[nid][1] - BM_Y0) < TOL]
fl_t = [nid for nid in beam_end if node_pos[nid][2] >= BM_HW - TOL]
fl_b = [nid for nid in beam_end if node_pos[nid][2] <= -BM_HW + TOL]
m_t = [nid for nid in col_ff_out if abs(node_pos[nid][0]) <= BM_B / 2.0 + 0.02
       and abs(node_pos[nid][2] - (BM_HW + BM_TF / 2.0)) <= 0.06]
m_b = [nid for nid in col_ff_out if abs(node_pos[nid][0]) <= BM_B / 2.0 + 0.02
       and abs(node_pos[nid][2] + (BM_HW + BM_TF / 2.0)) <= 0.06]
if len(fl_t) < 2 or len(fl_b) < 2 or len(m_t) == 0 or len(m_b) == 0:
    raise RuntimeError("GUARD_WELD_FLANGE")
Binding(tarNodes=m_t, srcNodes=fl_t, type=BindingType.NodeToSurf, iKey=DofMode.Both, iTol=0)
Binding(tarNodes=m_b, srcNodes=fl_b, type=BindingType.NodeToSurf, iKey=DofMode.Both, iTol=0)

# 7.6 剪切板与柱翼缘焊缝
for (nm, st) in (("sp1", sp1_nodes), ("sp2", sp2_nodes)):
    sp_end = [nid for nid in st if abs(node_pos[nid][1] - BM_Y0) < TOL]
    if nm == "sp1":
        m_sp = [nid for nid in col_ff_out if 0.0 <= node_pos[nid][0] <= SP_X1 + 0.03
                and abs(node_pos[nid][2]) <= SP_HW + 0.03]
    else:
        m_sp = [nid for nid in col_ff_out if -(SP_X1 + 0.03) <= node_pos[nid][0] <= 0.0
                and abs(node_pos[nid][2]) <= SP_HW + 0.03]
    if len(sp_end) < 4 or len(m_sp) == 0:
        raise RuntimeError("GUARD_SHEAR_WELD: " + nm)
    Binding(tarNodes=m_sp, srcNodes=sp_end, type=BindingType.NodeToSurf, iKey=DofMode.Both, iTol=0)

# 7.7 加劲肋与柱
for k in range(STF_N):
    s_ids = list(stf_nodes[k])
    pts = [node_pos[nid] for nid in s_ids]
    xs = [q[0] for q in pts]; zs = [q[2] for q in pts]
    m_st = [nid for nid in col_nodes
            if (min(xs) - 0.06) <= node_pos[nid][0] <= (max(xs) + 0.06)
            and (min(zs) - 0.06) <= node_pos[nid][2] <= (max(zs) + 0.06)
            and abs(node_pos[nid][1]) <= COL_H / 2.0 + TOL]
    if len(s_ids) < 4 or len(m_st) == 0:
        raise RuntimeError("GUARD_STIFFENER: " + repr(k))
    Binding(tarNodes=m_st, srcNodes=s_ids, type=BindingType.NodeToSurf, iKey=DofMode.Both, iTol=0)

# 7.8 螺栓与孔壁（梁腹板 + 两块剪切板）
BOLT_TIE_R = 0.045; BOLT_TIE_TOL = 0.035
for k in range(len(bolt_ids)):
    b_ids = list(bolt_nodes[k])
    pts = [node_pos[nid] for nid in b_ids]
    yc = sum(q[1] for q in pts) / float(len(pts))
    zc = sum(q[2] for q in pts) / float(len(pts))
    m_bol = []
    for nid in beam_nodes:
        px, py, pz = node_pos[nid]
        if abs(px) <= BM_TWH + TOL and (py - yc) ** 2 + (pz - zc) ** 2 <= BOLT_TIE_R ** 2:
            m_bol.append(nid)
    for st in (sp1_nodes, sp2_nodes):
        for nid in st:
            px, py, pz = node_pos[nid]
            if (py - yc) ** 2 + (pz - zc) ** 2 <= BOLT_TIE_R ** 2:
                m_bol.append(nid)
    if len(b_ids) < 4 or len(m_bol) == 0:
        raise RuntimeError("GUARD_BOLT: " + repr(k))
    Binding(tarNodes=m_bol, srcNodes=b_ids, type=BindingType.NodeToNode,
            iKey=DofMode.Both, iTol=1, tol=BOLT_TIE_TOL)

# ================= 8. 荷载工况 / 荷载步 / 分析 / 任务 =================
lcs = {}
for c in LoadCase.all():
    lcs[c.name] = c
if "DL" not in lcs:
    raise RuntimeError("GUARD_DL")
dl_id = lcs["DL"].id

lc_n = LoadCase("NL")
lc_n.add(Cload(gnids=[rp_top.id], dof=[FDof.Fz], value=[-N_AXIAL]))
lc_disp = LoadCase("DISP")
lc_disp.add(Cdisp(gnids=[rp_tip.id], dof=[Dof.Uz], value=[-DISP_TIP]))

step_axial = Step(name="Step_Axial", loadCases=[LoadCaseCombine(lid=dl_id, coef=1.0),
                                                LoadCaseCombine(lid=lc_n.id, coef=1.0)])
step_load = Step(name="Step_Load", loadCases=[LoadCaseCombine(lid=dl_id, coef=1.0),
                                              LoadCaseCombine(lid=lc_n.id, coef=1.0),
                                              LoadCaseCombine(lid=lc_disp.id, coef=1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_axial, step_load])
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)
job = Job(name="Job_JointJ1", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

FemModel.toViewer()
FemModel.submitAndSolve()
