# -*- coding: utf-8 -*-
# 示例：多层框架结构模型（StruModel，纯几何路线）—— 梁柱板构件 + 自动网格划分
# 路线：结构（几何）模型；收口 = StruModel.toViewer() + StruModel.submitAndMesh()
# 单位制：SI（m / N / Pa）
# 要点：① 构件必须挂截面 sid；② 网格设置必须写在 toViewer() 之前（否则静默无效）；
#       ③ normal 不得与杆轴平行；④ Plate 绕序右手螺旋向上
# 实测：PkpmCAE pypcae 2.1.0（last release 20261230），几何 + 自动网格全流程跑通（8.5 s）；
#       构件计数与网格规模见文末验证要点（见 ../../docs/ERRATA.md）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx

clc()

# ========== 1. 参数（顶部常量，带单位注释） ==========
BAY = 6.0           # m，开间
N_BAY = 2           # 开间数（X/Y 同）
FLOOR_H = 3.0       # m，层高
N_FLOOR = 3         # 层数
MESH_SIZE = 0.50    # m，全局网格尺寸（构件特征尺寸的 1/4~1/10）

# ========== 2-3. 材料与截面（标准牌号一律查库） ==========
MatDB.load()                            # 必须先加载材料库
setting = Setting()                     # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
col_sec  = Section("col500",   SectionType.Line,    Rectangle(mid=mat.id, b=0.5, h=0.5))
beam_sec = Section("beam300x600", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.6))
slab_sec = Section("slab120",  SectionType.Surface, SingleLayer(mid=mat.id, t=0.12))

# ========== 4. 节点（(N_BAY+1)^2 柱位 × (N_FLOOR+1) 层；同位置只建一个 Node） ==========
NP_SIDE = N_BAY + 1
NP = NP_SIDE * NP_SIDE                  # 每层节点数
nids = []
for iz in range(N_FLOOR + 1):
    for ix in range(NP_SIDE):
        for iy in range(NP_SIDE):
            nids.append(Node(ix * BAY, iy * BAY, iz * FLOOR_H).id)

def nid(ix, iy, iz):
    return nids[iz * NP + ix * NP_SIDE + iy]

# ========== 5. 构件（梁柱撑 / 楼板） ==========
cols, beams, plates = [], [], []
for iz in range(N_FLOOR):                                    # 柱（竖向）
    for ix in range(NP_SIDE):
        for iy in range(NP_SIDE):
            cols.append(BeamColumn(nids=[nid(ix, iy, iz), nid(ix, iy, iz + 1)],
                                   iMark=ComponentType.COLUMN, sid=col_sec.id,
                                   normal=[0, 1, 0]).id)
for iz in range(1, N_FLOOR + 1):                             # 梁（X 向 + Y 向）
    for ix in range(N_BAY):
        for iy in range(NP_SIDE):
            beams.append(BeamColumn(nids=[nid(ix, iy, iz), nid(ix + 1, iy, iz)],
                                    iMark=ComponentType.BEAM, sid=beam_sec.id,
                                    normal=[0, 1, 0]).id)     # X 向梁：法向取 Y
    for ix in range(NP_SIDE):
        for iy in range(N_BAY):
            beams.append(BeamColumn(nids=[nid(ix, iy, iz), nid(ix, iy + 1, iz)],
                                    iMark=ComponentType.BEAM, sid=beam_sec.id,
                                    normal=[1, 0, 0]).id)     # Y 向梁：法向取 X（不得与杆轴平行）
for iz in range(1, N_FLOOR + 1):                             # 楼板（绕序右手螺旋向上）
    for ix in range(N_BAY):
        for iy in range(N_BAY):
            plates.append(Plate(nids=[nid(ix, iy, iz), nid(ix + 1, iy, iz),
                                      nid(ix + 1, iy + 1, iz), nid(ix, iy + 1, iz)],
                                sid=slab_sec.id).id)

# ========== 7. 支座（底层柱脚固结） ==========
Fixed(gnids=[nid(ix, iy, 0) for ix in range(NP_SIDE) for iy in range(NP_SIDE)],
      dof=[Dof.All])

# ========== 7b. 网格设置（几何模型专属，★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE, beamSize=MESH_SIZE,
                      wallSize=MESH_SIZE, plateSize=MESH_SIZE, densifyLevel=0),
           toQuad="true")               # 板墙四边形主导（字符串，不是布尔值）

# ========== 11. 收口（结构模型路线） ==========
StruModel.toViewer()                    # 几何模型可视化（不可省；同时快照网格参数）
StruModel.submitAndMesh()               # 网格划分（成功不终止脚本；求解由用户在界面提交，
                                        #  需要"划网格后直接算"请走混合路线，见 stru_to_fem_mixed.py）

# ========== 验证要点（实测值取自 2026-10-12 PkpmCAE pypcae 2.1.0） ==========
# 构件计数（读 <项目>/pypcae/pypcae.stru 核对）：
#   节点 = (N_BAY+1)^2 × (N_FLOOR+1) = 9×4 = 36 ✓（实测 nodes=36）
#   柱 = 9×3 = 27；梁 = 2 向 × 2 跨 × 3 边 × 3 层 = 36 → 实测 components.felements = 63 ✓
#     （BeamColumn 构件落在 JSON 的 components.felements 里，不是 lines）
#   板 = 2×2×3 = 12 ✓（components.plates=12）；材料 1（C30）、截面 3、固定约束组 1
#   单位档：Setting() 默认 iTypeSI=0（自定义档，各单位取 0 档 = m/N/kg/Pa），C30 应为
#     E0=3.0e10 Pa、density=2500 kg/m3
# 网格（submitAndMesh 后）：实测 2019 节点 / 2322 单元（1728 个四边形壳 + 594 个两节点梁）；
#   pcaestru-mesh/UserMeshParameter.txt（GBK 编码）：*meshSize 0.5 0.5 0.5 0.5 0、
#   *meshGen 0（无实体 → Femesh）、*meshPattern sweepAndTMesh
# 日志标记（两套，别搞混）：
#   <项目>/task-log/<uuid后6位>.txt：@complete:sep-processor → @complete:femesh →
#     "已完成网格划分!" → 末尾"任务执行成功!"（失败为 @failure + "任务执行失败!"）
#   <安装目录>/resources/pserver.log（GBK）：save:begin/save:end → mesh:begin/mesh:end
#     → mesh-save:begin/mesh-save:end（失败为 mesh:failed）
# 界面：在几何模型页面执行本脚本会刷新视图；有限元页面执行不刷新（纯几何脚本）
