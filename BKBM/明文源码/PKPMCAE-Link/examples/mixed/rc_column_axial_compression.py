# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：钢筋混凝土柱轴压模型（混合路线 · 钢筋 Embeded 嵌入实体）
# 实测环境：PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0（last release 20261230）/ genfea 20261014
# 实测结果：5077 节点 / 3968 单元（混凝土 3840 个八节点六面体 + 钢筋 128 个 Link）
#           neq = 14739 / 3 荷载步全收敛 / 模型检查 {"error":{},"warning":{}} / 全流程约 15 s
# 本示例印证的坑位（../docs/ERRATA.md）：
#   ★#76 钢筋必须用 BeamColumn(iMark=ComponentType.TRUSS) —— 用 Line 会生成梁单元，
#        被求解器 judgeEmbedElemType 拒绝（"不允许梁单元嵌入"），且该错误只在 genfea 阶段暴露
#   ★#77 实体最小约束必须含「抗绕 Z 转动」项 —— 底面 y=0 边补 1 个非形心节点约束 Uy，
#        否则 zero pivot（形心点绕 Z 转动位移恒为 0，约束形心的 Ux,Uy 拦不住）
#   ★#78 Size.beamSize 对 TRUSS 构件不生效 —— 每条钢筋构件只划 1 个单元，
#        故本例总单元 3968 = 3840 + 128（估规模须按"构件数×1"计）
#   ★#79 neq 差值核账法 —— 136 个钢筋节点×3 = 408，用于验证 Embeded 真的生效
#   #105 复测通过：#51(Job+JobManager)、#19(网格设置在 toViewer 前)、#47(边界线不挂 sid)、
#        #9/#48(同坐标复用 Node)、#20(MatDB 查库)、#3(关键字传参，校验 0 错误 0 警告)
# ⚠️ 本示例的验收为「存在性核对」，未做定量比对（见 ../reference/verification.md 硬禁令）
# ============================================================================
# 路线: 混合（构件几何 → 自动网格 → 有限元 → 脚本内求解）
# 建模模式: 通用几何模型（Line → Surf → Solid；钢筋用 Line 挂圆截面）
# 模型描述: 钢筋混凝土矩形截面柱轴压模型。C30 混凝土 400x400x3000 mm 实体单元；
#           8Φ20 HRB400 纵筋 + Φ8@100 HRB400 箍筋（TRUSS 构件 → 网格后为 Link 二力杆单元，
#           用 Embeded(NodeToElem) 嵌入混凝土实体）；
#           柱顶均布面压 2000 kN；线性静力分析。
# 单位制: SI（m / N / Pa / kg·m^-3）；Setting() 默认档
# 用户输入参数（用户已确认的默认取值）:
#   截面 0.400 x 0.400 m; 柱高 3.000 m; C30 混凝土; 纵筋 8Φ20 HRB400; 箍筋 Φ8@100 HRB400;
#   轴力 2000 kN; 两端铰接
# 假设（均已在建模规格核对表中向用户列明）:
#   1) 线弹性静力：不计混凝土开裂、不计钢筋屈服、不计粘结滑移
#   2) 钢筋与混凝土用 Embeded(NodeToElem) 完全协调变形（无滑移）
#   3) 保护层 20 mm（箍筋外皮 → 混凝土表面）[默认]；箍筋简化为矩形闭合环、不建弯钩 [默认]
#   4) "两端铰接"对实体单元的实现：底面混凝土节点全部约束 Uz + 底面形心一点补 Ux,Uy
#      + 底面 y=0 边上一个非形心节点补 Uy（消除绕 Z 刚体转动，否则总刚奇异）；
#      顶面自由（仅受均布面压）→ 端截面横向泊松变形基本不受抑制、不引入端部弯矩约束 [假设]
#   5) 计入自重（DL 工况）；轴压单独成 LL 工况；另设 Step_ALL 包络步
#   6) 钢筋节点不直接施加任何约束（避免与 Embeded 冲突），全部通过嵌入跟随混凝土

# ========== 0. 导入（混合路线五行；init_ctx 紧随其后、clc 之前） ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)   # ★ import 之后、clc() 之前；形参名固定 mode
clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
B_COL     = 0.400            # m，截面宽（X 向）
D_COL     = 0.400            # m，截面高（Y 向）
H_COL     = 3.000            # m，柱高（Z 向，竖直向上）
HALF_B    = B_COL / 2.0      # m，= 0.200
HALF_D    = D_COL / 2.0      # m，= 0.200

COVER     = 0.020            # m，保护层厚（箍筋外皮 → 混凝土表面）[默认]
D_STIRRUP = 0.008            # m，箍筋直径 Φ8
D_MAIN    = 0.020            # m，纵筋直径 Φ20
S_STIRRUP = 0.100            # m，箍筋间距 @100
Z_STIR_0  = 0.050            # m，第一道箍筋中心距柱底

N_AXIAL   = 2000.0e3         # N，柱顶轴力 2000 kN
A_TOP     = B_COL * D_COL    # m^2，顶面面积 = 0.160
P_TOP     = N_AXIAL / A_TOP  # Pa，顶面均布面压 = 1.25e7

G_ACC     = 9.81             # m/s^2，重力加速度（SI 制）
MESH_SIZE = 0.050            # m，全局网格尺寸（取值依据见第 6 段注释）
TOL       = 1.0e-6           # m，坐标判定容差
ANALY_NAME = "Analy_RCColumnAxial"

HS = HALF_D - COVER - D_STIRRUP / 2.0            # m，箍筋中心线半宽 = 0.176
HM = HALF_D - COVER - D_STIRRUP - D_MAIN / 2.0   # m，纵筋中心半宽   = 0.162

N_STIRRUP = int((H_COL - Z_STIR_0) / S_STIRRUP) + 1   # = 30 道（z = 0.050 ... 2.950）

# 8 根纵筋的 (x, y) 中心坐标：每边 3 根（角筋共用）→ 4 角筋 + 4 边中筋
MAIN_XY = [(-HM, -HM), (0.0, -HM), (HM, -HM),
           (-HM, 0.0),              (HM, 0.0),
           (-HM,  HM), (0.0,  HM), (HM,  HM)]

# 箍筋矩形环 4 角点符号，按闭环顺序
STIR_CORNER = [(-1, -1), (1, -1), (1, 1), (-1, 1)]

# 体单元面号表（1-based 局部节点序，取自手册「体单元面号」）；运行时判定顶面 side 号用
FACE_TABLE = {
    4:  [[3, 2, 1], [1, 2, 4], [2, 3, 4], [3, 1, 4]],
    10: [[3, 2, 1], [1, 2, 4], [2, 3, 4], [3, 1, 4]],
    5:  [[4, 3, 2, 1], [1, 2, 5], [2, 3, 5], [3, 4, 5], [4, 1, 5]],
    15: [[4, 3, 2, 1], [1, 2, 5], [2, 3, 5], [3, 4, 5], [4, 1, 5]],
    6:  [[3, 2, 1], [4, 5, 6], [1, 2, 5, 4], [2, 3, 6, 5], [3, 1, 4, 6]],
    8:  [[4, 3, 2, 1], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]],
    20: [[4, 3, 2, 1], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]],
}

# ========== 2. 材料（标准牌号一律查库，禁止手填数值） ==========
MatDB.load()
setting = Setting()                                    # 默认档 = m / N / Pa / kg·m^-3
mat_c30 = MatDB.assemble(name="C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
mat_rb  = MatDB.assemble(name="HRB400", iType=MaterialType.Rebar,
                         iMark=RebarType.HRB400, setting=setting)

# ========== 3. 截面（体构件 Solid / 线构件 Line，类型必须匹配） ==========
sec_conc = Section("sec_C30_solid",  SectionType.Solid, SolidSect(mid=mat_c30.id))
sec_main = Section("sec_HRB400_D20", SectionType.Line,  Circle(mid=mat_rb.id, d=D_MAIN))
sec_stir = Section("sec_HRB400_D8",  SectionType.Line,  Circle(mid=mat_rb.id, d=D_STIRRUP))

# ========== 4. 节点（同坐标一律复用同一 Node 对象，避免"坐标重复定义"） ==========
node_cache = {}


def get_nid(x, y, z):
    key = (round(x, 9), round(y, 9), round(z, 9))
    if key not in node_cache:
        node_cache[key] = Node(x, y, z)
    return node_cache[key].id


# ========== 5. ① 几何阶段：混凝土实体（Line → Surf → Solid） ==========
CORN_XY = [(-HALF_B, -HALF_D), (HALF_B, -HALF_D), (HALF_B, HALF_D), (-HALF_B, HALF_D)]
cb = [get_nid(cx, cy, 0.0)   for (cx, cy) in CORN_XY]     # 底面 4 角点 z=0
ct = [get_nid(cx, cy, H_COL) for (cx, cy) in CORN_XY]     # 顶面 4 角点 z=H_COL

# 12 条棱线：只作面/体边界，一律不挂 sid（挂了会额外生成梁单元）
ln_bot = [Line(start=cb[i], end=cb[(i + 1) % 4]).id for i in range(4)]
ln_top = [Line(start=ct[i], end=ct[(i + 1) % 4]).id for i in range(4)]
ln_ver = [Line(start=cb[i], end=ct[i]).id           for i in range(4)]

# 6 个平面：outer 传线构件 id、四条边闭环；面构件同样不挂 sid（不生成壳单元）
s_bot = Surf(outer=ln_bot, type=SurfType.Plane).id        # 底面 z=0
s_top = Surf(outer=ln_top, type=SurfType.Plane).id        # 顶面 z=H_COL（加载面）
s_lat = []
for i in range(4):
    j = (i + 1) % 4
    s_lat.append(Surf(outer=[ln_bot[i], ln_ver[i], ln_top[i], ln_ver[j]],
                      type=SurfType.Plane).id)

# 实体：outer 传面构件 id；只有体构件挂截面
solid_conc = Solid(outer=[s_bot, s_top] + s_lat,
                   type=SolidType.General, sid=sec_conc.id)

# ========== 5b. ① 几何阶段：钢筋（BeamColumn TRUSS 挂圆截面 → 网格后为 Link 二力杆单元） ==========
# ★ 钢筋必须用 BeamColumn(iMark=ComponentType.TRUSS) 而不是 Line：
#   Line + 圆截面网格后生成"梁单元"，而求解器 Embeded 只接受 Link(二力杆)/壳单元嵌入实体，
#   用梁单元会在 genfea 阶段报 "judgeEmbedElemType出错: 不允许梁单元嵌入"（本次实测）。
#   TRUSS 构件网格后为 ElementType.Link 二力杆（仅平动自由度），轴压下钢筋只受轴力，力学表达正确。
main_gids = []
for (mx, my) in MAIN_XY:
    main_gids.append(BeamColumn(nids=[get_nid(mx, my, 0.0), get_nid(mx, my, H_COL)],
                                iMark=ComponentType.TRUSS,
                                sid=sec_main.id,
                                normal=[1, 0, 0]).id)     # 杆轴沿 Z，法向取 X（不平行）

stir_gids = []
for k in range(N_STIRRUP):
    zk = Z_STIR_0 + k * S_STIRRUP
    cn = [get_nid(sx * HS, sy * HS, zk) for (sx, sy) in STIR_CORNER]
    for i in range(4):
        stir_gids.append(BeamColumn(nids=[cn[i], cn[(i + 1) % 4]],
                                    iMark=ComponentType.TRUSS,
                                    sid=sec_stir.id,
                                    normal=[0, 0, 1]).id)  # 杆轴水平，法向取 Z（不平行）

# ========== 6. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
# 模式全部取软件默认（强制口径）：体网格六面体主导 + 六面体扫掠 + 面网格四边形主导。
#   规则长方体用扫掠可得到纯六面体、单元数少、无曲面离散误差，不要降级 tMeshOnly。
# basicSize 取值依据：① 总体尺度 0.400 x 0.400 x 3.000 m；② 最小特征尺寸 = 截面边长 0.400 m
#   与箍筋间距 0.100 m；③ 分析目的 = 看截面与高度方向应力/应变分布（应力类需较细）；
#   ④ 取 0.050 m = 截面边长 1/8、箍筋间距 1/2（相邻两道箍筋间 2 层单元，可分辨箍筋位置）；
#   ⑤ 预估规模：混凝土 8 x 8 x 60 = 3840 六面体；纵筋 8 x 60 = 480 梁单元；
#      箍筋 120 边 x 约 7 段 ≈ 840 梁单元；合计约 5200 单元 / 约 6300 节点（线弹性，规模可控）。
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE,
                          beamSize=MESH_SIZE, wallSize=MESH_SIZE,
                          plateSize=MESH_SIZE),   # ★ TRUSS 属梁柱撑类，beamSize 默认 1.0 m 会把钢筋划得过粗
           meshPattern="sweepAndTMesh",     # 体网格：六面体主导
           hexMeshPattern="sweepOnly",      # 六面体类型：扫掠网格
           hexFtPattern="FT",               # 边界恢复（扫掠时不生效）
           toQuad="true")                   # 面网格：四边形主导（字符串，不是布尔值）

# ========== 7. ①c 几何收口 + 网格划分 + 转入有限元 ==========
StruModel.toViewer()          # 1 几何模型可视化（含 Solid → meshGen 自动置 1）
StruModel.submitAndMesh()     # 2 自动划分网格（MIXED 模式下生成 pypcae.fem.in）
FemModel.fromViewer()         # 3 读入有限元模型（内部先 clc()，几何对象与 id 全部作废）

# ========== 8. ② 有限元阶段：编号一律重新取 ==========
node_pos = {}
for nd in Node.all():
    node_pos[nd.id] = (nd.x, nd.y, nd.z)


def read_conn(elem):
    """读回单元连接节点号；不同版本属性名可能不同，逐个候选探测"""
    for key in ("nids", "nodes", "nodeIds", "node_ids", "nIds"):
        cand = getattr(elem, key, None)
        if cand:
            return [int(v) for v in cand]
    return []


all_elems   = Element.all()
solid_elems = [e for e in all_elems if e.dimension == 3]   # 混凝土实体（主/宿主）
rebar_elems = [e for e in all_elems if e.dimension == 1]   # 钢筋 Link 二力杆（从/被嵌入）
solid_eids  = [e.id for e in solid_elems]
rebar_eids  = [e.id for e in rebar_elems]
all_eids    = [e.id for e in all_elems]

# 混凝土实体单元的节点集合（★ 约束筛选只用它，排除钢筋节点）
conc_nids = set()
for e in solid_elems:
    for nid in read_conn(e):
        conc_nids.add(nid)

bot_conc   = [nid for nid in conc_nids if abs(node_pos[nid][2]) <= TOL]
bot_center = [nid for nid in bot_conc
              if abs(node_pos[nid][0]) <= TOL and abs(node_pos[nid][1]) <= TOL]
bot_other  = [nid for nid in bot_conc if nid not in bot_center]

# —— 守卫：宁可报错停下，也不静默少约束 / 少加载 / 少嵌入 ——
if len(solid_eids) == 0:
    raise RuntimeError("GUARD_NO_SOLID_ELEMENT: mesh produced 0 solid elements")
if len(rebar_eids) == 0:
    raise RuntimeError("GUARD_NO_REBAR_ELEMENT: mesh produced 0 line (rebar) elements")
if len(conc_nids) == 0:
    raise RuntimeError("GUARD_ELEM_NIDS_UNREADABLE: cannot read solid element connectivity")
if len(bot_center) != 1:
    raise RuntimeError("GUARD_BASE_CENTER_MISSING: need exactly 1 concrete node at (0,0,0); got "
                       + repr(len(bot_center)))
if len(bot_other) < 4:
    raise RuntimeError("GUARD_BASE_TOO_FEW: bottom face needs >=4 concrete nodes besides center; got "
                       + repr(len(bot_other)))

# ========== 9. 钢筋嵌入混凝土（Embeded：从 = Link/梁单元，主 = 实体单元） ==========
Embeded(tarElems=solid_eids, srcElems=rebar_eids,
        type=EmbededType.NodeToElem, iKey=DofMode.Both, tol=-1)

# ========== 10. 柱顶轴力：运行时按单元节点坐标定位顶面 side 号 ==========


def poly_area(pts):
    """空间多边形面积：以首顶点为扇心做三角剖分求和（网格面为平面）"""
    total = 0.0
    p0 = pts[0]
    for k in range(1, len(pts) - 1):
        pa = pts[k]
        pb = pts[k + 1]
        ax, ay, az = pa[0] - p0[0], pa[1] - p0[1], pa[2] - p0[2]
        bx, by, bz = pb[0] - p0[0], pb[1] - p0[1], pb[2] - p0[2]
        cx = ay * bz - az * by
        cy = az * bx - ax * bz
        cz = ax * by - ay * bx
        total += 0.5 * (cx * cx + cy * cy + cz * cz) ** 0.5
    return total


top_esides = []
top_area_sum = 0.0
for e in solid_elems:
    conn = read_conn(e)
    table = FACE_TABLE.get(len(conn))
    if table is None:
        continue
    for fi in range(len(table)):
        nids_f = [conn[local - 1] for local in table[fi]]
        on_top = True
        for nid in nids_f:
            pz = node_pos.get(nid)
            if pz is None or abs(pz[2] - H_COL) > TOL:
                on_top = False
                break
        if on_top:
            top_esides.append([e.id, fi + 1])           # side 号 = 面表序号（1-based）
            top_area_sum += poly_area([node_pos[nid] for nid in nids_f])
            break

if len(top_esides) == 0:
    raise RuntimeError("GUARD_NO_TOP_FACE: no solid element face found at z = H_COL")
if abs(top_area_sum - A_TOP) > 1.0e-6:                  # 防"漏面导致轴力偏小"
    raise RuntimeError("GUARD_TOP_AREA_MISMATCH: sum(top face area) = " + repr(top_area_sum)
                       + " m^2, expected " + repr(A_TOP) + " m^2")

# 抗绕 Z 转动的水平约束点：取底面 y=0 边上一个非形心节点 (MESH_SIZE, 0, 0)
#   ★ 实体单元无转动自由度：绕 Z 刚体转动表现为 u_x = -theta*y、u_y = theta*x。
#     底面若只约束 Uz + 形心 Ux,Uy（形心 x=y=0，转动不产生位移），该转动无任何约束可拦
#     → 总刚奇异 → genfea 报 "主对角元为零(zero pivot) / Pardiso:矩阵分解有错"（本次实测）。
#     在 y=0 边上补一个 x != 0 的节点约束 Uy 即可消除，且不抑制底面其余节点的横向泊松变形。
bot_antirot = [nid for nid in bot_other
               if abs(node_pos[nid][1]) <= TOL
               and abs(node_pos[nid][0] - MESH_SIZE) <= TOL]
bot_uz_only = [nid for nid in bot_other if nid not in bot_antirot]

if len(bot_antirot) != 1:
    raise RuntimeError("GUARD_ANTIROT_POINT_MISSING: need exactly 1 concrete node at (MESH_SIZE,0,0); got "
                       + repr(len(bot_antirot)))

# ========== 11. 支座：柱底"铰接"（实体单元无转动自由度） ==========
Fixed(gnids=bot_uz_only, dof=[Dof.Uz])                   # 底面竖向支承（横向自由 → 泊松变形不受抑制）
Fixed(gnids=bot_antirot, dof=[Dof.Uz, Dof.Uy])           # 抗转动点：竖向支承 + 消除绕 Z 刚体转动
Fixed(gnids=bot_center,  dof=[Dof.Ux, Dof.Uy, Dof.Uz])   # 底面形心一点：水平定位，防刚体平移
# ★ 钢筋节点不施加任何约束（全部由 Embeded 跟随混凝土），避免与嵌入约束冲突

# ========== 12. 荷载工况（DL / LL 各自独立 LoadCase） ==========
lc_dl = LoadCase("DL")                                   # 恒载：自重（混凝土 + 钢筋全部单元）
lc_dl.add(Emload(geids=all_eids, value=G_ACC, dir=[0, 0, -1]))

lc_ll = LoadCase("LL")                                   # 活载：柱顶轴力 2000 kN（顶面均布面压）
lc_ll.add(Ebsload(esides=top_esides, value=P_TOP,
                  iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))

# ========== 13. 荷载步与分析（线性静力；含 Step_ALL 包络步） ==========
step_dl  = Step(name="Step_DL",  loadCases=[LoadCaseCombine(lid=lc_dl.id, coef=1.0)])
step_ll  = Step(name="Step_LL",  loadCases=[LoadCaseCombine(lid=lc_ll.id, coef=1.0)])
step_all = Step(name="Step_ALL", loadCases=[LoadCaseCombine(lid=lc_dl.id, coef=1.0),
                                            LoadCaseCombine(lid=lc_ll.id, coef=1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl, step_ll, step_all])   # 不传 setting = 线性静力

# ========== 14. ★ 指派当前分析任务（漏掉 → 算默认空分析「分析-1」，结果全 0） ==========
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)   # 动态取索引，勿硬编码
job = Job(name="Job_RCColumn", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 15. 收口（混合路线五步齐） ==========
FemModel.toViewer()           # 4 有限元模型可视化（有限元页面在此刷新）
FemModel.submitAndSolve()     # 5 模型检查 + 提交计算
