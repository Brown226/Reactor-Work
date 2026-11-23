# 枚举速查 — 参考文档




> 全量枚举值摘自《PyPCAE 用户帮助手册》附录。不确定时用平台 `list_*` 工具实时核对。

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
# 注：结构（几何）模型相关枚举（ComponentType / LineType / SurfType / SolidType / MeshType）
#     与脚本执行模式 ExecutionMode 属 `pypcae-stru-modeling` 技能范围，不在本技能收录。
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
                                             #     ⚠️ 本机 2.2.1 运行时**枚举里没有 Global**（hasattr=False）——
                                             #     写 ConnCoordType.Global 会 AttributeError；传裸值 iCoord=3 可跑通
                                             #   2026-10-28 实测：Auto、Fixed(+vy) 可用；★ Follow 不可用
                                             #   （genfea **Error:setConnectionElem有错），见 interactions.md §5
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
ConnSectType: Translation / Rotation            # 2026-10-28 实测：两者均可用；
                                             #   Translation 的 iDofs 写 [Dof.Ux]、Rotation 写 [Dof.Phx]（写别的静默零）
ConnStiffType: Linear / Nonlinear / MetalPlastic # 2026-10-28 实测：三者均可用；
                                             #   Nonlinear→elastics（荷载-位移）、MetalPlastic→plastics（屈服荷载-塑性位移）+m
                                             # ★ 2026-10-16 版手册起，keyStiff 决定该填哪组形参：
                                             #   Linear(0)        → consElas（常刚度，已实机验证）
                                             #   Nonlinear(1)     → elastics（荷载-位移表，2026-10-28 实机跑通、逐点守表）
                                             #   MetalPlastic(2)  → plastics（★屈服荷载-**塑性**位移表，2026-10-28 实机跑通）+ m
                                             #                      m: 0 随动 / 1 等向 / 0<m<1 混合硬化
                                             # ⚠️ plastics 第 2 列是塑性位移、非总位移（与 elastics 不同），
                                             #    以求解器 19_ConnectSect.inp 表头为准
ConnDampType: Off / Constant / Nonlinear        # ⚠️ 2026-10-28：Constant/Nonlinear 能构造能落盘，但
                                             #   动力分析中静默无作用 ⇒ 阻尼改用分析级（interactions.md §5）
                                             # ★ 2026-10-22 版手册补齐配对：Off→无阻尼 / Constant→consDamp /
                                             #   Nonlinear→dampCoefs（阻尼力-速度表，第二维长度 2 = 阻尼力/速度）
ConnFrictionType: Off / On                      # ⚠️ 限值 frictCoef 只能构造后赋值（cs.frictCoef=0.3）；单独 On 时 frictCoef=0（=无摩擦）
ConnFailType: Off / On                          # ⛔ On 而不赋 dispFail ⇒ sep-processor 崩溃 0xc0000005；
                                             #   给了限值也【不是阈值】：一开即断开（dispFail 大于实际位移照样失效，fem #157）
ConnLockType: Off / On                          # ⛔ On 而不赋 dispLock ⇒ sep-processor 崩溃 0xc0000005；
                                             #   给了限值也【不是阈值】：dispLock 5e-4 与 2e-3 结果逐位相同（fem #157）
                                             # ★ 连接器（Connector/ConnectorSection）2026-10-15 实机验证**可用**
                                             #   （原"modelcheck 崩溃 0xc0000409"记载已推翻，#119）；已验证路径：
                                             #   Translation + Linear + consElas + Auto + 静力；
                                             #   ★ 2026-10-28 扩验：Rotation、Nonlinear、MetalPlastic、iCoord=Fixed、
                                             #   隐式动力传力 —— **均可用**；Follow 不可用；阻尼无作用；摩擦/失效/阻止需构造后赋限值
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
                                             #   ★ 枚举里【没有 Linear】——线性静力直接不传 iNLType，
                                             #   不要写 NLType.Linear（运行期 AttributeError，2026-10-28 实测）
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
