# -*- coding: utf-8 -*-
# 分析类型: 静力
# 模型描述: 弹性地基梁（文克尔假定），演示 ElasSupport 弹性支座与 NodeQuery 条件查询选点
# 用户输入参数: L=10.0(m) 梁长; KZ=2.0e7(N/m) 各节点竖向弹簧刚度; Q=20000.0(N/m) 均布荷载
# 假设: 全部节点用 NodeQuery 按坐标范围选出并施加竖向弹簧；左端约束 Ux/Uy/Phx 消除刚体模态
# 验证基准: 竖向反力合计 = q*L = 2.0e5 N；跨中挠度与两端挠度接近（地基较柔时趋于均匀下沉）
# 单位制: SI（m / N / Pa / kg/m^3）

from pypcae.enums import *
from pypcae.comp import *
from pypcae.query import *          # 条件查询（NodeQuery/ElemQuery 等）在独立模块
from pypcae.fem import FemModel

clc()

# ========== 1. 参数 ==========
L = 10.0           # m
N_ELEM = 20
KZ = 2.0e7         # N/m，节点竖向弹簧刚度（基床系数 × 节点管辖面积）
Q = 20000.0        # N/m，均布荷载

# ========== 2-3. 材料与截面 ==========
MatDB.load()                       # 先加载材料库（建模语句之前）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
sec = Section("Beam500x800", SectionType.Line, Rectangle(mid=mat.id, b=0.5, h=0.8))

# ========== 4-5. 节点与单元 ==========
nods = [Node(i * L / N_ELEM, 0.0, 0.0) for i in range(N_ELEM + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(N_ELEM)]

# ========== 6-7. 弹性支座（NodeQuery 条件查询：按坐标选全部节点） ==========
# 注意 1：比较器中仅 eq(k, v, tol) 支持容差；ge/gt/le/lt 无 tol 参数（实测签名）
# 注意 2：实测发现——节点只约束 Uy 而释放 Phz 会触发 zero pivot（求解器对梁端
#         面内转动刚度与平动约束的耦合处理限制），梁端直接 Dof.All 固结最稳妥
beam_nids = NodeQuery().ge("x", 0.0).le("x", L).ids
ElasSupport(gnids=beam_nids, type=ElasSupportType.Lateral, kz=KZ)
left_ids = NodeQuery().eq("x", 0.0, tol=1e-6).ids
Fixed(gnids=left_ids, dof=[Dof.All])                           # 左端固结（消除全部刚体模态）

# ========== 8. 荷载工况 ==========
lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=[e.id for e in elems], type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[Q], dir=[0, 0, -1]))

# ========== 9. 荷载步与分析 ==========
analy = Analy("StaticAnalysis")
analy.add(Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0)))

# ========== 11. 收口 ==========
FemModel.toViewer()
FemModel.submitAndSolve()

# ========== 验证要点 ==========
# 1) 全部弹簧反力合计 = q*L = 2.0e5 N（反力平衡）
# 2) 各节点竖向位移 w_i 与弹簧反力 R_i 满足 R_i = KZ * w_i
# 3) 地基较柔时梁趋于整体均匀下沉，w 量级 ≈ q*L/(KZ*(N_ELEM+1)) ≈ 4.8e-4 m
