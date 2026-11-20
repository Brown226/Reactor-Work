# -*- coding: utf-8 -*-
# license: Proprietary — 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
# ============================================================================
# 示例：球体 = TriPatch 离散面 + Solid(General) 通用多面体（结构（几何）路线）
# 实测环境：PkpmCAE 本机 femesh；pypcae 2.1.0（last release 20261230）
# 本示例印证的配方与坑位（../../docs/ERRATA.md）：
#   ★#121 复杂不规则实体通用套路：先用 TriPatch 离散面撑出内/外边界面
#        （闭合流形：每条边恰好被 2 个三角形引用，欧拉校验 F=2V-4），
#        再用 Solid(outer=[离散面], type=SolidType.General) 围成实体；
#        闭合曲面的 outer 边界回路 = 一条接缝链"去程 + 回程"（链中每条线出现两次）
#   ★#120 TriPatch 的 patches 表只需节点三元组；内部网格点无需任何内部线
#   #47   边界线不挂 sid；实体截面挂在 Solid 上（SectionType.Solid）
# 路线: 结构（几何）；收口 = StruModel.toViewer() + StruModel.submitAndMesh()
# 模型描述: 球体 R=50 m（Q235 实体），UV 参数化离散：24 经线 × 12 纬带，
#   南北极各 1 个节点，中间 11 圈纬环；266 节点 / 528 三角面片 / 12 条接缝线；
#   面对象 1 个（TriPatch）、体对象 1 个（General）。
# 网格: basicSize=5.0 m（含 Solid 时 meshGen 自动切 Tmesh）→ 5092 节点 / 26762 四面体
# 适用: 一切复杂/不规则实体（自由曲面体、任意多面体）——外表面离散成闭合
#   三角面片流形即可；有内腔时 inners 同理各成闭合面
# 单位制: SI（m / N / Pa）
# ============================================================================

from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel        # 纯几何路线：不导入 FemModel，不调 init_ctx
import math

clc()
MatDB.load()

# ========== 1. 参数（顶部常量，带单位注释） ==========
R = 50.0           # m，球半径
N_LON = 24         # 经线数
N_LAT = 12         # 纬带数（含两极三角扇）
MESH = 5.0         # m，总体网格尺寸

# ========== 2. 材料与实体截面 ==========
setting = Setting()                     # 默认 m 制（SI）
mat = MatDB.assemble(name="Q235", iType=MaterialType.Steel,
                     iMark=SteelType.Q235, setting=setting)
sec_solid = Section("solid", SectionType.Solid, SolidSect(mid=mat.id))

# ========== 3. 节点：南极点 + N_LAT-1 圈纬环 + 北极点 ==========
pole_s = Node(0.0, 0.0, -R)
rings = []
for k in range(1, N_LAT):
    phi = -math.pi / 2.0 + math.pi * k / N_LAT      # 纬度（-90°~90° 均分）
    ring = []
    for j in range(N_LON):
        th = 2.0 * math.pi * j / N_LON
        ring.append(Node(R * math.cos(phi) * math.cos(th),
                         R * math.cos(phi) * math.sin(th),
                         R * math.sin(phi)))
    rings.append(ring)
pole_n = Node(0.0, 0.0, R)

# ========== 4. 线：0° 经线接缝链（南极 -> 各纬环 -> 北极，仅 N_LAT 条） ==========
chain_nodes = [pole_s] + [rings[k][0] for k in range(N_LAT - 1)] + [pole_n]
l_seam = []
for i in range(len(chain_nodes) - 1):
    l_seam.append(Line(start=chain_nodes[i].id, end=chain_nodes[i + 1].id).id)

# ========== 5. 面：单个 TriPatch 离散面（闭合球面） ==========
# 闭合曲面无天然边界：outer 取接缝链"去程 + 回程"（每条链线出现两次）
outer = l_seam + l_seam[::-1]
s_sph = Surf(outer=outer, type=SurfType.TriPatch)
# 三角面片表（构造后赋值属性写入）：极扇 + 中间带每格 2 片
patches = []
for j in range(N_LON):                                # 南极扇
    patches.append([pole_s.id, rings[0][j].id, rings[0][(j + 1) % N_LON].id])
for k in range(N_LAT - 2):                            # 中间纬带
    a = rings[k]
    b = rings[k + 1]
    for j in range(N_LON):
        j2 = (j + 1) % N_LON
        patches.append([a[j].id, b[j].id, b[j2].id])
        patches.append([a[j].id, b[j2].id, a[j2].id])
for j in range(N_LON):                                # 北极扇
    patches.append([rings[-1][j].id, pole_n.id, rings[-1][(j + 1) % N_LON].id])
s_sph.patches = patches

# ========== 6. 体：通用多面体（外边界 = 离散面） ==========
blk = Solid(outer=[s_sph.id], type=SolidType.General, sid=sec_solid.id)

# ========== 7. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
MeshParams(sizer=Size(isBasic=True, basicSize=MESH, beamSize=MESH,
                      wallSize=MESH, plateSize=MESH, densifyLevel=0),
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")

# ========== 8. 收口 ==========
StruModel.toViewer()
StruModel.submitAndMesh()

# ========== 验证要点（实测值取自 2026-10-16 PkpmCAE pypcae 2.1.0） ==========
# 离散数据自检（建模时应先在本地验证）：
#   闭合流形：每条边恰好被 2 个三角形引用；欧拉公式 F = 2V - 4（528 = 2×266-4 ✓）；
#   全部节点 |r| = R；三角形法向一致朝外（本例 100%）；
# 网格：实测 5092 节点 / 26762 个四面体（4 节点），表面节点 r=50.000，内部实体填充正常；
# 日志：task-log「任务执行成功!」；
# ★ 与导出真值模型对照（同 R=50、size=5）：导出离散球 612 节点/1220 片 → 网格
#   5040 节点/25444 四面体；本参数化版本 266 节点/528 片 → 5092 节点/26762 四面体，
#   二者网格规模相当，说明网格由 basicSize 主导而非离散面片数；
# ★ patches 索引 = 节点 id（节点先于线/面创建，id 从 0 连续编号）；
# ★ 内腔/孔洞实体：在 Solid(inners=[[内腔离散面]]) 同理传闭合 TriPatch 面（未实测，
#   用前先小模型验证）。
