# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：圆柱面 TriPatch 离散面壳（结构（几何）路线，单面对象 + 三角面片表）
# 实测环境：PkpmCAE 本机 femesh；pypcae 2.1.0（last release 20261230）
# 本示例印证的配方与坑位（../../docs/ERRATA.md）：
#   ★#120 `SurfType.TriPatch` 已实机破解可施工（推翻 #97 的"不可施工"旧结论）：
#        一个面对象承载全部三角面片；数据 = 节点 + 边界线 + outer 边界回路
#        + `surf.patches`（节点 id 三元组表，构造后赋值属性写入）；
#        本例为"开口曲面"形态：外边界 = 底环弦线 + 顶环弦线 + 1 条竖向接缝（在
#        outer 中出现两次：去程接缝 + 底环一周 + 回程接缝 + 顶环一周）
#   #47  只作面/体边界的几何线不挂 sid（本例 97 条边界线均不挂截面）
# 路线: 结构（几何）；收口 = StruModel.toViewer() + StruModel.submitAndMesh()
# 模型描述: 开口圆柱面壳 R=10 m × H=20 m，Q235 壳 t=10 mm；
#   圆周按 15° 离散为 48 段（双环 96 节点），每条纹带 2 个三角面片（共 96 片），
#   1 条竖向接缝线；面对象仅 1 个（TriPatch），模型树呈现 96 节点/97 线/1 面。
# 网格: basicSize=1.0 m → 2016 节点 / 1920 单元（全四边形壳）
# 适用: 一切"软件无解析面原语"的开口壳面（自由曲面壳、异型幕墙、任意离散面）
# 单位制: SI（m / N / Pa）
# ============================================================================

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx
import math

clc()
MatDB.load()

# ========== 1. 参数（顶部常量，带单位注释） ==========
R = 10.0           # m，圆柱面半径
H = 20.0           # m，高度
T = 0.01           # m，壳厚（Q235 t=10mm）
N = 48             # 圆周离散段数（15°/段）
MESH = 1.0         # m，总体网格尺寸

# ========== 2. 材料与截面（面构件用 Surface 壳截面） ==========
setting = Setting()                     # 默认 m 制（SI）
mat = MatDB.assemble(name="Q235", iType=MaterialType.Steel,
                     iMark=SteelType.Q235, setting=setting)
sec_shell = Section("shell_t10", SectionType.Surface, SingleLayer(mid=mat.id, t=T))

# ========== 3. 节点：底环 N 个 + 顶环 N 个（同位置只建一个 Node） ==========
nb = []
nt = []
for i in range(N):
    th = 2.0 * math.pi * i / N
    x = R * math.cos(th)
    y = R * math.sin(th)
    nb.append(Node(x, y, 0.0))
    nt.append(Node(x, y, H))

# ========== 4. 线：1 条竖向接缝 + 底环 N 条弦 + 顶环 N 条弦 ==========
l_seam = Line(start=nt[0].id, end=nb[0].id)
l_cb = []
l_ct = []
for i in range(N):
    j = (i + 1) % N
    l_cb.append(Line(start=nb[i].id, end=nb[j].id).id)
    l_ct.append(Line(start=nt[i].id, end=nt[j].id).id)

# ========== 5. 面：单个 TriPatch 离散面 ==========
# outer = 接缝(去) + 底环一周 + 接缝(回) + 顶环一周（开口曲面的边界回路写法）
outer = [l_seam.id] + l_cb + [l_seam.id] + l_ct
s_cyl = Surf(outer=outer, type=SurfType.TriPatch, sid=sec_shell.id)
# 三角面片表：每条纹带 2 个三角形（patches 无构造形参，创建后直接赋值属性）
patches = []
for i in range(N):
    j = (i + 1) % N
    patches.append([nt[j].id, nt[i].id, nb[i].id])
    patches.append([nt[j].id, nb[i].id, nb[j].id])
s_cyl.patches = patches
Elset(name="cyl_tripatch", ids=[s_cyl.id])

# ========== 6. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH, beamSize=MESH,
                      wallSize=MESH, plateSize=MESH, densifyLevel=0),
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ========== 7. 收口（结构模型路线；求解由用户在界面提交，要脚本内算走混合路线，
#     见 ../mixed/cyl_shell_tripatch_mixed.py） ==========
StruModel.toViewer()
StruModel.submitAndMesh()

# ========== 验证要点（实测值取自 2026-10-16 PkpmCAE pypcae 2.1.0） ==========
# 构件计数（读 <项目>/pypcae/pypcae.stru）：节点 96、线 97（1 接缝 + 48 底弦 + 48 顶弦）、
#   面 1（iType=2 TriPatch，outer 98 条引用，patches 96 个三角形）、材料 1、截面 1；
# 网格：实测 2016 节点 / 1920 单元，全部四边形壳（周向 48 弦各分 2 段 × 竖向 20 层）；
#   单元节点坐标范围 x/y ∈ [-10,10]、z ∈ [0,20]，r ∈ [9.9786, 10.0]（弦中点内缩 = R·cos(3.75°)）；
# 日志：task-log「任务执行成功!」；
# ★ 与"整圆解析面"版（Surf(Cylinder)，2080 节点/2000 单元）的区别：本版几何本身是离散的
#   （弦线边界），与 pgm→CAE 导出离散化（角偏差/线偏差）产物同构；
# ★ patches 索引 = 节点 id（本例节点先建，id 从 0 连续编号，与 patches 下标一致）；
#   若模型中已有其他节点，patches 一律引用 .id 而非循环下标。
