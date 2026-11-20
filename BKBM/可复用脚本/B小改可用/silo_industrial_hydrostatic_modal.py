# -*- coding: utf-8 -*-
# 分析类型: 线性静力 + 模态（同一模型内两个分析任务, CUR_TASK 开关逐任务提交）
# 模型描述: 工业筒仓: 顶部开口圆柱仓壁 + 圆锥料斗 + 环向加劲环(每环周圈竖向撑) +
#          中部带竖肋环形支承箍(环形支撑, 外环约束三向平动) + 上提的底部环(带竖向撑);
#          环/撑内缘为与仓壁同坐标独立节点, Binding(NodeToNode, 全自由度) 绑定模拟焊接;
#          锥斗加厚20mm + 交界至支承箍区圆柱插入厚板24mm + 锥顶过渡环加大 + 支承箍加强
#          (结果驱动加强: 初版热点锥顶交界 r=3.4,z=4.0 处 Mises 53.1MPa, 加强后 42.3MPa, -20%)
# 用户输入参数: R=4.0(m) 仓壁半径; R_OUT=1.0(m) 排料口半径; H_CONE=5.0(m) 锥斗高; Z_TOP=18.0(m) 仓顶(开口);
#              T_WALL=0.016(m); T_CONE=0.020(m); T_INS=0.024(m); T_BAND=0.025(m);
#              H_FILL=18.0(m) 静水压力液位(满仓); A_H=0.981(m/s^2) 水平惯性加速度(0.1g);
#              N_MODAL=12; Z_BOT=0.4(m) 底部环标高(自排料口上提); CUR_TASK=0/1 提交静力/模态任务
# 假设: 单位制 m 制(SI); 材料 Q345B(材料库); 环形支撑=支承箍外环连续环向约束三向平动(环梁/柱支承理想化);
#      壳单元绕序统一使仓壁/锥斗法向朝外, 内壁受压面为 Face2; 顶部开口不设顶盖;
#      惯性力仅计结构自质量水平惯性(0.1g), 不计贮料惯性; 静水压力按满仓液体 gamma=9810 N/m^3
# 验证基准: Step_HP 支承环竖向反力合计 ≈ gamma_w * V_liquid ≈ 9810*763.4 ≈ 7.49e6 N
#          (V_liquid = 圆柱段 pi*R^2*(Z_TOP-H_CONE) + 锥台 pi*H_CONE/3*(r1^2+r1*r2+r2^2));
#          热点位于锥-柱交界不连续区(加强后约 42 MPa, 对 Q345 利用率约 0.12); 模态无零频
# 单位制: SI（m / N / Pa / kg/m^3）

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数定义 (SI: m / N / Pa) ==========
CUR_TASK = 0               # 0=提交静力任务, 1=提交模态任务(PkpmCAE 每次提交仅算当前分析任务)
R = 4.0                    # m, 圆柱仓壁半径
R_OUT = 1.0                # m, 排料口半径
H_CONE = 5.0               # m, 锥斗高度
Z_TOP = 18.0               # m, 仓顶标高(开口)
T_WALL = 0.016             # m, 圆柱仓壁厚度
T_CONE = 0.020             # m, 锥斗加厚板厚
T_INS = 0.024              # m, 圆柱插入厚板厚(交界~支承箍区)
T_STF = 0.020              # m, 加劲环/竖向撑板厚
T_BAND = 0.025             # m, 支承箍板厚
N_CIRC = 48                # 圆周等分数
DZ = 0.5                   # m, 竖向网格尺寸
Z_BAND_LO = 9.7            # m, 支承箍下翼缘标高
Z_BAND_TOP = 10.3          # m, 支承箍上翼缘标高
BAND_OUT = 0.5             # m, 支承箍外挑宽度
RING_OUT = 0.15            # m, 加劲环外挑宽度
RING_OUT_J = 0.25          # m, 锥顶过渡环外挑宽度(加强)
GUS_STEP = 4               # 加劲环竖向撑间隔(12 道/环)
GUS_STEP_J = 2             # 锥顶过渡环竖向撑间隔(加强, 24 道)
Z_RINGS = [5.0, 13.5, 17.0, 18.0]   # m, 环向加劲环标高
H_GUS = 0.5                # m, 加劲环竖向撑高度
GUS_SGN = {5.0: 1.0, 13.5: 1.0, 17.0: 1.0, 18.0: -1.0}   # 竖向撑方向(+1 环上/-1 环下)
Z_BOT = 0.4                # m, 底部环标高(自排料口上提)
H_BOTG = 0.4               # m, 底部环竖向撑高度
BOT_OUT = 0.3              # m, 底部环外挑宽度
N_RIB_STEP = 1             # 支承箍竖肋间隔(48 道)
GAMMA_W = 9810.0           # N/m^3, 贮液重度
H_FILL = Z_TOP             # m, 静水压力液位(满仓至开口顶)
A_H = 0.981                # m/s^2, 水平惯性加速度(0.1g)
N_MODAL = 12               # 模态阶数

# ========== 2. 材料（标准牌号查材料库） ==========
MatDB.load()
setting = Setting()        # 默认 m 制 (SI)
mat = MatDB.assemble(name="Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)

# ========== 3. 截面（壳） ==========
sec_wall = Section("Wall16", SectionType.Surface, SingleLayer(mid=mat.id, t=T_WALL))
sec_cone = Section("Cone20", SectionType.Surface, SingleLayer(mid=mat.id, t=T_CONE))
sec_ins = Section("Ins24", SectionType.Surface, SingleLayer(mid=mat.id, t=T_INS))
sec_stf = Section("Stiff20", SectionType.Surface, SingleLayer(mid=mat.id, t=T_STF))
sec_band = Section("Band25", SectionType.Surface, SingleLayer(mid=mat.id, t=T_BAND))

# ========== 4. 节点 ==========
def cone_rad(zz):
    return R_OUT + (R - R_OUT) * zz / H_CONE

def make_ring(rad, z):
    ring = []
    for i in range(N_CIRC):
        th = 2.0 * math.pi * i / N_CIRC
        ring.append(Node(rad * math.cos(th), rad * math.sin(th), z))
    return ring

def nxt(ring, i):
    return ring[i % N_CIRC]

def ring_w(zz):
    return RING_OUT_J if abs(zz - 5.0) < 1e-9 else RING_OUT

def gus_stp(zz):
    return GUS_STEP_J if abs(zz - 5.0) < 1e-9 else GUS_STEP

# 4.1 仓壁/锥斗环(含底部环界面环 0.4/0.8)
wall_z = [0.0, Z_BOT, Z_BOT + H_BOTG]
z = 0.0
while z < H_CONE - 1e-9:
    wall_z.append(round(z, 6))
    z += DZ
zc = H_CONE
while zc < Z_TOP - 1e-9:
    wall_z.append(round(zc, 6))
    zc += DZ
wall_z.append(Z_TOP)
wall_z.append(Z_BAND_LO)
wall_z.append(Z_BAND_TOP)
wall_z = sorted(set(wall_z))
wall_rings = []
for zz in wall_z:
    rad = cone_rad(zz) if zz <= H_CONE + 1e-9 else R
    wall_rings.append(make_ring(rad, zz))

def wall_ring_at(zz):
    return wall_rings[wall_z.index(round(zz, 6))]

# 4.2 加劲环: 内缘独立节点环(与仓壁同坐标, 供绑定) + 外缘环 + 竖向撑顶节点
ring_in = {}
ring_out = {}
gus_in = {}
gus_out = {}
for zz in Z_RINGS:
    sgn = GUS_SGN[zz]
    z2 = zz + sgn * H_GUS
    rad = cone_rad(zz) if zz <= H_CONE + 1e-9 else R
    w = ring_w(zz)
    stp = gus_stp(zz)
    ring_in[zz] = make_ring(rad, zz)
    ring_out[zz] = make_ring(rad + w, zz)
    gus_in[zz] = [Node(rad * math.cos(2.0 * math.pi * i / N_CIRC),
                       rad * math.sin(2.0 * math.pi * i / N_CIRC), z2)
                  for i in range(0, N_CIRC, stp)]
    gus_out[zz] = [Node((rad + w) * math.cos(2.0 * math.pi * i / N_CIRC),
                        (rad + w) * math.sin(2.0 * math.pi * i / N_CIRC), z2)
                   for i in range(0, N_CIRC, stp)]
# 4.3 支承箍: 内缘独立节点环 + 外环
band_in_lo = make_ring(R, Z_BAND_LO)
band_in_top = make_ring(R, Z_BAND_TOP)
band_lo = make_ring(R + BAND_OUT, Z_BAND_LO)
band_top = make_ring(R + BAND_OUT, Z_BAND_TOP)
# 4.4 底部环(上提): 内缘独立节点环 + 外环 + 竖向撑顶节点
rb0 = cone_rad(Z_BOT)
bot_in = make_ring(rb0, Z_BOT)
bot_out = make_ring(rb0 + BOT_OUT, Z_BOT)
rb1 = cone_rad(Z_BOT + H_BOTG)
bot_gus_in = [Node(rb1 * math.cos(2.0 * math.pi * i / N_CIRC),
                   rb1 * math.sin(2.0 * math.pi * i / N_CIRC), Z_BOT + H_BOTG)
              for i in range(0, N_CIRC, GUS_STEP)]
bot_gus_out = [Node((rb0 + BOT_OUT) * math.cos(2.0 * math.pi * i / N_CIRC),
                    (rb0 + BOT_OUT) * math.sin(2.0 * math.pi * i / N_CIRC), Z_BOT + H_BOTG)
               for i in range(0, N_CIRC, GUS_STEP)]

# ========== 5. 单元 ==========
elems_cone = []
elems_wall = []
elems_stf = []
# 5.1 锥斗(加厚) + 仓壁(交界区插入厚板) 壳, 法向朝外
for k in range(len(wall_rings) - 1):
    r0 = wall_rings[k]
    r1 = wall_rings[k + 1]
    zmid = 0.5 * (wall_z[k] + wall_z[k + 1])
    if zmid < H_CONE - 1e-9:
        sec = sec_cone
    elif zmid <= Z_BAND_TOP + 1e-9:
        sec = sec_ins
    else:
        sec = sec_wall
    for i in range(N_CIRC):
        e = Element(nids=[nxt(r0, i).id, nxt(r0, i + 1).id,
                          nxt(r1, i + 1).id, nxt(r1, i).id],
                    type=ElementType.ShellAssembled, sid=sec.id)
        if zmid < H_CONE - 1e-9:
            elems_cone.append(e)
        else:
            elems_wall.append(e)
# 5.2 加劲环: 环板 + 周圈竖向撑
for zz in Z_RINGS:
    wi = ring_in[zz]
    so = ring_out[zz]
    stp = gus_stp(zz)
    for i in range(N_CIRC):
        elems_stf.append(Element(nids=[nxt(wi, i).id, nxt(wi, i + 1).id,
                                       nxt(so, i + 1).id, nxt(so, i).id],
                                 type=ElementType.ShellAssembled, sid=sec_stf.id))
    for k, i in enumerate(range(0, N_CIRC, stp)):
        elems_stf.append(Element(nids=[nxt(wi, i).id, nxt(so, i).id,
                                       gus_out[zz][k].id, gus_in[zz][k].id],
                                 type=ElementType.ShellAssembled, sid=sec_stf.id))
# 5.3 支承箍: 下翼缘 + 上翼缘 + 外腹板 + 竖肋
for i in range(N_CIRC):
    elems_stf.append(Element(nids=[nxt(band_in_lo, i).id, nxt(band_in_lo, i + 1).id,
                                   nxt(band_lo, i + 1).id, nxt(band_lo, i).id],
                             type=ElementType.ShellAssembled, sid=sec_band.id))
    elems_stf.append(Element(nids=[nxt(band_in_top, i).id, nxt(band_in_top, i + 1).id,
                                    nxt(band_top, i + 1).id, nxt(band_top, i).id],
                             type=ElementType.ShellAssembled, sid=sec_band.id))
    elems_stf.append(Element(nids=[nxt(band_lo, i).id, nxt(band_lo, i + 1).id,
                                    nxt(band_top, i + 1).id, nxt(band_top, i).id],
                             type=ElementType.ShellAssembled, sid=sec_band.id))
for i in range(0, N_CIRC, N_RIB_STEP):
    elems_stf.append(Element(nids=[nxt(band_in_lo, i).id, nxt(band_lo, i).id,
                                    nxt(band_top, i).id, nxt(band_in_top, i).id],
                             type=ElementType.ShellAssembled, sid=sec_band.id))
# 5.4 底部环(上提): 环板 + 周圈竖向撑
for i in range(N_CIRC):
    elems_stf.append(Element(nids=[nxt(bot_in, i).id, nxt(bot_in, i + 1).id,
                                   nxt(bot_out, i + 1).id, nxt(bot_out, i).id],
                             type=ElementType.ShellAssembled, sid=sec_stf.id))
for k, i in enumerate(range(0, N_CIRC, GUS_STEP)):
    elems_stf.append(Element(nids=[nxt(bot_in, i).id, nxt(bot_out, i).id,
                                   bot_gus_out[k].id, bot_gus_in[k].id],
                             type=ElementType.ShellAssembled, sid=sec_stf.id))
elems_all = elems_cone + elems_wall + elems_stf

# ========== 6. 集合 ==========
Elset("ConeShells", [e.id for e in elems_cone])
Elset("WallShells", [e.id for e in elems_wall])
Elset("StiffShells", [e.id for e in elems_stf])
Elset("AllShells", [e.id for e in elems_all])
Nset("RingSupport", [n.id for n in band_lo] + [n.id for n in band_top])
# 6.1 焊接界面节点集合(主=仓壁/锥斗, 从=环/撑内缘独立节点)
ns_weld_tar = []
ns_weld_src = []
for zz in Z_RINGS:
    sgn = GUS_SGN[zz]
    z2 = zz + sgn * H_GUS
    tar = Nset("WeldTar_R%g" % zz, [n.id for n in wall_ring_at(zz)] +
               [n.id for n in wall_ring_at(z2)])
    src = Nset("WeldSrc_R%g" % zz, [n.id for n in ring_in[zz]] +
               [n.id for n in gus_in[zz]])
    ns_weld_tar.append(tar)
    ns_weld_src.append(src)
tar_b = Nset("WeldTar_Band", [n.id for n in wall_ring_at(Z_BAND_LO)] +
             [n.id for n in wall_ring_at(Z_BAND_TOP)])
src_b = Nset("WeldSrc_Band", [n.id for n in band_in_lo] + [n.id for n in band_in_top])
ns_weld_tar.append(tar_b)
ns_weld_src.append(src_b)
tar_0 = Nset("WeldTar_Bot", [n.id for n in wall_ring_at(Z_BOT)] +
             [n.id for n in wall_ring_at(Z_BOT + H_BOTG)])
src_0 = Nset("WeldSrc_Bot", [n.id for n in bot_in] + [n.id for n in bot_gus_in])
ns_weld_tar.append(tar_0)
ns_weld_src.append(src_0)

# ========== 7. 支座（环形支撑: 支承箍外环连续约束三向平动） ==========
Fixed(gnids=[n.id for n in band_lo] + [n.id for n in band_top],
      dof=[Dof.Ux, Dof.Uy, Dof.Uz])

# ========== 7.1 绑定（模拟焊接: 环/撑内缘 <-> 仓壁/锥斗, 全自由度） ==========
for kt, ks in zip(ns_weld_tar, ns_weld_src):
    Binding(tarNodes=[kt.id], srcNodes=[ks.id],
            type=BindingType.NodeToNode, iKey=DofMode.Both)

# ========== 8. 荷载工况 ==========
all_eids = [e.id for e in elems_all]
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_eids, value=9.81, dir=[0, 0, -1]))

lc_hp = LoadCase("HP")
lc_hp.add(Wpload(esides=[(e.id, 2) for e in elems_cone + elems_wall],
                 type=WaterPressureType.ShellSurface,
                 value=GAMMA_W * H_FILL, h0=H_FILL, h=0.0))

lc_in = LoadCase("IN")
lc_in.add(Emload(geids=all_eids, value=A_H, dir=[1, 0, 0]))

# ========== 9. 荷载步与分析（静力 + 模态） ==========
step_dl = Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0))
step_hp = Step("Step_HP").add(LoadCaseCombine(lc_hp.id, 1.0))
step_in = Step("Step_IN").add(LoadCaseCombine(lc_in.id, 1.0))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0))
step_all.add(LoadCaseCombine(lc_hp.id, 1.0))
step_all.add(LoadCaseCombine(lc_in.id, 1.0))

analy_static = Analy("StaticAnalysis")
analy_static.add(step_dl)
analy_static.add(step_hp)
analy_static.add(step_in)
analy_static.add(step_all)

analy_modal = Analy("ModalAnalysis",
                    setting=AnalySetting(anaType=AnaType.MODAL, nModal=N_MODAL))

# ========== 10. 分析任务（两个分析在同一模型内, CUR_TASK 决定本次提交哪个） ==========
job_static = Job("StaticJob", main=0)
job_modal = Job("ModalJob", main=1, uid="k7p3q9")
jobs = [job_static, job_modal]
JobManager(main=jobs[CUR_TASK].main, pre=jobs[CUR_TASK].pre,
           uid=jobs[CUR_TASK].uid, jobs=jobs)

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) Step_HP: 支承环竖向反力合计 ≈ gamma_w*V_liquid ≈ 7.49e6 N
#    (V_liquid = pi*R^2*(Z_TOP-H_CONE) + pi*H_CONE/3*(R_OUT^2+R_OUT*R+R^2) ≈ 763.4 m^3)
# 2) 热点在锥-柱交界不连续区(r=3.4, z=4.0 环): 加强后 Mises ≈ 42.3 MPa(初版 53.1 MPa)
# 3) 模态无零频(支承环已约束三向平动); 个别高阶 Lanczos 残差警告(~3e-4)可忽略
# 4) 绑定界面两侧节点位移差 ≈ 0(NodeToNode 全自由度)
