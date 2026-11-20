# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：钢筋混凝土工业筒仓 D18×H30（混合路线 · 整圆回转面 + 闭合矩形环撑 + 节点级储料压 + 静水压）
# 实测环境：PkpmCAE 本机 femesh/genfea；pypcae 2.1.0（last release 20261230）
# 实测规模对照（同一筒仓）：24 扇区版 1026 节点/1416 线/792 面 → 9655 单元；
#                          ★整圆版 33 节点/20 线/22 面 → 2930 单元，网格规整度显著更好
# 本示例印证的配方与坑位（../docs/ERRATA.md）：
#   ★#84 整圆回转面可用（更正旧结论）：整圆柱 232 单元、整圆台 246 单元、竖直筒腹板 60 单元，
#        均全四边形无退化；⛔ 但同标高双整圆用 Cylinder 拼水平环面 → "边界点夹角有错-2" 且 0 单元，
#        水平环面必须 Surf(Plane, outer=[外整圆], inners=[[内整圆]])
#   ★#85 回转面分段规律：圆台面底边自由 → 网格器自动对齐上下边（30/30 全四边形，规整）；
#        底边被共享 → 上下边独立取整（54/30，出现波浪状过渡行）；MeshSetting 对整圆线不生效
#        ⇒ 故本例锥斗只分 2 层，把过渡带压缩到 1 处
#   ★#86 环肋/环撑必须与壳体「共边」：闭合矩形环撑 = 下翼缘 Plane 环面 + 外腹板整圆柱 + 上翼缘 Plane 环面，
#        上下翼缘内孔圆都必须是仓壁边界圆 ⇒ 仓壁按 z 与 z+h 两个标高拆带；锥面环肋保持 L 形
#   ★#88 Wpload 壳面静水压力：面号指向与直觉相反（"流体内部 → side=2"才正确）；
#        湿面筛选必须逐节点判定（形心+容差会因曲壳弦效应漏选，实测 58→2266→2290）
#   ★★ 2026-10-22 修正（ERRATA #140）：MH/MV/MC 原用 `Cload(gnids=<N 节点>, value=<N 个值>)` 写成一条记录，
#        实测该写法会让**每个节点都吃到全部值之和**（Σv，荷载放大 N 倍、分布全错）；已改为**逐节点各一条记录**。
#        修后重跑：nElem:2930 / neq:16032 / 2 荷载步 正常结束（与既有规模记录一致）。
#   ★#89 Element.nids 可读 → 节点级精确面压（单元面积按节点均分得 A_trib，逐节点 Cload 三条 Fx/Fy/Fz），
#        完全取代"周向扇区均布面压"近似（无带内平均误差、无扇区方向误差）
#   ★#87 Fixed(BaseLineGeom) 传多条线只展开一条 ⇒ 本例底圈固接在 FEM 阶段按坐标重筛节点做点约束
#   #92  save_script 假阳性：LoadCase 创建语句须与其 .add() 紧邻，否则报"无任何荷载定义"
#   #90  脚本内禁止 import numpy（内嵌 Python 无 numpy）—— 所有后处理在 Agent 本地做
#   #7   多分析：储料静力 / 静水压拆为两个 Analy + 两个 Job，顶部 CUR_TASK 常量分次提交
# ⚠️ 壳理想化声明：环肋内圈取壳体中面半径，会与壳体外半厚重叠（属壳模型理想化，非建模错误）
# ============================================================================
# 路线: 混合（几何 -> 网格 -> 有限元 -> 计算）
# 建模模式: 通用几何模型（Line -> Surf，全壳单元；不使用 Plate/BeamColumn/Wall）
# 模型描述: 钢筋混凝土工业筒仓（D=18 m，仓壁高 30 m，C35，壁厚 250 mm）——
#   【整圆回转面建模，不再周向分扇区】
#   · 仓壁 z=0->30 敞口；交接环梁等效加厚壳带 z=0->1.0（厚 600）；
#   · 仓壁环向支撑 3 道：z=7.5/15/22.5（顶部敞口边不设环撑），闭合矩形截面环撑
#     （下翼缘+外腹板+上翼缘，矩形轮廓 400x800、板厚 300），内外圆边均与仓壁共用 -> 与筒直接相连；
#   · 仓底大锥斗 2 层：水平过渡环（z=0，r 9.0->8.1）+ 锥层1（z=0->-4.5）+ 锥层2（z=-4.5->-9，下口 Phi2.0），
#     锥壁与水平夹角 51.73deg，壁厚 350/300；锥斗环向加劲肋 1 道（z=-4.5 层间圆，300x600x300）；
#   · 环形基础简化为仓壁底圈（z=0、r=9.0）刚性固接，锥斗悬吊、下口自由。
# 网格策略（本机 femesh 实测结论驱动）:
#   · 整圆回转面可用（圆柱/圆台/竖直筒腹板均正常划出全四边形单元）；
#   · 水平环面必须用 Surf(Plane, outer=整圆, inners=[[整圆]])（用 Cylinder 拼同标高双圆会 0 单元）；
#   · 圆台面若底边被相邻面共享，上下边分段数不等会产生波浪状过渡行（丑）；
#     底边自由时网格器自动对齐上下边 -> 完全规整。故锥斗只分 2 层、仅层间一条共享圆，
#     过渡带被压缩到锥层1一处；其余面（圆柱/环带/腹板/环面）均上下边同分段 -> 规整网格。
# 荷载策略（Element.nids 可读 -> 节点级精确施加，取代扇区近似）:
#   · 有限元阶段按单元面积向节点 lump 出受荷面积 A_trib，逐节点施加 Janssen 压力：
#     仓壁 MH = p_h(z) 径向向外；MV = mu*p_h(z) 竖直向下；
#     锥斗/过渡环 MC = p_n = p_v(h)*cos^2(alpha) 法向 + mu*p_n 沿斜面向下（alpha=0 即竖向）；
#     无带内平均、无扇区方向误差；DL 自重仍在几何阶段全局 Emload。
# 用户输入参数: D=18.0(m); H_WALL=30.0; H_FILL=28.0; T_WALL=0.25; T_RING=0.60; H_RING=1.0;
#   仓壁环肋 3 道 z=10/20/30, WRIB_W=0.40/WRIB_H=0.80/T_RIB=0.30;
#   过渡环内收 W_TRANS=0.9; 锥层1 高 4.5 / 锥层2 高 4.5（合计 9.0，下口 R_OUT=1.0）;
#   T_HOP=0.35 / T_SPOUT=0.30; 锥斗环肋 1 道 z=-4.5, RIB_W=0.30/RIB_H=0.60;
#   物料 小麦 gamma=7.5 kN/m3, phi=28deg, phi_w=26deg; 网格 basicSize=1.0 m（无局部加密）
# 假设: 1) 环肋构造＝环带面板（水平环形面）+ 肋板（竖直筒面），内圈与壳体标高圆共用；
#          环肋只能设在面边界圆上（整圆面内部无法插入共享圆），故仓壁 3 道、锥斗 1 道；
#       2) 环肋内圈取壳体中面半径，环带与壳体外侧存在壳面重叠（壳模型理想化）；
#       3) 交接环梁为等效加厚壳带（非实体环梁）；HRB400 未显式建模（未提供配筋率）；
#       4) 环形基础简化为仓壁底圈全约束；未建基础实体/地基弹簧/卸料支承框架；
#       5) 锥斗 p_v 按 Janssen 延用（rho=D/4），未按 GB 50077 锥斗专项公式；未计卸料偏心/动压；
#       6) 顶盖取消 -> 无仓顶活载 LL；未加风/温度；仅线性静力；
#       7) 工况: DL 自重 / MH 仓壁水平侧压 / MV 仓壁竖向摩阻 / MC 锥斗物料压力。
# 单位制: SI（m / N / Pa / kg / m3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx
import math

init_ctx(mode=ExecutionMode.MIXED)
clc()
MatDB.load()

# ========== 1. 参数 ==========
D = 18.0
R = D / 2.0
H_WALL = 30.0
H_FILL = 28.0
T_WALL = 0.25
H_RING = 1.0
T_RING = 0.60
W_TRANS = 0.9
H_CONE1 = 4.5
H_CONE2 = 4.5
R_OUT = 1.0
T_HOP = 0.35
T_SPOUT = 0.30
T_RIB = 0.30
WRIB_W = 0.40
WRIB_H = 0.80
WRIB_Z = [7.5, 15.0, 22.5]
RIB_W = 0.30
RIB_H = 0.60
RIB_Z = [-H_CONE1]
MESH_BASIC = 1.0

R_C1 = R - W_TRANS
TAN_A = (H_CONE1 + H_CONE2) / (R_C1 - R_OUT)
ALPHA = math.atan(TAN_A)
Z_CONE_MID = -H_CONE1
R_CONE_MID = R_C1 + Z_CONE_MID / TAN_A

GAMMA_M = 7500.0
PHI_M = math.radians(28.0)
PHI_W = math.radians(26.0)
MU = math.tan(PHI_W)
K0 = (1.0 - math.sin(PHI_M)) / (1.0 + math.sin(PHI_M))
RHO_H = D / 4.0
A_J = MU * K0 / RHO_H
PH_MAX = GAMMA_M * RHO_H / MU
PV_MAX = GAMMA_M * RHO_H / (MU * K0)


def r_cone(z):
    return R_C1 + z / TAN_A


def janssen_ph(h):
    if h <= 0.0:
        return 0.0
    return PH_MAX * (1.0 - math.exp(-A_J * h))


def janssen_pv(h):
    if h <= 0.0:
        return 0.0
    return PV_MAX * (1.0 - math.exp(-A_J * h))


# ========== 2. 材料 / 截面 ==========
setting = Setting()
mat_c35 = MatDB.assemble(name="C35", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C35, setting=setting)
sec_wall = Section("wall_t250", SectionType.Surface, SingleLayer(mid=mat_c35.id, t=T_WALL))
sec_ring = Section("ring_t600", SectionType.Surface, SingleLayer(mid=mat_c35.id, t=T_RING))
sec_hop = Section("hopper_t350", SectionType.Surface, SingleLayer(mid=mat_c35.id, t=T_HOP))
sec_spout = Section("spout_t300", SectionType.Surface, SingleLayer(mid=mat_c35.id, t=T_SPOUT))
sec_rib = Section("rib_t300", SectionType.Surface, SingleLayer(mid=mat_c35.id, t=T_RIB))

# ========== 3. 整圆边线（起点=终点；相邻面共用同一条整圆线） ==========
DIR_NODE = Node(0.0, 0.0, 100.0)
AX = {}
CIRC = {}


def axis_at(z):
    k = round(z, 6)
    if k not in AX:
        AX[k] = Node(0.0, 0.0, z)
    return AX[k]


def circ(z, radius):
    key = (round(z, 6), round(radius, 6))
    if key not in CIRC:
        n = Node(radius, 0.0, z)
        CIRC[key] = Line(start=n.id, end=n.id, center=axis_at(z).id,
                         kp=DIR_NODE.id, type=LineType.Arc)
    return CIRC[key].id


# ========== 4. 面构件 ==========
# 4.1 交接环梁加厚壳带 + 仓壁 3 带（整圆柱）
s_ring = Surf(type=SurfType.Cylinder, top=circ(H_RING, R), bottom=circ(0.0, R),
              sid=sec_ring.id)
WALL_LEVELS = [H_RING]
for zr in WRIB_Z:
    WALL_LEVELS += [zr, zr + WRIB_H]
WALL_LEVELS += [H_WALL]
s_wall = []
for k in range(len(WALL_LEVELS) - 1):
    s_wall.append(Surf(type=SurfType.Cylinder, top=circ(WALL_LEVELS[k + 1], R),
                       bottom=circ(WALL_LEVELS[k], R), sid=sec_wall.id))
# 4.2 水平过渡环（Plane 环形面：外整圆 + 内孔整圆）
s_trans = Surf(outer=[circ(0.0, R)], inners=[[circ(0.0, R_C1)]],
               type=SurfType.Plane, sid=sec_hop.id)
# 4.3 锥斗 2 层（整圆台）
s_cone1 = Surf(type=SurfType.Cylinder, top=circ(0.0, R_C1),
               bottom=circ(Z_CONE_MID, R_CONE_MID), sid=sec_hop.id)
s_cone2 = Surf(type=SurfType.Cylinder, top=circ(Z_CONE_MID, R_CONE_MID),
               bottom=circ(-H_CONE1 - H_CONE2, R_OUT), sid=sec_spout.id)
# 4.4 仓壁环肋 3 道：环带（Plane 环形）+ 腹板（整圆柱）
s_wrib = []
for zr in WRIB_Z:
    fl_b = Surf(outer=[circ(zr, R + WRIB_W)], inners=[[circ(zr, R)]],
                type=SurfType.Plane, sid=sec_rib.id)
    wb = Surf(type=SurfType.Cylinder, top=circ(zr + WRIB_H, R + WRIB_W),
              bottom=circ(zr, R + WRIB_W), sid=sec_rib.id)
    fl_t = Surf(outer=[circ(zr + WRIB_H, R + WRIB_W)], inners=[[circ(zr + WRIB_H, R)]],
                type=SurfType.Plane, sid=sec_rib.id)
    s_wrib.append([fl_b, wb, fl_t])
# 4.5 锥斗环肋 1 道（层间圆 z=-4.5）
s_hrib = []
for zr in RIB_Z:
    rr = r_cone(zr)
    fl = Surf(outer=[circ(zr, rr + RIB_W)], inners=[[circ(zr, rr)]],
              type=SurfType.Plane, sid=sec_rib.id)
    wb = Surf(type=SurfType.Cylinder, top=circ(zr + RIB_H, rr + RIB_W),
              bottom=circ(zr, rr + RIB_W), sid=sec_rib.id)
    s_hrib.append([fl, wb])

# ========== 5. 集合 ==========
Elset(name="ring_beam", ids=[s_ring.id])
Elset(name="wall", ids=[s.id for s in s_wall])
Elset(name="trans_ring", ids=[s_trans.id])
Elset(name="hopper", ids=[s_cone1.id, s_cone2.id])
for k, g in enumerate(s_wrib):
    Elset(name="wall_rib_%d" % (k + 1), ids=[s.id for s in g])
for k, g in enumerate(s_hrib):
    Elset(name="hopper_rib_%d" % (k + 1), ids=[s.id for s in g])

# ========== 6. 几何阶段荷载：仅自重 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(value=9.81, dir=[0.0, 0.0, -1.0]))

# ========== 7. 网格设置（toViewer 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_BASIC, beamSize=MESH_BASIC,
                      wallSize=MESH_BASIC, plateSize=MESH_BASIC, densifyLevel=0),
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ========== 8. 几何收口 -> 网格 -> 读入有限元 ==========
StruModel.toViewer()
StruModel.submitAndMesh()
FemModel.fromViewer()

# ========== 9. 有限元阶段 ==========
# 9.1 支座：仓壁底圈整圆节点全约束（环形基础简化）
base_nids = [n.id for n in Node.all()
             if abs(n.z) < 1.0e-6 and abs(math.hypot(n.x, n.y) - R) < 1.0e-6]
Fixed(gnids=base_nids, dof=[Dof.All])

# 9.2 节点受荷面积（单元面积按节点数均分累加）
coord = {}
for n in Node.all():
    coord[n.id] = (n.x, n.y, n.z)


def tri_area(pa, pb, pc):
    u = [pb[k] - pa[k] for k in range(3)]
    v = [pc[k] - pa[k] for k in range(3)]
    cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
          u[0] * v[1] - u[1] * v[0]]
    return 0.5 * math.sqrt(cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2])


trib = {}
for e in Element.all():
    if e.dimension != 2:
        continue
    p = [coord[i] for i in e.nids]
    if len(p) == 4:
        a = tri_area(p[0], p[1], p[2]) + tri_area(p[0], p[2], p[3])
    else:
        a = tri_area(p[0], p[1], p[2])
    share = a / float(len(p))
    for i in e.nids:
        trib[i] = trib.get(i, 0.0) + share

# 9.3 逐节点 Janssen 压力 -> 节点力（MH 径向 / MV 壁面摩阻 / MC 锥斗法向+摩阻）
fx_mh = {}
fy_mh = {}
fz_mv = {}
fx_mc = {}
fy_mc = {}
fz_mc = {}
SA = math.sin(ALPHA)
CA = math.cos(ALPHA)
for nid, a in trib.items():
    x, y, z = coord[nid]
    rr = math.hypot(x, y)
    th = math.atan2(y, x)
    ct = math.cos(th)
    st = math.sin(th)
    h = H_FILL - z
    if z > 1.0e-6 and abs(rr - R) < 1.0e-6:                 # 仓壁（含环梁带）内表面
        ph = janssen_ph(h)
        if ph > 0.0:
            fx_mh[nid] = ph * a * ct
            fy_mh[nid] = ph * a * st
            fz_mv[nid] = fz_mv.get(nid, 0.0) - MU * ph * a
    elif abs(z) < 1.0e-6 and R_C1 - 1.0e-6 <= rr <= R + 1.0e-6:   # 水平过渡环
        pv = janssen_pv(h)
        fz_mc[nid] = fz_mc.get(nid, 0.0) - pv * a
    elif z < -1.0e-6 and abs(rr - r_cone(z)) < 1.0e-6:      # 锥斗内表面
        pn = janssen_pv(h) * CA * CA
        if pn > 0.0:
            fx_mc[nid] = fx_mc.get(nid, 0.0) + pn * a * SA * ct - MU * pn * a * CA * ct
            fy_mc[nid] = fy_mc.get(nid, 0.0) + pn * a * SA * st - MU * pn * a * CA * st
            fz_mc[nid] = fz_mc.get(nid, 0.0) - pn * a * CA - MU * pn * a * SA

# ★ 2026-10-22 更正（ERRATA #140）：`Cload` 的一条记录里，(dof, value) 是**施加到 gnids 中每个节点的荷载模式**，
#   各分量按 dof 累加 ⇒ 逐节点给不同值**必须逐节点各写一条记录**（写成 value=[v1,…,vN] 会让每个节点都吃到 Σv！）。
lc_mh = LoadCase("MH")
for nid, v in fx_mh.items():
    lc_mh.add(Cload(gnids=[nid], dof=[FDof.Fx], value=[v]))
for nid, v in fy_mh.items():
    lc_mh.add(Cload(gnids=[nid], dof=[FDof.Fy], value=[v]))
lc_mv = LoadCase("MV")
for nid, v in fz_mv.items():
    lc_mv.add(Cload(gnids=[nid], dof=[FDof.Fz], value=[v]))
lc_mc = LoadCase("MC")
for nid, v in fx_mc.items():
    lc_mc.add(Cload(gnids=[nid], dof=[FDof.Fx], value=[v]))
for nid, v in fy_mc.items():
    lc_mc.add(Cload(gnids=[nid], dof=[FDof.Fy], value=[v]))
for nid, v in fz_mc.items():
    lc_mc.add(Cload(gnids=[nid], dof=[FDof.Fz], value=[v]))

# 9.4 静水压力工况 WP：满水至 z=30，gamma_w=9.81 kN/m3，作用于全部浸湿内表面
#     （仓壁+环梁带内表面、水平过渡环、锥斗内表面）；Wpload 仅有限元阶段、按单元面号施加；
#     面号按单元法向几何判定并经实算方向校核修正：自单元形心沿法向偏移 10 mm，
#     落点在水体内部 -> side=2，否则 side=1（本机 Wpload 面号约定与直觉相反，已按
#     Step_WP 仓壁径向位移符号校核：内压应使仓壁外鼓）；压力 p(z)=gamma_w*(H_WATER-z)
H_WATER = H_WALL                      # 30.0 m 水位（仓顶敞口边）
GAMMA_W = 9810.0                      # N/m3
Z_REF = -(H_CONE1 + H_CONE2)          # -9.0 m 参考点（锥斗下口）
P_REF = GAMMA_W * (H_WATER - Z_REF)   # 参考点水压 = 382590 Pa


def inside_water(x, y, z):
    rr = math.hypot(x, y)
    if z > 1.0e-9:
        return rr < R - 1.0e-9
    if z < -1.0e-9:
        return rr < r_cone(z) - 1.0e-9
    return rr < R - 1.0e-9


wp_eids = []
wp_sides = []
for e in Element.all():
    if e.dimension != 2:
        continue
    p = [coord[i] for i in e.nids]
    cx = sum(q[0] for q in p) / len(p)
    cy = sum(q[1] for q in p) / len(p)
    cz = sum(q[2] for q in p) / len(p)
    pn = [coord[i] for i in e.nids]
    wet = False
    if all(q[2] > -1.0e-6 and abs(math.hypot(q[0], q[1]) - R) < 1.0e-6 for q in pn):
        wet = True                                   # 仓壁/环梁带内表面（整圆 r=9）
    elif all(abs(q[2]) <= 1.0e-6
             and R_C1 - 1.0e-6 <= math.hypot(q[0], q[1]) <= R + 1.0e-6 for q in pn):
        wet = True                                   # 水平过渡环（z=0 环面）
    elif all(q[2] <= 1.0e-6
             and abs(math.hypot(q[0], q[1]) - r_cone(q[2])) < 1.0e-6 for q in pn):
        wet = True                                   # 锥斗内表面（母线 r=r_cone(z)）
    if not wet:
        continue
    u = [p[1][k] - p[0][k] for k in range(3)]
    v = [p[2][k] - p[0][k] for k in range(3)]
    nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
           u[0] * v[1] - u[1] * v[0]]
    nl = math.sqrt(nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2])
    if nl < 1.0e-12:
        continue
    nrm = [t / nl for t in nrm]
    side = 2 if inside_water(cx + 0.01 * nrm[0], cy + 0.01 * nrm[1],
                             cz + 0.01 * nrm[2]) else 1
    wp_eids.append(e.id)
    wp_sides.append(side)

lc_wp = LoadCase("WP")
if wp_eids:
    lc_wp.add(Wpload(esides=(wp_eids, wp_sides), type=WaterPressureType.ShellSurface,
                     value=P_REF, h0=H_WATER, h=Z_REF))

# 9.5 荷载步 / 分析 / 任务指派
lcs = {c.name: c for c in LoadCase.all()}
# 分析一：储料静力（自重 + 物料三工况 + 储料包络步），不含水压
CASE_ORDER = ["DL", "MH", "MV", "MC"]
steps_g = [Step(name="Step_" + nm, loadCases=[LoadCaseCombine(lid=lcs[nm].id, coef=1.0)])
           for nm in CASE_ORDER]
steps_g.append(Step(name="Step_ALL",
                    loadCases=[LoadCaseCombine(lid=lcs[nm].id, coef=1.0) for nm in CASE_ORDER]))
# 分析二：水压（静水压力单独 + 自重&水压组合），与储料荷载完全分开
steps_w = [Step(name="Step_WP",
                loadCases=[LoadCaseCombine(lid=lcs["WP"].id, coef=1.0)]),
           Step(name="Step_DLWP",
                loadCases=[LoadCaseCombine(lid=lcs["DL"].id, coef=1.0),
                           LoadCaseCombine(lid=lcs["WP"].id, coef=1.0)])]
ANALY_GRAIN = "Silo_Static_Grain"
ANALY_WATER = "Silo_Static_Water"
Analy(name=ANALY_GRAIN, steps=steps_g)
Analy(name=ANALY_WATER, steps=steps_w)

# 任务开关：一次 submitAndSolve() 只算 JobManager 指向的当前分析 -> 同脚本改 CUR_TASK 跑两次
CUR_TASK = 1                          # 0 = 储料静力分析; 1 = 水压分析
jobs = [Job(name="Job_Grain", main=[a.name for a in Analy.all()].index(ANALY_GRAIN)),
        Job(name="Job_Water", main=[a.name for a in Analy.all()].index(ANALY_WATER))]
j = jobs[CUR_TASK]
JobManager(main=j.main, pre=j.pre, uid=j.uid, jobs=jobs)

# ========== 10. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
