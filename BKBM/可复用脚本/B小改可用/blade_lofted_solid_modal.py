# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：59 m 风电叶片气动外形实体 + 模态（混合路线 · 三角面片放样拼 Solid 的通用配方）
# 实测环境：PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0（last release 20261230）
# 实测结果：706 个平面面片 / 1072 条边线 / 368 个几何节点 → 拼成单个 Solid
#           自动四面体网格 7615 节点 / 28948 单元 → 模态 10 阶已出结果
# 本示例印证的配方与坑位（../docs/ERRATA.md）：
#   ★#98 三角面片拼闭合实体的通用配方（平台无放样/直纹/Coons/NURBS 原语，自由曲面唯一出路）：
#        每条线恰好被两个面引用；节点跨剖面/跨环必须复用同一 Node 对象；端盖用整圈轮廓线
#        规模实测：11 m 验证算例 222 面片 → 5442 节点/26597 四面体；本例 706 面片 → 7615/28948
#   ★#97 SurfType.TriPatch 文档不可施工 ⇒ 一律用 SurfType.Plane + 3 条边线（三角形必共面）
#   ★#100 basicSize ≠ 实际特征尺寸：脚本设 0.35 m，日志回报"总体单元特征尺寸 0.203 m"
#        （超薄区自行加密）；且单元数由薄端主导而非长度 —— 59 m 叶片(28948) 与 11 m 算例(26597) 同量级
#   ★#99 实体单元只有各向同性本构 ↔ 层合板 E1/E2/G12/ν12 本质冲突：本例取各向同性等效值，
#        已在下方材料段注释与交付包标注 [估算]，并说明与取向相关
#   ★#101 纯模态的任务指派自查：比对待求阶数 vs nModal（脚本设 10、结果文件为 10 阶 → 通过）；
#        ⛔ 静力那条"看 61_LoadStep.inp 步名"的判据对纯模态不适用（模态本就没有荷载步）
#   #21(铁律) 文档驱动建模：离散点之间的过渡函数（扭转 (1-xi)^2.2、预弯 xi^2、弦长钟形分布）
#        全部作为「假设」列在下方，并须附「参数溯源表」交付
# ⚠️ 翼型厚度分布取 NACA 四位翼型公式按各剖面 t/c 缩放（文档只给翼型族名与相对厚度）→ 量值 [估算]
# ============================================================================
# -*- coding: utf-8 -*-
# 分析类型: 模态分析（叶根固支）
# 模型描述: WTB-59.0-II 型 59.0 m 级 2.0 MW 陆上风电叶片 —— 气动外形实体（几何体 -> 自动网格 -> 有限元 -> 模态）
# 路线: 混合路线 init_ctx(mode=ExecutionMode.MIXED)
# 单位制: SI (m, N, Pa, kg/m3)
# 用户输入参数: BLADE_LEN=59.0 m 叶片长度; CHORD_MAX=3.50 m 最大弦长; ROOT_R=1.70 m 叶根半径;
#              TWIST_ROOT=22 deg / TWIST_TIP=0.5 deg; PREBEND_TIP=1.50 m; MESH_SIZE=0.35 m
# 假设: (1) 气动外形实体 = 由翼型剖面沿展向放样得到的实心体（未建内部空腔/主梁帽/腹板，按用户要求"仅气动外形实体"）;
#       (2) 翼型厚度分布取 NACA 四位翼型厚度公式按各剖面 t/c 缩放，小弯度 2% 弦长（文献未给 DU/NACA 具体型线坐标，量值[估算]）;
#       (3) 弦长分布按文档"根部小-中部大-尖部小"钟形取值，最大弦长 3.50 m 位于 0.20R，叶尖 0.35 m;
#       (4) 扭转角由 22 deg（根）按 (1-xi)^2.2 过渡至 0.5 deg（尖）; 预弯 1.5 m 按 xi^2 分布;
#       (5) 材料为玻/碳混编层合板的各向同性等效值（E1/E2/G12/nu12/rho 见材料段注释，量值[估算]）

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx
import math

init_ctx(mode=ExecutionMode.MIXED)
clc()

# ========== 1. 参数定义 ==========
BLADE_LEN = 59.0        # m, 叶片总长度（展向, 沿 X 轴）
ROOT_R = 1.70                    # m, 叶根圆截面半径 (根部直径 3.40 m)
ROOT_CYL_END = 1.50              # m, 叶根等直径圆柱段末端
TRANS_END = 6.00                 # m, 圆截面过渡段末端（此后为翼型剖面）
CHORD_ROOT = 3.40                # m, 叶根弦长（= 根部圆直径）
CHORD_MAX = 3.50                 # m, 最大弦长（位于 0.20R）
CHORD_TIP = 0.35                 # m, 叶尖弦长
XI_MAX = 0.20                    # -, 最大弦长所在相对展向位置
TWIST_ROOT = 22.0                # deg, 叶根扭角
TWIST_TIP = 0.5                  # deg, 叶尖扭角
PREBEND_TIP = 1.50               # m, 叶尖静态预弯量
CHORD_REF = 0.35                 # -, 剖面扭转参考点（35% 弦长, 近似气动中心）
CAMBER_M = 0.02                  # -, 翼型最大弯度/弦长
CAMBER_P = 0.40                  # -, 翼型最大弯度位置/弦长
U_LE = 0.002                     # -, 前缘截断弦向位置（钝前缘, 避免零厚度单元）
U_TE = 0.998                     # -, 后缘截断弦向位置
N_SIDE = 8               # -, 单侧弦向点数（每剖面轮廓点 = 2*N_SIDE）
MESH_SIZE = 0.35             # m, 全局网格尺寸

# 展向剖面位置（分段布置：叶根圆柱段 / 圆截面过渡段 / 翼型段, 翼型段向叶尖加密）
R_LIST = []
_r_segs = [(0.0, ROOT_CYL_END, 2), (ROOT_CYL_END, TRANS_END, 6), (TRANS_END, BLADE_LEN, 14)]
for _a, _b, _n in _r_segs:
    for _k in range(_n):
        _t = _k / float(_n)
        if _b >= BLADE_LEN:
            _t = math.sin(0.5 * math.pi * _t)
        R_LIST.append(_a + (_b - _a) * _t)
R_LIST.append(BLADE_LEN)
NS = len(R_LIST)                 # 剖面数
NP = 2 * N_SIDE                  # 每剖面轮廓点数

# ========== 2-3. 材料与截面 ==========
# 玻纤/碳纤混合增强层合板等效工程常数[估算]：E1=45 GPa, E2=13 GPa, G12=4.5 GPa, nu12=0.28, rho=1900 kg/m3
# 实体单元为各向同性本构，此处取展向主导的等效弹性模量 E1 作为 E0（等效假定[估算]，详见交付说明）
mat = Material(name="BladeLaminate", iType=MaterialType.Custom,
               iModel=MaterialModel.Elastic,
               E0=4.5e10, poisson=0.28, density=1900.0, expansion=3.0e-5)
sec_solid = Section(name="BladeSolid", type=SectionType.Solid, sub=SolidSect(mid=mat.id))

# ========== 4. 截面型线函数 ==========
def yt_norm(u):
    # NACA 四位翼型厚度分布（返回半厚度/弦长, t/c=1 时归一）
    return 5.0 * (0.2969 * math.sqrt(u) - 0.1260 * u - 0.3516 * u * u
                  + 0.2843 * u * u * u - 0.1015 * u * u * u * u)

def yc_norm(u):
    # NACA 四位翼型中弧线（返回弯度/弦长）
    if u < CAMBER_P:
        return CAMBER_M * (2.0 * CAMBER_P * u - u * u) / (CAMBER_P * CAMBER_P)
    return CAMBER_M * ((1.0 - 2.0 * CAMBER_P) + 2.0 * CAMBER_P * u - u * u) / ((1.0 - CAMBER_P) ** 2)

def chord_of(xi):
    if xi < XI_MAX:
        return CHORD_MAX - (CHORD_MAX - CHORD_ROOT) * ((XI_MAX - xi) / XI_MAX)
    return CHORD_TIP + (CHORD_MAX - CHORD_TIP) * ((1.0 - xi) / (1.0 - XI_MAX)) ** 1.5

def tc_of(xi):
    if xi <= 0.10:
        return 0.40
    if xi <= 0.30:
        return 0.40 + (0.35 - 0.40) * (xi - 0.10) / 0.20
    if xi <= 0.55:
        return 0.35 + (0.25 - 0.35) * (xi - 0.30) / 0.25
    if xi <= 0.80:
        return 0.25 + (0.18 - 0.25) * (xi - 0.55) / 0.25
    return 0.18 + (0.12 - 0.18) * (xi - 0.80) / 0.20

def twist_of(xi):
    return TWIST_TIP + (TWIST_ROOT - TWIST_TIP) * (1.0 - xi) ** 2.2

def prebend_of(xi):
    return PREBEND_TIP * xi * xi

U_SAMP = []
for _k in range(N_SIDE):
    _t = _k / float(N_SIDE - 1)
    U_SAMP.append(U_LE + (U_TE - U_LE) * 0.5 * (1.0 - math.cos(math.pi * _t)))

def airfoil_loc(c, tc):
    # 钝前缘/钝后缘翼型剖面轮廓（局部坐标: 弦向 xi_c, 厚度向 eta），顺序 = 上表面 LE->TE, 下表面 TE->LE
    pts = []
    for _u in U_SAMP:
        _h = tc * c * yt_norm(_u)
        _c = c * yc_norm(_u)
        pts.append((c * (_u - CHORD_REF), _c + _h))
    for _u in reversed(U_SAMP):
        _h = tc * c * yt_norm(_u)
        _c = c * yc_norm(_u)
        pts.append((c * (_u - CHORD_REF), _c - _h))
    return pts

def circle_loc(rad):
    pts = []
    for _i in range(NP):
        _phi = math.pi - 2.0 * math.pi * _i / float(NP)
        pts.append((rad * math.cos(_phi), rad * math.sin(_phi)))
    return pts

def blend_beta(r):
    if r <= ROOT_CYL_END:
        return 0.0
    if r >= TRANS_END:
        return 1.0
    _t = (r - ROOT_CYL_END) / (TRANS_END - ROOT_CYL_END)
    return _t * _t * (3.0 - 2.0 * _t)

# ========== 5. 节点 ==========
NODES = []
for _r in R_LIST:
    _xi = _r / BLADE_LEN
    _c = chord_of(_xi)
    _tc = tc_of(_xi)
    _th = math.radians(twist_of(_xi))
    _zb = prebend_of(_xi)
    if _r <= ROOT_CYL_END:
        _loc = circle_loc(ROOT_R)
    else:
        _beta = blend_beta(_r)
        _loc_a = airfoil_loc(_c, _tc)
        _loc_c = circle_loc(ROOT_R)
        _loc = []
        for _i in range(NP):
            _loc.append((_loc_c[_i][0] + _beta * (_loc_a[_i][0] - _loc_c[_i][0]),
                         _loc_c[_i][1] + _beta * (_loc_a[_i][1] - _loc_c[_i][1])))
    _row = []
    for _i in range(NP):
        _p = _loc[_i]
        _eta = _p[0]
        _zeta = _p[1]
        _y = _eta * math.cos(_th) - _zeta * math.sin(_th)
        _z = _zb + _eta * math.sin(_th) + _zeta * math.cos(_th)
        _row.append(Node(_r, _y, _z))
    NODES.append(_row)

# ========== 6. 几何线 ==========
L_SPAN = []      # [s][i] 展向棱线: NODES[s][i] -> NODES[s+1][i]
L_CIRC = []      # [s][i] 剖面环线: NODES[s][i] -> NODES[s][i+1]
L_DIAG = []      # [s][i] 对角棱线: NODES[s][i] -> NODES[s+1][i+1]
for _s in range(NS):
    _circ = []
    for _i in range(NP):
        _j = (_i + 1) % NP
        _circ.append(Line(start=NODES[_s][_i].id, end=NODES[_s][_j].id).id)
    L_CIRC.append(_circ)
for _s in range(NS - 1):
    _span = []
    _diag = []
    for _i in range(NP):
        _j = (_i + 1) % NP
        _span.append(Line(start=NODES[_s][_i].id, end=NODES[_s + 1][_i].id).id)
        _diag.append(Line(start=NODES[_s][_i].id, end=NODES[_s + 1][_j].id).id)
    L_SPAN.append(_span)
    L_DIAG.append(_diag)

# ========== 7. 几何面（三角面片, 三角形必共面）+ 几何体 ==========
FACES = []
for _s in range(NS - 1):
    for _i in range(NP):
        _j = (_i + 1) % NP
        FACES.append(Surf(outer=[L_CIRC[_s][_i], L_SPAN[_s][_j], L_DIAG[_s][_i]],
                          type=SurfType.Plane).id)
        FACES.append(Surf(outer=[L_DIAG[_s][_i], L_CIRC[_s + 1][_i], L_SPAN[_s][_i]],
                          type=SurfType.Plane).id)
CAP = [Surf(outer=L_CIRC[0], type=SurfType.Plane).id,
       Surf(outer=L_CIRC[NS - 1], type=SurfType.Plane).id]
blade = Solid(outer=FACES + CAP, type=SolidType.General, sid=sec_solid.id).id

# ========== 8. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="tMeshOnly", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ========== 9. 几何 -> 网格 -> 有限元 ==========
StruModel.toViewer()
StruModel.submitAndMesh()
FemModel.fromViewer()

# ========== 10. 支座（叶根端面固支） ==========
TOL = 1.0e-6
ROOT_NIDS = [n.id for n in Node.all() if abs(n.x) < TOL]
Fixed(gnids=ROOT_NIDS, dof=[Dof.All])

# ========== 11. 分析（模态, 叶根固支） ==========
ANALY_NAME = "ModalAnalysis"
Analy(ANALY_NAME, setting=AnalySetting(anaType=AnaType.MODAL, nModal=10))
MAIN_IDX = [a.name for a in Analy.all()].index(ANALY_NAME)
job = Job(name="Job_Modal", main=MAIN_IDX)
JobManager(main=MAIN_IDX, pre=job.pre, uid=job.uid, jobs=[job])

# ========== 12. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()
