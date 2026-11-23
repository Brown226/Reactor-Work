# 枚举速查（结构 / 混合路线） — 参考文档


> 枚举值摘自《PyPCAE 用户帮助手册》（内置副本 `../manual/README.md` §三.2）；
> `ExecutionMode` 的数值依 pypcae 源码标注。不确定时用平台 `list_*` 工具实时核对，
> 或用 `../scripts/manual_search.py --enum <类名>` 检索手册原文。
> **本技能高频枚举**：`ExecutionMode`（执行模式）、`ComponentType`（构件类型）、
> `LineType`/`SurfType`/`SolidType`（几何类型）、`MeshType`（局部网格）、`FixedType`（含线约束）。

## 脚本控制（执行模式）

```text
ExecutionMode: DEFAULT    = 1   # 默认值：几何脚本、有限元脚本独立执行
                                #   （首次调用模型类函数即锁定为 STRUONLY 或 FEMONLY）
               STRUONLY   = 2   # 仅执行几何脚本
               FEMONLY    = 3   # 仅执行有限元脚本
               MIXED      = 4   # 几何脚本 + 有限元脚本共同执行（混合流程必须显式设置）
```

> 用法：`from pypcae.base import init_ctx` → `init_ctx(mode=ExecutionMode.MIXED)`，
> 位置在全部 import 之后、`clc()` 之前；形参名固定为 `mode`，取值必须用枚举；
> ★ **手册 2026-10-26 版明确：参数必须关键字传入**（`init_ctx(mode=ExecutionMode.MIXED)`，位置传入不允许）。
> 缺省该调用时**不支持**几何+有限元脚本共同执行（数值 1/2/3/4 为 pypcae 源码实测）。
> 本技能两条路线（结构 / 混合）与混合时序见 `stru_model.md`。

## 构件与几何（结构模型 StruModel）

```text
ComponentType: BEAM / COLUMN / BRACE / WALL / PLATE / SOLID / LINE / SURF / RIGID
               / TRUSS / SUPPORT / CABLE / BEAM_REBAR / COLUMN_REBAR / WALLBC_REBAR
               / BEAM_STEEL / COLUMN_STEEL / BRACE_STEEL
               # BeamColumn.iMark：梁/柱/撑/墙/楼板/体构件/线构件/面构件/刚臂/桁架
               #   /减隔震构件/拉索/梁柱墙配筋/型钢
LineType: Straight / Circle / Arc            # Line.type；Arc/Circle 必须同时传 center 与 kp，
                                             #   漏传任一会被静默改回 Straight（直线）
SurfType: Plane / Cylinder / Cone / TriPatch / Crown / Ring
                                             # Surf.type；圆柱/圆锥/球冠/球环面用 bottom/top/center，
                                             #   不传 outer（outer 只用于 Plane/TriPatch）
                                             # ★ TriPatch 已实机破解可用（2026-10-16，ERRATA #120~#122）：outer=边界线回路 + 构造后赋值 patches 面片表；
                                             #    备选：Plane + 3 条边线逐片拼接（#98）
SolidType: General                           # Solid.type（通用多面体）
MeshType: Size / Divisions                   # MeshSetting.iType（按网格尺寸 / 按分段数）
                                             # ⚠️ 两者对整圆线均不生效 → 周向分段不可控（#85）
```

> 构件用法与硬约束（`Wall` 角点顺序、`Plate` 右手螺旋绕序、`Surf` 引用线 id、`normal` 不得与
> 杆轴平行）见 `stru_model.md`；网格设置见 `mesh.md`。

### ★ 几何面原语的能力边界（新建任何几何 / 混合模型前先对照这张表；2026-10-15 实测）

| 目标曲面 | 可用原语 | 结论 |
|---|---|---|
| 平面多边形（3~N 边，各边共面闭环） | `SurfType.Plane`（`outer` 传边线闭环） | ✅ 直接可用（`outer` 边序无需首尾严格相接，但必须闭合同面） |
| 圆柱 / 圆台（**含整圆回转面**） | `SurfType.Cylinder`（`bottom`+`top` 传线 id） | ✅ 直接可用（★ 整圆线也可，ERRATA #84 **更正**旧结论） |
| 圆锥 | `SurfType.Cone`（`bottom` 传线 id、`top` 传**顶点节点 id**） | ✅ 直接可用 |
| 球面 / 球环面 | `SurfType.Crown` / `Ring` | ✅ 直接可用（整球配方见 ERRATA #52） |
| **水平环面**（同标高、内外两个整圆） | ★ `SurfType.Plane` + `outer=[外整圆]` + `inners=[[内整圆]]` | ✅ 实测 36/58 单元；⛔ **不能用 `Cylinder` 拼**（报 `**Error:边界点夹角有错-2` 且 **0 单元**，#84） |
| **三角面片离散面** | `SurfType.TriPatch` | ✅ **已实机破解可用**（2026-10-16，#120~#122）：`outer` 传边界线回路（闭合面 = 接缝链去程+回程）+ 构造后赋值 `surf.patches=[[n1,n2,n3],...]`；一个面承载全部三角面片。配方见 `stru_model.md` §5；备选 `Plane` + 3 条边线逐片拼接（#98） |
| **一般放样面 / 直纹面 / Coons 面 / NURBS 曲面** | **无** | ❌ **必须离散成三角面片**（配方见 `stru_model.md` §5「三角面片拼闭合实体」） |
| 翼型 / 船体 / 机翼 / 风机叶片 / 双曲屋面 / 蜗壳 / 拱坝 / 任意"沿路径扫掠+变截面+扭转"实体 | 无 | ❌ 同上；★ **选路线前先看这条**——见路由技能 `pypcae-modeling-router` 的路线判据 |

**推论**：凡不是平面 / 回转面 / 球面的曲面，唯一出路是**三角面片离散**
（实测规模上限：单个 `Solid` 挂 **706 个平面面片 / 1072 条边线**，自动四面体网格跑通，#98）。

## 材料

```text
MaterialType: Custom / Concrete / Steel / Rebar
ConcreteType: Custom / C15 / C20 / C25 / C30 / C35 / C40 / C45 / C50 / C55 / C60
              / C65 / C70 / C75 / C80
SteelType: Custom / Q235 / Q345 / Q355 / Q345GJ / Q390 / Q390GJ / Q420 / Q420GJ
           / Q460 / Q460GJ
RebarType: Custom / HPB300 / HRB335 / HRBF335 / HRB400 / HRBF400 / HRB500
           / HRBF500 / HRB600 / HRB635 / RRB400 / CRB550 / CRB600H / HTRB600
           / HTRB630 / SST1960
MaterialModel: Elastic / MetalPlastic / ConcretePlasticDamage / ConcreteDamage
               / ConcreteGuoZhang / ConcreteMander / ConcreteCode / ConcreteHLH
               / GeoMohrCoulomb / JohnsonCook / Neohookean / hyperfoam
MatDampType: NoDamping / Rayleigh / DampingRatio
```

## 截面

```text
SectionType: Line / Surface / Solid
ShapeType: SOLID / RECTANGLE / CIRCLE / BOX / ISHAPE / CROSSING / TUBE / TRAPEZOID
           / LSHAPE / TSHAPE / WELDEDBOXO / SINGLELAYER / ONECELL / TWOCELL
           / BSTF / CUSTOM
# 注：结构模型相关枚举见上方「构件与几何」节；脚本执行模式见上方「脚本控制」节。
```

## 单元

```text
ElementType: BeamEuler / BeamLink / Link / PlaneClassic / PlateMitc
             / ShellAssembled / ShellDegenerated / Solid / Cable / Membrane
             / Penalty / SolidLaStrain / ElasBeamEuler / RebarBeam / SurfaceElem
             / RebarShell / PlaneStress2D / PlaneStrain2D / BeamEuler2D / Link2D
             / AxiSymmPlane / AxiSymmLine / BeamTimoshenko / Pipe / CableCatenary
```

## 自由度与坐标系（三组易混坐标系！）

```text
Dof: All / Uxyz / Ux / Uy / Uz / Phx / Phy / Phz
FDof: Fx / Fy / Fz / Mx / My / Mz

CSYS: GlobalSystem / LocalCoordinateSystem     # 荷载类 iCoord 用
LOCALCSYS: Cartesian / Cylindrical / Spherical  # Csys.iType 用
ConnCoordType: Auto / Fixed / Follow / Global    # Connector.iCoord 用
                                             #   ★ 2026-10-30 版手册新增 Global(固定总体系) 与 vy/vx 语义；
                                             #     ⚠️ 本机 2.2.1 运行时**无 Global 成员**（hasattr=False），
                                             #     写 ConnCoordType.Global 会 AttributeError；传裸值 iCoord=3 可跑通
                                             #   2026-10-28 实测：Auto、Fixed(+vy) 可用；Follow 不可用
```

## 荷载

```text
LoadType: Cload / Cdisp / Elload / Esload / Eslload / Ebload / Ebsload / Wpload
          / Wload / Ctem / Emload / PipeLoad / Etem / EtemGrads / ElemPrestressLoad
LoadDistributionType: Concentrated / Uniform / Nonuniform / BodyForce
LoadSubType: Force / Moment
WaterPressureType: SolidSurface / ShellSurface
WaveType: Acceleration / Velocity / Displacement
WaveActionType: Boundary / Force                # Wload 的 iType
InertiaType: Translation / Rotation
EtemType: TempLoad / BeamTempGrads / ShellTempGrads
PreStressType: Stress / Strain
ElemPreStressType: Stress / Strain / AxialForce
```

## 相互作用与支座

```text
BindingType: SurfToSurf / NodeToSurf / NodeToNode
CouplingType: Rigid / Flexible
DofMode: Both / Translation / Custom            # Custom 仅耦合有效
EmbededType: NodeToElem / NodeToNode
ContactType: ElasToElas / RigidToElas
ContactMethod: NodeToSurf / SurfToSurf          # 接触对离散方式
ContactMethodCtrl: Lagrange / SuperElement / EquivalentTied   # 全局接触控制（Setting）
ConnSectType: Translation / Rotation
ConnStiffType: Linear / Nonlinear / MetalPlastic
                                             # ★ 2026-10-16 版手册起，keyStiff 决定该填哪组形参：
                                             #   Linear(0)        → consElas（常刚度，已实机验证）
                                             #   Nonlinear(1)     → elastics（荷载-位移表，★ 2026-10-28 实机跑通、逐点守表；
                                             #                      见 fem #145）
                                             #   MetalPlastic(2)  → plastics（★屈服荷载-**塑性**位移表，2026-10-28 实机跑通）+ m
                                             #                      m: 0 随动 / 1 等向 / 0<m<1 混合硬化
                                             # ⚠️ plastics 第 2 列是塑性位移、非总位移（与 elastics 不同），
                                             #    以求解器 19_ConnectSect.inp 表头为准
ConnDampType: Off / Constant / Nonlinear
                                             # ★ 2026-10-22 版手册补齐：keyDamp 决定该填哪组形参：
                                             #   Off(0)          → 无阻尼（consDamp/dampCoefs 不生效）
                                             #   Constant(1)     → consDamp（常阻尼，标量）
                                             #   Nonlinear(2)    → dampCoefs（阻尼力-速度表，第二维长度 2 = 阻尼力/速度）
                                             #   ⚠️ 两者**能构造能落盘，但动力分析中静默无作用**（2026-10-28 实机：
                                             #     A/B 两子系统逐帧差 0.000e+00）⇒ 需要阻尼改用分析级阻尼（fem #146）
ConnFrictionType: Off / On                      # ⚠️ 限值 frictCoef 只能构造后属性赋值（cs.frictCoef=0.3）
ConnFailType: Off / On                          # ⛔ On 而不赋 dispFail ⇒ sep-processor 崩 0xc0000005
ConnLockType: Off / On                                             # ★ 连接器（Connector/ConnectorSection）2026-10-15 实机验证**可用**
                                             #   （原"modelcheck 崩溃 0xc0000409"记载已推翻）；已验证路径：
                                             #   ★ 2026-10-28 已扩展验证：Rotation（iDofs=[Dof.Phx]）、
                                             #   Nonlinear(elastics) / MetalPlastic(plastics+m)、iCoord=Fixed（Follow 不可用）、
                                             #   隐式动力下传力 —— 均可用；阻尼无作用、摩擦/失效/阻止需构造后赋限值
FixedType: Default / BaseLine / BaseLineGeom
ElasSupportType: Soil / Lateral / Rotational
IsolationBearingType: General / GeneralRubber / PlumbumRubber / DampingRubber
                      / FrictionRubber / SlideRubber
```

## 分析

```text
AnaType: MODAL / STATIC / IMPLICIT / BUCKLING / EXPLICIT / HARMONIC / SPECTRUM
         / POSTBUCK / FATIGUE / STEADYHEAT / TRANSIENTHEAT / STEADYFLUID
         / TRANSIENTFLUID / SUSPBRIDGEANALY
NLType: ALinear / PDelta / GeoNonlinear / MaterNonlinear / GeoMaterNonlinear
        / FoundationRaft
ImpAnaMethod: Direct / Subspace / Lanczos
ExAnaMethod: HalfStep / TotalStep
AnaDampType: RatioToMass / RatioToProportional / Rayleigh
SpectrumAnaMethod: Standard / Code
ModalCombine: CQC / SRSS
SpectrumCurveType: LoadSpectrum / AccSpectrum / VeloSpectrum / DispSpectrum
                   / AccTimeHist / DispTimeHist / LoadTimeHist
InterpolationType: Linear / Log
KeyTfType: Freq / Period
FreqInterpolationMethod: NO_INTERPOLATION / LINEAR / LOG / OB1 / OB2 / OB3 / OB6
                         / OB12 / OB24 / LINEAR_FREQCONTAIN / LOG_FREQCONTAIN
SeismicIntensity: Six / Seven / Eight / Nine
SeismicLevel: Frequent / Moderate / Rare
SiteClass: Class0 / Class1 / Class2 / Class3 / Class4
DesignEarthquakeGroup: Group1 / Group2 / Group3
LimitDispControl: DispCoef / DispValue
```

## 模型修正与其他

```text
ChangeType: Remove / Add
ChangeChType: Element / Contact / ElasSupport / IsolationBearing / Connect
              # ⚠️ 官方签名处写作 ChangeElement，以 enums 实际名为准（ERRATA #15）
JointType: Sphere / BeamEnd
OffsetType: Translation / Rotation
OffcenterType: Node / Beam / Shell
OffcenterDir: Value / TopCenter / BottomCenter / MiddleLeft / MiddleRight
              / TopLeft / TopRight / BottomLeft / BottomRight
```

## 附录：单元面号规则（面荷载/体表面荷载/接触用）

**面单元**：Face1 = 正向（1-2-3[-4]），Face2 = 反向。

**体单元**（八节点六面体）：

| 面号 | 组成节点 |
|---|---|
| Face 1 | 4-3-2-1（底） |
| Face 2 | 5-6-7-8（顶） |
| Face 3 | 1-2-6-5 |
| Face 4 | 2-3-7-6 |
| Face 5 | 3-4-8-7 |
| Face 6 | 4-1-5-8 |

（四/五节点体单元面号详见《PyPCAE 用户帮助手册》附录 1。）
