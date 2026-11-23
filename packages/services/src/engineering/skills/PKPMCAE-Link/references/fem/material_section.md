# 材料与截面 — 参考文档




## 概述

材料（`Material`）与截面（`Section`）是一切模型的前两步。本文覆盖：材料签名与
本构选型、常用材料速查、截面两类定义方式（iKey=1 形状参数 / iKey=0 直接属性）、
各截面形状写法与坑位。

## 核心 API

### 材料 Material

```python
Material(name: str,                     # 必填（唯一必填项）
         iType: int = MaterialType.Custom,
         iModel: int = MaterialModel.Elastic,
         iMark: int = 0,                 # 材料标号（手填材性时不需要）
         E0: float = 0.0,                # 弹性模量 Pa
         poisson: float = 0.0,           # 泊松比
         density: float = 0.0,           # 密度 kg/m³
         expansion: float = 0.0,         # 热膨胀系数 /℃（温度荷载必需！）
         dampingType: int = MatDampType.NoDamping,
         alpha: float = 0.0,             # 瑞雷阻尼-质量矩阵系数
         beta: float = 0.0,              # 瑞雷阻尼-刚度矩阵系数
         dampr: float = 0.0)             # 阻尼比（dampingType=DampingRatio 时生效）
```

- `iType`：`MaterialType.Steel / Concrete / Rebar / Custom`
- `iModel`：`MaterialModel.Elastic / MetalPlastic / ConcretePlasticDamage /
  ConcreteDamage / ConcreteGuoZhang / ConcreteMander / ConcreteCode / ConcreteHLH /
  GeoMohrCoulomb / JohnsonCook / Neohookean / hyperfoam`
- 材料按创建顺序自动编号，`mat.id` 供截面引用。
- **阻尼注意**：`alpha`/`beta` 仅对 `Rayleigh` 生效；`dampr` 仅对 `DampingRatio` 生效。

### 材料库 MatDB（标准牌号一律查库，禁止凭记忆手填）

**策略（强制）**：标准牌号（混凝土/钢材/钢筋）**必须调用材料库生成——是"调用"不是"手填"**：
- **脚本内**：先 `MatDB.load()`，再 `MatDB.assemble(name=..., iType=..., iMark=..., iModel=..., setting=setting)`，`setting` 必传（E0/density 按 setting 单位制换算）；
- **禁止**在脚本里手写 `Material(name="Q345B", E0=2.06e11, ...)` 这类数值材料——即使数值正确也不允许；
- 生成前可用平台工具 `get_material_tree` 确认牌号写法、`get_material_param` 预览参数；
- 仅库外自定义材料（库里没有的牌号/本构）才允许手填 `Material(...)`。

**单位制规则（强制）**：材料库为 **m 制单位体系（SI：m / N / Pa / kg/m³）**：
- **情况1·用户指定了单位制**：仍优先查库取参，但必须将库参数（m 制）**换算到用户指定单位制**，保证全脚本单位一致（换算锚点：m→mm ×1000；Pa→MPa ÷10⁶；kg/m³→t/mm³ ×10⁻¹²；mm 制自重加速度用 9810）；
- **情况2·用户未指定单位制**：**默认采用 m 制**（与材料库一致，SI 为软件默认，无需改 Setting），并在交付说明中明确提示用户「未指定单位制，已默认采用 m 制（SI）」。

**两个取参出口，单位基准不同（易错！）**：

| 出口 | 类型 | 单位行为 |
|---|---|---|
| `get_material_param` | Agent 平台工具 | `E0`/`density` 已换算为 SI（Pa、kg/m³）；本构参数换算随本构而异 |
| `MatDB.assemble` | 脚本内接口 | 只换算 `E0`/`density`（随 `setting` 走）；**`plasPara` 与本构曲线原样返回**（库原值 MPa、t/m³） |

- 同一材料内**所有应力类数值必须同单位**（`E0`、`plasPara` 强度项、曲线应力列）——
  取用前核对数量级，差 1e6 即未统一；
- `MatDB.assemble` 前必须先 `MatDB.load()`，漏掉报 `illegal material category`；`assemble` 的 `iModel`/`setting` 均有默认值（Elastic / None）——**不传 setting 时采用材料库默认单位制（m 制）**，项目为其他单位制时务必显式传 `setting`（手册 9.28 版澄清）；
- **spec 通道不支持 `plasPara`，非线性本构必须走 `save_script`**。

```python
MatDB.load()                       # 必须先加载材料库（在建模语句之前），漏掉报 illegal material category
setting = Setting()                # 默认 m 制（SI）；其他单位制在 setting 中设定

mat = MatDB.assemble("Q355钢", iType=MaterialType.Steel,
                     iMark=SteelType.Q355, setting=setting)
mat_c40 = MatDB.assemble("C40", iType=MaterialType.Concrete,
                         iModel=MaterialModel.ConcretePlasticDamage,
                         iMark=ConcreteType.C40, setting=setting)
```

### 非线性本构参数（plasPara 布局）

```text
CDP 混凝土塑性损伤（iModel=2，n1=10）：
    [0]ftr [1]fcr [2]alpha [3]gamma [4]psi剪胀角 [5]xi偏心率
    [6]wTension [7]wCompression [8]confinedCoef [9]iCurveMode
金属弹塑性 MetalPlastic（iModel=1，n1=4）：
    [0]yield [1]strength [2]tangent [3]M（tangent<0 时用自定义曲线）
混凝土二维规范 ConcreteDamage（iModel=3，n1=2）：
    [0]ftr [1]fcr
```

### 本构曲线（userPara）

- 仅 CDP（4 条）与岩土（10/13，1 条）库条目带曲线；钢材/钢筋/弹性混凝土
  `userPara` 为空，本构由 `plasPara` 描述；
- CDP 四条曲线：`epsc`（压应力-非弹性应变）、`dcp`（压损伤-应变）、
  `epst`（拉应力-开裂应变）、`dtp`（拉损伤-应变）；
- **列序：第一列纵轴量（应力或损伤系数 0~1）、第二列应变，第二列严格递增**；
- 自检：曲线应力列峰值 ÷ `E0` 应落在材料真实应变量级（或应变列最大值 ≈ fcr/E0）。

### ★ 本构-单元相容性（复合材料 / 各向异性：先判这一条，再谈材料数值）

> 2026-10-15 实测补充（依据：59 m 风电叶片层合板建模会话，ERRATA #115）。

- **实体单元只有各向同性弹性本构**（`E0` / `poisson` / `density`）——**给不了** `E1≠E2≠E3`、`G12`、`ν12` 的
  **正交各向异性**；
- 因此复合材料构件若**既要"实体"外形、又要体现层合板各向异性**，二者**本质冲突，必须二选一**：

  | 选择 | 做法 | 代价与必须声明的事项 |
  |---|---|---|
  | **要各向异性** | 走**分层壳**路线（分层壳截面 + 各向异性子层，见下「模板 4」） | 外形是**壳**不是实体；厚度方向应力不可得 |
  | **要实体** | 只能取**各向同性等效值** | ① 脚本注释与交付包写明"由 E1/E2/G12/ν12 折合的各向同性等效，属 **[估算]**"；② 说明该值**与取向相关**（展向主导 vs 弦向主导的等效模量不同），让用户知道适用范围 |

- ★ **交互要求（强制）**：用户**同时**表达"要实体模型"与"给了层合板各向异性参数"时，
  **应在建模前问一次**，⛔ **不要静默取一个等效值了事**；
- 层合板等效属**用户/工程师的职责范围**：Agent 可代为换算并如实标注 [估算]，
  但**不对等效值的工程正确性负责**（`execution_contract.md` §1）。

**库外自定义材料速查（常见工程材料经验量级，仅供 [估算] 参考，正式分析前须由用户确认）**：

| 材料 | E (GPa) | ν | ρ (kg/m³) | 备注 |
|---|---|---|---|---|
| 碳/玻混编层合板（等效） | E1≈45、E2≈13、G12≈4.5 | ν12≈0.28 | ≈1900 | 2026-10-15 会话实用值；**各向同性等效须另算并标注 [估算]** |
| 玻璃纤维层合板 | 10~25 | 0.25~0.30 | 1600~2000 | 树脂体系影响大 |
| 碳纤维层合板（单向） | E1 120~180、E2 8~12 | 0.25~0.30 | 1500~1600 | 强各向异性，**实体单元无法表达** |
| 木材（顺纹/横纹） | 9~12 / 0.3~0.6 | — | 400~700 | 正交各向异性 |
| 砌体 | 1~3 | 0.15~0.25 | 1600~2000 | 抗拉极低，注意本构选择 |

> ⚠️ 上表是**量级参考**，不是设计取值；标准牌号（混凝土/钢材/钢筋）一律走 `MatDB.load()` +
> `assemble(..., setting=setting)`，**禁止凭记忆或本表手填**。

### ★ 部分钢筋牌号在材料库中只有弹塑性条目（2026-10-14 实测，ERRATA #116）

`get_material_param("HRB400")` 实测**只返回 `iModel=1`（金属弹塑性）一个条目**，无线弹性条目；
而 `MatDB.assemble` 的 `iModel` 默认为 `0`（`MaterialModel.Elastic`）。
**实测按默认调用不报错**、材料正常生成、线性静力分析正常求解（线弹性分析不激活塑性参数）。
⇒ 做**非线性**分析时才需显式指定 `iModel`，并核对 `plasPara` 单位口径
（库原值为 **MPa / t·m⁻³**，与 `E0` 的 **Pa** 不同）。
对比：`get_material_param("C30")` 返回 3 个条目（2 个 `iModel=0` 线弹性 + 1 个 `iModel=2`），默认调用即取到线弹性。

### 常用材料速查（SI 制，仅供核对量级/库外自定义材料参考——标准牌号一律用 MatDB.assemble 调用）

| 名称 | E0 (Pa) | poisson | density (kg/m³) | expansion (/℃) |
|------|---------|---------|-----------------|----------------|
| Q235 | 2.06e11 | 0.30 | 7850 | 1.2e-5 |
| Q345B | 2.06e11 | 0.30 | 7850 | 1.2e-5 |
| C30 | 3.00e10 | 0.20 | 2500 | 1.0e-5 |
| C40 | 3.25e10 | 0.20 | 2500 | 1.0e-5 |
| C50 | 3.45e10 | 0.20 | 2600 | 1.0e-5 |

### 截面 Section

```python
Section(name: str, type: int = SectionType.Solid, sub=None, iKey: int = 1)
```

- `type`：`SectionType.Line`（线元）/ `Surface`（面元）/ `Solid`（实体）
- `sub`：**传形状类实例或其实例列表**（如 `Rectangle(...)` 或 `[Rectangle(...)]`；
  官方签名为 `list[SubSection]`，单实例与列表源码均接受）；**禁止构造 dict**——
  无对应处理分支，会在后续环节报错
- `iKey=1`（默认）：传形状参数算属性；`iKey=0`：直接给截面属性（`Arbitrary`）
- ★ **关键字陷阱（2026-10-15 实测踩坑，`references/fem/known_issues.md` #121）**：`Section` 的类型参数是 **`type=`**，
  而 `MatDB.assemble` 的类型参数是 **`iType=`**——**两者相反，极易写错**。
  写成 `Section(name=..., iType=SectionType.Line, ...)` 会在 **Python 层**直接
  `TypeError: __init__() got an unexpected keyword argument 'iType'`，脚本终止（`exit status 1`），
  **根本走不到 modelcheck**。对照记忆：`Section(name, **type**=SectionType.*, sub=[...], iKey=1)`；
  `MatDB.assemble(name, **iType**=MaterialType.*, iMark=..., setting=setting)`（`type=` 只是官方示例别名，#49）

## 代码模板

### 模板 1：标准牌号钢材 + 矩形梁截面（MatDB 调用，推荐）

```python
MatDB.load()                       # 建模前先加载材料库（全脚本一次即可）
setting = Setting()                # 默认 m 制（SI）
mat = MatDB.assemble("Q345B", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
sec_beam = Section("Beam300x600", SectionType.Line,
                   Rectangle(mid=mat.id, b=0.3, h=0.6))
```

> 手填 `Material(E0=2.06e11, ...)` 仅允许用于**库外自定义材料**；标准牌号一律走 MatDB。

### 模板 2：标准牌号混凝土板壳截面（MatDB 调用，推荐）

```python
mat_c = MatDB.assemble("C30", iType=MaterialType.Concrete,
                       iMark=ConcreteType.C30, setting=setting)
sec_slab = Section("Slab120", SectionType.Surface,
                   SingleLayer(mid=mat_c.id, t=0.12))     # t=板厚（随单位制）
```

> 若需非线性本构（如 CDP），assemble 时加 `iModel=MaterialModel.ConcretePlasticDamage`。

### 模板 3：实体截面

```python
sec_solid = Section("SolidSec", SectionType.Solid, SolidSect(mid=mat.id))
```

### 模板 4：分层壳截面（混凝土基层 + 内嵌钢筋层）

```python
mat_c30   = MatDB.assemble("C30", iType=MaterialType.Concrete, iMark=ConcreteType.C30, setting=setting)
mat_rebar = MatDB.assemble("HRB400", iType=MaterialType.Rebar, iMark=RebarType.HRB400, setting=setting)

T, COVER, D_BAR, S_BAR = 0.2, 0.025, 0.010, 0.150      # m，板厚/保护层/筋径/间距
T_REBAR = math.pi * D_BAR**2 / 4.0 / S_BAR              # m，钢筋网等效层厚 = As/s
Z_REBAR = T / 2.0 - COVER - T_REBAR / 2.0               # m，钢筋层中心距壳中面
sec = Section("RC_Shell", SectionType.Surface, [
    SingleLayer(mid=mat_c30.id,   t=T,       offset=0.0),                    # 混凝土基层（全厚）
    SingleLayer(mid=mat_rebar.id, t=T_REBAR, offset=Z_REBAR,  isotropy=1),   # 上层钢筋等效层（isotropy=1 钢筋层）
    SingleLayer(mid=mat_rebar.id, t=T_REBAR, offset=-Z_REBAR, isotropy=1),   # 下层钢筋等效层
])
```

> 要点：双向等配筋钢筋网按 smeared 等效层处理（t=As/s），**钢筋层必须 `isotropy=1`**（手册 9.28 版新增说明）；`offset` = 子层中心到外层中心的距离，沿壳法向定位，正=法向正侧；完整算例见 `examples/fem/rc_plate_shell_rebar_layer.py`（平板双层双向）与
> `examples/fem/rc_silo_shell_rebar_layer.py`（圆柱筒仓内层钢筋 + 内壁静水压力）。

### 模板 5：直接给截面属性（iKey=0，常用于桥梁主梁）

```python
sec_girder = Section("Girder", SectionType.Line,
                     Arbitrary(mid=mat_c.id, area=7.8, Ix=19.0, Iy=60.0, Iz=8.0),
                     iKey=0)
```

## 截面形状速查（iKey=1）

| 形状类 | 签名 | 备注 |
|---|---|---|
| `SolidSect` | `(mid)` | 实体 |
| `SingleLayer` | `(mid, t, offset=0, isotropy=0, normal=None)` | 壳子层，至少传 mid 与 t；t=子层厚；offset=子层中心到外层中心的距离（法向正侧为正）；isotropy：0=各向同性 / 1=钢筋层 / 2=各向异性；normal=主方向向量（各向同性不生效） |
| `Rectangle` | `(mid, b, h)` | 矩形 |
| `Circle` | `(mid, d)` | **d 小写**，直径 |
| `Box` | `(mid, b, h, u, t, d, f)` | 箱形，壁厚须 >0 且 < min(b,h)/2 |
| `IShape` | `(mid, t, h, bu, tu, bd, td)` | 工字形，**必须全位置参数** |
| `Tube` | `(mid, D, t)` | 圆管，**必须全位置参数** |
| `Crossing` | `(mid, b, h, u, t, d, f)` | 十字形 |
| `LShape` | `(mid, b, h, d, f)` | L 形 |
| `TShape` | `(mid, b, h, d, f)` | T 形 |
| `WeldedBoxO` | `(mid, b, h, u, t, d, f)` | 焊接箱形 |
| `OneCell`/`TwoCell` | `(mid, params, cellChecks=None)` | 单箱单室/双室 |
| `BSTF` | `(mid, params)` | 带肋箱形 |
| `Custom` | `(mid, coords=list[DataCurve])` | 自定义 |
| `Arbitrary`（iKey=0） | `(mid, area, Ix=0, Iy=0, Iz=0, Iyz=0, Asy=0, Asz=0)` | 直接给属性 |

> 定义 `mat`/`sec` 时可只给 `name`，其余特性在 PkpmCAE 界面中补——但 Agent 生成的
> 计算脚本应给全参数。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 温度应力恒为 0 | 材料未填 `expansion` | 钢 1.2e-5 / 混凝土 1.0e-5 |
| 全模型量级整体错 10³/10⁶ | 材料库 m 制参数直接套进了 mm 制脚本（或反之） | 按单位制规则统一换算；未指定单位制时默认 m 制 |
| 截面创建报错 | `Tube`/`IShape` 用了关键字传参 | 改全位置参数 |
| `Circle` 报错 | 直径写成大写 `D` | `Circle(mid, d=...)` 小写 |
| 截面属性量级异常 | mm 尺寸未换算成 m | 全部 ÷1000（薄壁厚度最易漏） |
| 自重为 0 | 只设了 density | 自重需 `Emload`，见 `loads.md` |
| `illegal material category` | `MatDB.assemble` 前漏了 `MatDB.load()` | 先加载材料库 |
| 非线性结果离谱 | plasPara/曲线单位与 E0 不一致（工具返回 Pa、assemble 返回 MPa 库原值） | 同一材料只按一个出口取数，统一单位制 |
| spec 生成非线性失败 | spec 通道不支持 plasPara | 非线性走 `save_script` |

## 验证清单

- [ ] 标准牌号已用 `MatDB.load()`+`MatDB.assemble(..., setting=setting)` 从库生成（未手写 Material 数值）；仅库外自定义材料手填
- [ ] 材料 E0/poisson/density 三件套齐全（动力分析 density 必填）
- [ ] 非线性本构：plasPara 与曲线应力列同单位、曲线第二列严格递增
- [ ] 有温度荷载时 expansion 已填
- [ ] 截面类型与单元类型匹配（Line↔梁杆 / Surface↔壳 / Solid↔实体）
- [ ] 薄壁/薄板厚度已换算成项目单位
