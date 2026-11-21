# -*- coding: utf-8 -*-
# 示例：通用几何模型（StruModel）—— 圆柱 + 圆锥组合体（Line → Surf → Solid 拓扑）+ 自动网格
# 路线：结构（几何）；收口 = StruModel.toViewer() + StruModel.submitAndMesh()
# 单位制：SI（m / N / Pa）
# 要点：① 圆柱/圆锥面用 bottom/top（**不传 outer**）；② 圆锥面的 top 是**顶点节点号**，
#       圆柱面的 top 是**线构件号**；③ 圆弧 Line 必须同时传 center 与 kp（漏传静默变直线）；
#       ④ Solid.outer 传**面构件 id**；⑤ 体构件挂 SectionType.Solid 截面；
#       ⑥ 网格设置必须写在 StruModel.toViewer() 之前（含 Solid 时 meshGen 自动置 1 = Tmesh）
# 实测：PkpmCAE pypcae 2.1.0（last release 20261230），几何 + Tmesh 实体网格跑通（9.7 s）；
#       725 个四面体、单元体积合计 2.0520 m3（本模型是**半**圆柱+**半**圆锥，见文末验证要点）
# ★ 注意：本例的圆弧 Line 起终点是 (R,0,0) 与 (-R,0,0)，即**半圆**，加弦线围合后得到的是
#   半 bodies（y>=0 或 y<=0 一侧）；要建**整**圆柱/整球，圆弧线应"起点=终点"成整圆
#   （见 ../mixed/sphere_solid_selfweight.py 的球体做法）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx

clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
R = 1.0            # m，圆柱半径
H1 = 1.0           # m，圆柱顶标高（圆柱高）
H2 = 2.0           # m，圆锥顶点标高
MESH_SIZE = 0.25   # m，全局网格尺寸（≈ 特征尺寸 R 的 1/4）

# ========== 2-3. 材料与截面（体构件用 Solid 截面） ==========
MatDB.load()
setting = Setting()                     # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
solid_sec = Section("solid", SectionType.Solid, SolidSect(mid=mat.id))

# ========== 4. 节点（圆心 / 圆周端点 / 顶点；同位置只建一个 Node） ==========
n_bot_c = Node(0.0, 0.0, 0.0)           # 底面圆心
n_bot_1 = Node(R, 0.0, 0.0)             # 底圆端点 1
n_bot_2 = Node(-R, 0.0, 0.0)            # 底圆端点 2
n_top_c = Node(0.0, 0.0, H1)            # 顶面圆心
n_top_1 = Node(R, 0.0, H1)              # 顶圆端点 1
n_top_2 = Node(-R, 0.0, H1)             # 顶圆端点 2
n_apex  = Node(0.0, 0.0, H2)            # 圆锥顶点

# ========== 5a. 几何线（圆弧必须同时给 center 与 kp） ==========
w_bot_arc = Line(start=n_bot_1.id, end=n_bot_2.id, center=n_bot_c.id,
                 kp=n_apex.id, type=LineType.Arc).id       # 底圆（半圆弧 1）
w_top_arc = Line(start=n_top_1.id, end=n_top_2.id, center=n_top_c.id,
                 kp=n_apex.id, type=LineType.Arc).id       # 顶圆（半圆弧 2）
w_bot_chord = Line(start=n_bot_2.id, end=n_bot_1.id).id    # 底面弦线（与弧围成底面）
w_cone_1 = Line(start=n_top_2.id, end=n_apex.id).id        # 锥面母线 1
w_cone_2 = Line(start=n_top_1.id, end=n_apex.id).id        # 锥面母线 2
w_cyl_1 = Line(start=n_bot_2.id, end=n_top_2.id).id        # 柱面母线 1
w_cyl_2 = Line(start=n_bot_1.id, end=n_top_1.id).id        # 柱面母线 2

# ========== 5b. 几何面（圆柱/圆锥面用 bottom/top；平面用 outer 围合） ==========
s_cyl  = Surf(bottom=w_bot_arc, top=w_top_arc, type=SurfType.Cylinder).id    # 圆柱面（top 是线 id）
s_cone = Surf(bottom=w_top_arc, top=n_apex.id, type=SurfType.Cone).id        # 圆锥面（top 是顶点节点 id）
s_bot  = Surf(outer=[w_bot_arc, w_bot_chord], type=SurfType.Plane).id        # 底面（平面）
s_side = Surf(outer=[w_bot_chord, w_cyl_1, w_cone_1, w_cone_2, w_cyl_2],
              type=SurfType.Plane).id                                        # 侧面（母线围合）

# ========== 5c. 几何体（outer 传面构件 id） ==========
blk = Solid(outer=[s_cyl, s_cone, s_bot, s_side],
            type=SolidType.General, sid=solid_sec.id).id

# ========== 7b. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="tMeshOnly",      # 实体为主 → 四面体主导
           toQuad="true")                # 字符串，不是布尔值

# ========== 9. 收口（结构模型路线） ==========
StruModel.toViewer()                     # 几何模型可视化（含 Solid → meshGen 自动置 1 = Tmesh）
StruModel.submitAndMesh()                # 自动划分网格（成功不终止脚本；求解由用户在界面提交，
                                         #  需要"划网格后直接算"请走混合路线，见 stru_to_fem_mixed.py）

# ========== 验证要点（实测值取自 2026-10-12 PkpmCAE pypcae 2.1.0） ==========
# 构件计数（读 <项目>/pypcae/pypcae.stru）：节点 7、线 7、面 4（圆柱面/圆锥面/底面/侧面）、
#   实体 1、材料 1（C30）、截面 1（SolidSect）
# ★ 体积核对（本模型是**半**body，圆弧为半圆 + 弦线围合）：
#   V_半 = [π·R2·H1 + (1/3)·π·R2·(H2-H1)] / 2 = (π + π/3)/2 = 2.0944 m3
#   实测单元体积合计 = 2.0520 m3 → 偏差 -2.0%（曲面离散；加密网格应趋近 2.0944）
#   ⚠ 若按整圆柱+整圆锥算 V = π·R2·H1 + (1/3)·π·R2·(H2-H1) = 4.1888 m3，会与实测差一倍——
#     本脚本的几何确实是半 bodies，这是原示例的建模方式，不是网格丢了一半
#   （体积核对方法：读 pcaestru-mesh/fe_modelSource.json 的 nodes + 四面体 cells，
#     逐个 V=|det(a,b,c)|/6 求和；整球版实测偏差 -2.48%，见 ../mixed/sphere_solid_selfweight.py）
# 网格：实测 206 节点 / 725 个四面体；UserMeshParameter.txt（GBK）：*meshSize 0.25、
#   *meshGen **1**（含 Solid 自动切 Tmesh ✓）、*meshPattern tMeshOnly
# 日志标记：task-log 里是 @complete:tmesh → @complete:femesh → "任务执行成功!"；
#   mesh:end / mesh-save:end 在安装目录 resources/pserver.log（GBK）里，不在项目 task-log
# 界面：几何模型页面执行会刷新视图；本脚本不求解（要求解走混合路线）
