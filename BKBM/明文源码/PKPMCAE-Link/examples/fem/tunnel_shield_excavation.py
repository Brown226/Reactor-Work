# -*- coding: utf-8 -*-
# 分析类型: 静力施工步进(单元生死, 26步)
# 模型描述: 盾构机掘进模拟 v7 —— 前挖一段: 掌子面施加+X掘进推力(随机头前移, 仅当前步生效),
#           同时裸露土面施加径向支护压力; 后一段随即安装Q345钢支护壳(Binding绑定到岩土开挖面)
# 用户输入参数: 净空D=6m级; 埋深20m; 围岩弹性E=50MPa; Q345钢支护壳t=0.05m;
#              支护压力200kPa径向朝外; 钢壳-岩土Binding绑定; 前挖后支逐段循环
# 假设:
#   1. 计算域: x 0~60m, y ±30m, z -40~0m(地表z=0, 隧道中心z=-20); 开挖半径3.45m;
#   2. 围岩弹性E=50MPa/nu=0.33/rho=1900; 支护壳Q345(MatDB), 壳厚0.05m, 中面r=3.45m;
#   3. 支护压力: 200kPa(约K0静止土压力, gamma=19kN/m3, 埋深20m), 径向朝外作用于
#      刚开挖裸露的岩土表面(围岩内层单元Face6), 逐环独立LoadCase, 后续步累加保持;
#      受荷面每环整圈一个集合SUP_s环号, 坐标系取表面法向(LocalCoordinateSystem=表面向内),
#      方向自动沿各面法向, 无需拆分扇区.
#   4. 钢壳与岩土: 壳节点圈与开挖面节点圈同坐标(独立Node), Binding(type=NodeToNode,
#      tol=0.02)绑定传力;
#   5. Step_0初始地应力(杀死全部钢壳); Step_1~24: 挖第s环核心土+该环土面支护压力+
#      安装第s-1环钢壳; Step_25: 安装末环钢壳;
#   6. 边界: 底面三向固定, 侧面法向约束, 端面纵向约束, 地表自由;
#   7. 单位制 m-N-Pa-kg(SI).

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数定义 ==========
R_EXC   = 3.45         # m, 开挖半径(围岩侧/钢壳中面)
Z_CENTER = -20.0
X_LEN   = 60.0
N_SEG   = 24
A_SQ    = 1.5
NA      = 6
NR2     = 10
Q_GROW  = 1.25
HALF_W  = 30.0
Z_TOP   = 0.0
Z_BOT   = -40.0
T_LIN   = 0.05         # m, 钢支护壳厚
P_SUP   = 2.0e5        # Pa, 支护压力(径向朝外)
P_FACE  = 2.0e5        # Pa, 掌子面掘进推力(+X, 顶住前方土体, 仅当前步生效)
E_SOIL, NU_SOIL, RHO_SOIL = 5.0e7, 0.33, 1900.0

# ========== 2. 材料 ==========
MatDB.load()
setting = Setting()
mat_soil = Material(name="Soil_E50", iType=MaterialType.Custom,
                    iModel=MaterialModel.Elastic,
                    E0=E_SOIL, poisson=NU_SOIL, density=RHO_SOIL)
mat_q345 = MatDB.assemble("Q345", iType=MaterialType.Steel,
                          iMark=SteelType.Q345, setting=setting)

# ========== 3. 截面 ==========
sec_soil = Section("SoilSolid", SectionType.Solid, SolidSect(mid=mat_soil.id))
sec_lin  = Section("SteelShell_t050", SectionType.Surface,
                   SingleLayer(mid=mat_q345.id, t=T_LIN))

# ========== 4-5. 节点与单元 ==========
NK = 4 * NA
ANG = [math.radians(-45.0 + 90.0 * k / NA) for k in range(NK)]

sq_pt, cir_pt, rect_pt, hit = [], [], [], []
for k in range(NK):
    cy = math.cos(ANG[k])
    sz = math.sin(ANG[k])
    s_sq = A_SQ / max(abs(cy), abs(sz))
    sq_pt.append((s_sq * cy, s_sq * sz))
    cir_pt.append((R_EXC * cy, R_EXC * sz))
    sy = HALF_W / max(abs(cy), 1e-12)
    szt = (Z_CENTER - Z_BOT) / abs(sz) if sz < 0 else (Z_TOP - Z_CENTER) / max(abs(sz), 1e-12)
    s_r = min(sy, szt)
    rect_pt.append((s_r * cy, s_r * sz))
    hit.append("Y" if sy < szt else ("B" if sz < 0 else "T"))

N_LAYER = 3 + NR2
layer_pos = []
for L in range(N_LAYER):
    row = []
    for k in range(NK):
        if L == 0:
            row.append(sq_pt[k])
        elif L == 1:
            row.append((0.5 * (sq_pt[k][0] + cir_pt[k][0]),
                        0.5 * (sq_pt[k][1] + cir_pt[k][1])))
        elif L == 2:
            row.append(cir_pt[k])
        else:
            j = L - 2
            f = (Q_GROW ** j - 1.0) / (Q_GROW ** NR2 - 1.0)
            row.append((cir_pt[k][0] + f * (rect_pt[k][0] - cir_pt[k][0]),
                        cir_pt[k][1] + f * (rect_pt[k][1] - cir_pt[k][1])))
    layer_pos.append(row)

def pos_of(L, k):
    return layer_pos[L][k % NK]

X_PLANE = [X_LEN * p / N_SEG for p in range(N_SEG + 1)]
ring_nd, sq_nd, lin_nd = [], [], []
for p in range(N_SEG + 1):
    x = X_PLANE[p]
    ring_p = []
    for L in range(N_LAYER):
        row = []
        for k in range(NK):
            yr, zr = layer_pos[L][k]
            row.append(Node(x, yr, Z_CENTER + zr))
        ring_p.append(row)
    ring_nd.append(ring_p)
    # 钢壳节点圈: 与开挖面(L2)同坐标但独立Node
    lin_nd.append([Node(x, cir_pt[k][0], Z_CENTER + cir_pt[k][1]) for k in range(NK)])
    sq_p = [[None] * (NA + 1) for _ in range(NA + 1)]
    for i in range(NA + 1):
        for j in range(NA + 1):
            if i == 0 or i == NA or j == 0 or j == NA:
                k = i if j == NA else (3 * NA - i if j == 0 else (2 * NA - j if i == NA else 3 * NA + j))
                sq_p[i][j] = ring_p[0][k % NK]
    for i in range(1, NA):
        for j in range(1, NA):
            u = j / NA
            v = i / NA
            ps = pos_of(0, 3 * NA + j)
            pn = pos_of(0, 2 * NA - j)
            pw = pos_of(0, 3 * NA - i)
            pe = pos_of(0, i)
            sw = pos_of(0, 3 * NA)
            se = pos_of(0, 0)
            nw = pos_of(0, 2 * NA)
            ne = pos_of(0, NA)
            yr = ((1 - v) * ps[0] + v * pn[0] + (1 - u) * pw[0] + u * pe[0]
                  - ((1 - u) * (1 - v) * sw[0] + u * (1 - v) * se[0]
                     + (1 - u) * v * nw[0] + u * v * ne[0]))
            zr = ((1 - v) * ps[1] + v * pn[1] + (1 - u) * pw[1] + u * pe[1]
                  - ((1 - u) * (1 - v) * sw[1] + u * (1 - v) * se[1]
                     + (1 - u) * v * nw[1] + u * v * ne[1]))
            sq_p[i][j] = Node(x, yr, Z_CENTER + zr)
    sq_nd.append(sq_p)

core_eids_seg = [[] for _ in range(N_SEG)]
soil_eids = []
band2_eids_seg = [[] for _ in range(N_SEG)]    # 围岩内层(L2->L3带)单元, 每环24个
lin_eids_seg = [[] for _ in range(N_SEG)]

for p in range(N_SEG):
    for i in range(NA):
        for j in range(NA):
            c = [sq_nd[p][i][j], sq_nd[p][i][j + 1], sq_nd[p][i + 1][j + 1], sq_nd[p][i + 1][j]]
            d = [sq_nd[p + 1][i][j], sq_nd[p + 1][i][j + 1], sq_nd[p + 1][i + 1][j + 1], sq_nd[p + 1][i + 1][j]]
            e = Element(nids=[c[0].id, c[1].id, c[2].id, c[3].id,
                              d[0].id, d[1].id, d[2].id, d[3].id],
                        type=ElementType.Solid, sid=sec_soil.id)
            core_eids_seg[p].append(e.id)
            soil_eids.append(e.id)
    for L in range(N_LAYER - 1):
        for k in range(NK):
            k2 = (k + 1) % NK
            c = [ring_nd[p][L][k], ring_nd[p][L + 1][k], ring_nd[p][L + 1][k2], ring_nd[p][L][k2]]
            d = [ring_nd[p + 1][L][k], ring_nd[p + 1][L + 1][k], ring_nd[p + 1][L + 1][k2], ring_nd[p + 1][L][k2]]
            e = Element(nids=[c[0].id, c[1].id, c[2].id, c[3].id,
                              d[0].id, d[1].id, d[2].id, d[3].id],
                        type=ElementType.Solid, sid=sec_soil.id)
            soil_eids.append(e.id)
            if L < 2:
                core_eids_seg[p].append(e.id)
            elif L == 2:
                band2_eids_seg[p].append(e.id)
    # 钢支护壳环(独立节点圈, 与开挖面同坐标)
    for k in range(NK):
        k2 = (k + 1) % NK
        n1 = lin_nd[p][k]
        n2 = lin_nd[p][k2]
        n3 = lin_nd[p + 1][k2]
        n4 = lin_nd[p + 1][k]
        mid_ang = 0.5 * (ANG[k] + ANG[k2])
        e = Element(nids=[n1.id, n2.id, n3.id, n4.id],
                    type=ElementType.ShellAssembled, sid=sec_lin.id,
                    normal=[0.0, math.cos(mid_ang), math.sin(mid_ang)])
        lin_eids_seg[p].append(e.id)

all_lin_eids = [e for seg in lin_eids_seg for e in seg]

# ========== 6. 集合 ==========
Elset("SoilAll", soil_eids)
es_shell_all = Elset("SteelShellAll", all_lin_eids)
ns_soil_face = Nset("SoilExcavFace")
ns_shell = Nset("ShellRing")
for p in range(N_SEG + 1):
    for k in range(NK):
        ns_soil_face.add(ring_nd[p][2][k].id)
        ns_shell.add(lin_nd[p][k].id)

# 支护压力受荷面集合: 每环整圈24面一个集合, 荷载按集合施加
sup_set_ids = []
for s in range(N_SEG):
    es = Elset("SUP_s%02d" % s, band2_eids_seg[s])
    sup_set_ids.append(es.id)

# 掌子面集合: 第s环核心土单元(84个)的-X面(Face1)拼成完整横截面
face_set_ids = {}
for s in range(1, N_SEG):
    es = Elset("FACE_s%02d" % s, core_eids_seg[s])
    face_set_ids[s] = es.id

# 单元生死集合: 每环开挖杀死(KILL)/支护激活(ADD)各一个集合, Change按集合施加
kill_set_ids = []
add_set_ids = []
for s in range(N_SEG):
    kill_set_ids.append(Elset("KILL_s%02d" % s, core_eids_seg[s]).id)
    add_set_ids.append(Elset("ADD_s%02d" % s, lin_eids_seg[s]).id)

# ========== 6b. 相互作用: 钢壳绑定到岩土开挖面 ==========
Binding(tarNodes=[ns_soil_face.id], srcNodes=[ns_shell.id],
        type=BindingType.NodeToNode, iKey=DofMode.Both, iTol=1, tol=0.02)

# ========== 7. 边界条件 ==========
bot_nids, uy_nids, ux_nids = [], [], []
for p in range(N_SEG + 1):
    for k in range(NK):
        nd = ring_nd[p][N_LAYER - 1][k].id
        if hit[k] == "B":
            bot_nids.append(nd)
        elif hit[k] == "Y":
            uy_nids.append(nd)
        if p == 0 or p == N_SEG:
            ux_nids.append(nd)
Fixed(gnids=bot_nids, dof=[Dof.Ux, Dof.Uy, Dof.Uz])
Fixed(gnids=uy_nids, dof=[Dof.Uy])
Fixed(gnids=ux_nids, dof=[Dof.Ux])

# ========== 8. 荷载工况 ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=soil_eids + all_lin_eids, value=9.81, dir=[0, 0, -1]))

# 逐环支护压力工况: 挖开第s环后, 压力作用于该环裸露土面(围岩内层单元内面Face6), 径向朝外
lc_sup = []
for s in range(N_SEG):
    lc = LoadCase("SUP_%d" % s)
    lc.add(Ebsload(esides=[(sup_set_ids[s], 6)], value=P_SUP,
                   iCoord=CSYS.LocalCoordinateSystem, dir=[1.0, 0.0, 0.0]))
    lc_sup.append(lc)

# 掌子面掘进推力工况: 作用于第s+1环核心土横截面(Face1), +X向, 随机头前移不累积
lc_face = {}
for s in range(1, N_SEG):
    lc = LoadCase("FACE_%d" % s)
    lc.add(Ebsload(esides=[(face_set_ids[s], 1)], value=P_FACE,
                   iCoord=CSYS.GlobalSystem, dir=[1.0, 0.0, 0.0]))
    lc_face[s] = lc

# ========== 9. 施工荷载步(前挖后支) ==========
analy = Analy("TunnelShield_v8")

analy.add(Step("Step_0_Geostatic",
               changes=[Change(type=ChangeType.Remove, chType=ChangeChType.Element,
                               geids=[es_shell_all.id])],
               loadCases=[LoadCaseCombine(lc_dl.id, 1.0)]))

for s in range(N_SEG):
    chs = [Change(type=ChangeType.Remove, chType=ChangeChType.Element,
                  geids=[kill_set_ids[s]])]
    if s >= 1:
        chs.append(Change(type=ChangeType.Add, chType=ChangeChType.Element,
                          geids=[add_set_ids[s - 1]]))
    lcs = [LoadCaseCombine(lc_dl.id, 1.0)]
    for j in range(s + 1):
        lcs.append(LoadCaseCombine(lc_sup[j].id, 1.0))
    if s + 1 < N_SEG:
        lcs.append(LoadCaseCombine(lc_face[s + 1].id, 1.0))
    analy.add(Step("Step_%d_Excav" % (s + 1), changes=chs, loadCases=lcs))

lcs = [LoadCaseCombine(lc_dl.id, 1.0)]
for j in range(N_SEG):
    lcs.append(LoadCaseCombine(lc_sup[j].id, 1.0))
analy.add(Step("Step_25_FinalShell",
               changes=[Change(type=ChangeType.Add, chType=ChangeChType.Element,
                               geids=[add_set_ids[N_SEG - 1]])],
               loadCases=lcs))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
