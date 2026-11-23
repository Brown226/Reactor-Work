# 材料与截面（结构 / 混合路线） — 参考文档


## 概述

**覆盖范围**：材料库 `MatDB`、自定义 `Material`、全局单位制 `Setting`、截面 `Section` 与全部子截面形状、
截面与**构件维度**的匹配规则、构件侧特有的截面相关修正（变截面组、截面偏心、梁截面法向）。

**何时使用**：任何建模的第一步（材料 → 截面 → 节点 → 构件）。构件写法见 `stru_model.md`。

## 核心 API

### 材料与单位制

```python
MatDB.load()                                     # ★ 必须最先调用（漏掉报 illegal material category）
setting = Setting()                              # 全局设置对象（构造后赋值，不是构造传参）
setting.iTypeSI = 2                              # 0=自定义(各单位档) / 1=m-kg(SI) / 2=mm-t
mat = MatDB.assemble(name="Q345", iType=MaterialType.Steel,
                     iMark=SteelType.Q345, setting=setting)
```

- 实测签名：`MatDB.assemble(name, iType, iMark, iModel=0, setting=None)`；
  `iModel` 默认 `MaterialModel.Elastic`（弹性和其他本构按枚举取）；
- ★ 官方示例写 `assemble(..., type=MaterialType.Steel, ...)` **运行时也能通过**（`type` 被当别名接受），
  但手册形参名是 `iType` → **统一写 `iType=`**（`references/stru/known_issues.md` #49）；
- **`setting` 必传**：它决定 `E0`/`density` 的换算目标；漏传按材料库默认单位制返回（与项目不一致）；
- ★ 实测 `Setting()` 落盘为 **`iTypeSI=0`**（自定义档，`unitLen/unitForce/unitMass/unitStren/unitDense`
  全 0 = m/N/kg/Pa），效果等同 SI；要显式 m-kg 制写 `setting.iTypeSI = 1`（#55）。

#### 单位制速查（含实测材料值）

| 量 | `iTypeSI = 0/1`（m 制，`Setting()` 默认） | `iTypeSI = 2`（mm-t 制，官方示例常用） |
|---|---|---|
| 长度 / 坐标 / 截面尺寸 / 网格尺寸 | m | **mm** |
| 力 / 荷载 | N | N |
| 应力 / 弹模 / 强度 | Pa（C30 → `E0=3.0e10`） | **MPa**（Q345 → `E0=206000`） |
| 密度 | kg/m³（C30 → `2500`） | **t/mm³**（Q345 → `7.85e-9`） |
| 自重加速度 `Emload.value` | **9.81** | **9810** |
| 质量 / 附加质量 | kg | t |

> 落盘核对：`<项目>/pypcae/pypcae.stru` 的 `setting.iTypeSI` 与 `materials[].E0/density`。
> 实测：mm-t 制下 Q345 = `E0=206000`、`density=7.85e-9`、`poisson=0.3`、`expansion=1.2e-5`、
> `plasPara=[345.0, 470.0, 630.278, 1.0]`；m 制下 C30 = `E0=3.0e10`、`density=2500`、
> `poisson=0.2`、`expansion=1e-5`、`plasPara=[2.01, 20.1, 1.0]`。
> ★ `plasPara` 是**库原值（MPa、t/m³ 口径）**，与 `E0` 的单位不同——同一材料内所有应力类数值必须同单位。

### 自定义材料（仅库外材料）

```python
mat = Material(name="my_mat")           # 之后可赋 E0/poisson/density/expansion 等
```
- **标准牌号（混凝土/钢材/钢筋）禁止手填数值**，一律走 `MatDB`；
- 需要温度荷载时**必须填 `expansion`**，否则温度应力恒为 0；
- ★ **部分钢筋牌号在材料库中只有弹塑性条目（2026-10-14 实测）**：`get_material_param("HRB400")`
  实测**只返回 `iModel=1`（金属弹塑性）一个条目**，无线弹性条目；而 `MatDB.assemble` 的 `iModel`
  默认为 `0`（`MaterialModel.Elastic`）。**实测按默认调用不报错**、材料正常生成
  （`materials` 落盘 2 条），线性静力分析亦正常求解（线弹性分析不激活塑性参数）。
  ⇒ **做非线性分析时才需显式指定 `iModel`**，并核对返回条目 `plasPara` 的单位口径
  （库原值为 **MPa / t·m⁻³** 口径，与 `E0` 的 **Pa** 不同，见上注）；
  对比：`get_material_param("C30")` 返回 3 个条目（2 个 `iModel=0` 线弹性 + 1 个 `iModel=2`），
  默认调用即取到线弹性条目。

### ★ 本构-单元相容性（复合材料 / 各向异性：先判这一条，再谈材料数值）

> 2026-10-15 实测补充（依据：59 m 风电叶片层合板建模会话）。

- **实体单元只有各向同性弹性本构**（`E0` / `poisson` / `density`）——
  **给不了** `E1≠E2≠E3`、`G12`、`ν12` 的**正交各向异性**；
- 因此复合材料构件若**既要"实体"外形、又要体现层合板各向异性**，二者**本质冲突，必须二选一**：

  | 选择 | 做法 | 代价与必须声明的事项 |
  |---|---|---|
  | **要各向异性** | 走**分层壳**路线（分层壳截面 + 各向异性子层） | 外形是**壳**不是实体；厚度方向应力不可得 |
  | **要实体** | 只能取**各向同性等效值** | ① 脚本注释与交付包写明"由 E1/E2/G12/ν12 折合的各向同性等效，属 **[估算]**"；② 说明该值**与取向相关**（展向主导 vs 弦向主导的等效模量不同），让用户知道适用范围 |

- ★ **交互提示（强制）**：当用户**同时**表达"要实体模型"与"给了层合板各向异性参数"时，
  **应在建模前问一次**（属"需要综合判断"事项，见 `execution_contract.md` §4b.5），
  ⛔ **不要静默取一个等效值了事**；
- 层合板等效属**用户/工程师的职责范围**：Agent 可代为换算并如实标注 [估算]，
  但**不对等效值的工程正确性负责**（`execution_contract.md` §1）。

**库外自定义材料速查（常见工程材料经验量级，仅供 [估算] 参考，正式分析前须由用户确认）**：

| 材料 | E (GPa) | ν | ρ (kg/m³) | 备注 |
|---|---|---|---|---|
| 碳/玻混编层合板（等效，展向主导） | E1≈45、E2≈13、G12≈4.5 | ν12≈0.28 | ≈1900 | 2026-10-15 会话实用值；**各向同性等效须另算并标注 [估算]** |
| 玻璃纤维层合板 | 10~25 | 0.25~0.30 | 1600~2000 | 树脂体系影响大 |
| 碳纤维层合板（单向） | E1 120~180、E2 8~12 | 0.25~0.30 | 1500~1600 | 强各向异性，实体单元无法表达 |
| 木材（顺纹/横纹） | 9~12 / 0.3~0.6 | — | 400~700 | 正交各向异性 |
| 砌体 | 1~3 | 0.15~0.25 | 1600~2000 | 抗拉极低，注意本构选择 |

> ⚠️ 上表是**量级参考**，不是设计取值；标准牌号（混凝土/钢材/钢筋）一律走 `MatDB.load()` +
> `assemble(..., setting=setting)`，**禁止凭记忆或本表手填**（铁律见 `script_standard.md`）。

### 截面

```python
Section(name='', type=SectionType.Line, sub=<子截面实例或列表>, iKey=1)
```

| 子截面 | 实测签名 | 用途 |
|---|---|---|
| `Rectangle` | `(mid, b, h)` | 矩形（梁柱） |
| `Circle` | `(mid, d)` | 圆形（★ 直径是小写 `d`） |
| `Tube` | `(mid, D, d)` | 圆管：★ 第三参是**内径 d**（手册与 `list_shapes()` 误作壁厚 `t`，#44） |
| `IShape` | `(mid, t, h, bu, tu, bd, td)` | 工字形 |
| `Box` / `Crossing` / `LShape` / `TShape` / `WeldedBoxO` | 见手册 §二.2.2 | 箱形/十字/L/T/焊接箱 |
| `OneCell` / `TwoCell` / `BSTF` / `Custom` | `(mid, params, ...)` | 单箱/双箱/带肋箱/自定义 |
| `SingleLayer` | `(mid, t, offset=0, isotropy=0, normal=None)` | **壳截面**（板/墙/面构件）：`t` 厚、`offset` 到外层子截面中心的距离（法向正侧为正）、`isotropy` 0 各向同性 / 1 钢筋层 / 2 各向异性、`normal` 主方向（各向同性不生效） |
| `SolidSect` | `(mid)` | **实体截面**（体构件） |
| `Arbitrary` | `(mid, area, Ix, Iy, Iz, Asy, Asz)` | 直接给截面属性（`iKey=0`） |

★ **`Tube` 与 `IShape` 必须全位置参数**：`Tube(mat.id, 1200, 900)`、`IShape(mat.id, t, h, bu, tu, bd, td)`；
关键字传参运行时可用但 `save_script` 校验会拦（"Tube 使用了关键字参数"）。其余子截面按关键字传参。


> ★ **关键字陷阱（2026-10-15 实测踩坑）**：`Section` 的类型参数是 **`type=`**，
> 而 `MatDB.assemble` 的类型参数是 **`iType=`**——**两者相反，极易写错**。
> 写成 `Section(name=..., iType=SectionType.Line, ...)` 会在 **Python 层**直接
> `TypeError: __init__() got an unexpected keyword argument 'iType'`，脚本终止（`exit status 1`），
> **根本走不到 modelcheck**（`references/stru/known_issues.md` #117）。对照记忆：
>
> | 类 | 类型参数 | 权威签名 |
> |---|---|---|
> | `Section` | ★ **`type=`** | `Section(name: str, type: int, sub: list[SubSection], iKey: int)` |
> | `MatDB.assemble` | ★ **`iType=`** | `assemble(name, iType, iMark, iModel=0, setting=None)`（`type=` 只是官方示例用的别名，#49） |
> | `BeamColumn` | ★ **`iMark=`** | `BeamColumn(nids, iMark=ComponentType.X, sid, normal)`（传 `type=` 抛 TypeError，#13） |

### 截面类型 ↔ 构件维度（必须匹配，否则网格后无属性）

| 构件 | 截面类型 | 典型子截面 |
|---|---|---|
| `BeamColumn` / `Line`（要生成梁单元的线构件） | `SectionType.Line` | `Rectangle`/`Circle`/`Tube`/`IShape` |
| `Wall` / `Plate` / `Surf`（面构件） | `SectionType.Surface` | `SingleLayer` |
| `Solid`（体构件） | `SectionType.Solid` | `SolidSect` |
| **纯几何边线**（只作 `Surf`/`Solid` 边界） | **不挂截面**（`sid=-1`） | ★ 挂了 `SectionType.Line` 反而会额外生成梁单元（#47） |

### 构件侧特有的截面相关修正（几何阶段按**构件号**，`geids`）

```python
TaperGroup(name='', geids=None, iSec=-1, jSec=-1, eccDir=-1,
           yAxisShape=None, zAxisShape=None)      # 梁（构件）变截面组
ElemSectOffcenter(geids=None, iType=1, vType=0, value=None)   # 构件截面偏心
```
> 有限元侧同类对象用单元号；混合路线里若要在网格后调整，需在 `fromViewer()` 之后按单元号重建。

## 代码模板

### 模板 1：SI（m 制）混凝土框架截面组

```python
clc(); MatDB.load()
setting = Setting()                                   # 默认档 = m/N/kg/Pa
mat_c30 = MatDB.assemble(name="C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
sec_col  = Section("col_500x500",  SectionType.Line,    Rectangle(mid=mat_c30.id, b=0.5, h=0.5))
sec_beam = Section("beam_300x600", SectionType.Line,    Rectangle(mid=mat_c30.id, b=0.3, h=0.6))
sec_slab = Section("slab_t120",    SectionType.Surface, SingleLayer(mid=mat_c30.id, t=0.12))
sec_blk  = Section("solid_C30",    SectionType.Solid,   SolidSect(mid=mat_c30.id))
```

### 模板 2：mm-t 制钢壳 + 圆管（官方示例口径）

```python
clc(); MatDB.load()
setting = Setting()
setting.iTypeSI = 2                                   # ★ mm-t 制：mm / N / MPa / t·mm^-3
mat_q345 = MatDB.assemble(name="Q345", iType=MaterialType.Steel,
                          iMark=SteelType.Q345, setting=setting)
sec_shell_25 = Section("plate_t25", SectionType.Surface, SingleLayer(mid=mat_q345.id, t=25))
sec_tube     = Section("tube_D1200", SectionType.Line, Tube(mat_q345.id, 1200, 900))   # 全位置：mid, D, d
sec_circle   = Section("cable_D120", SectionType.Line, Circle(mid=mat_q345.id, d=120))
# 自重：Emload(value=9810, dir=[0, 0, -1])   ← mm-t 制用 9810
```

## 最佳实践

1. **顺序不能乱**：`MatDB.load()` → `Setting()`（含 `iTypeSI`）→ `MatDB.assemble(..., setting=setting)`
   → `Section(...)` → 构件（`sid=截面.id`）；
2. 全脚本**只用一种单位制**；用户给 mm/kN 时先统一换算，别在脚本里混用（#16）；
3. 标准牌号一律查库，需要非标材料才 `Material(...)` 手填，且**必须填全** `E0/poisson/density`
   （要温度再加 `expansion`）；
4. 壳结构用 `SingleLayer`：多层（如钢筋层）时 `offset` 定位、`isotropy=1` 标钢筋层，
   双向等配筋按 smeared 等效层 `t = As/s`；
5. 一个厚度一个 `Section`，多处复用（桁架节点示例 6 个壳截面覆盖 37 块板）；截面名用英文 +
   注释中文，便于检索与跨版本；
6. `Section.sub` 传**实例或实例列表**，禁止 dict（#23）；
7. 纯几何边线不要挂截面（#47）；
8. 圆管截面做承载力计算前，先核对第三参语义（内径 `d`）——手册与实测不一致（#44）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `illegal material category` | 没先 `MatDB.load()` | 脚本开头（`clc()` 之后）先 `MatDB.load()` |
| 材料 `E0` 差了 1e6 倍 | `assemble` 漏传 `setting`，或 `setting.iTypeSI` 与脚本单位制不一致 | 显式传 `setting=setting`；核对 `pypcae.stru` 的 `iTypeSI` |
| 自重差了 1000 倍 | mm-t 制里 `Emload.value` 写了 9.81 | mm-t 制用 9810 |
| `Tube(mid=..., D=..., t=...)` 报 TypeError | 形参名是 `d`，且校验要求全位置 | `Tube(mat.id, 1200, 900)` |
| 圆管壁厚算错（截面面积不对） | 把手册的 `t` 当第三参语义 | 按实测签名理解为**内径 d**（#44），必要时用截面面积反算核对 |
| `Circle(mid=..., D=...)` 报错 | 直径参数是小写 `d` | `Circle(mid=mat.id, d=2500)` |
| 构件网格后没属性 | 截面类型与构件维度不匹配（面构件挂了 `Line` 截面等） | 按上表匹配 Line/Surface/Solid |
| 温度应力恒 0 | 材料没填 `expansion` | 补热膨胀系数（钢 1.2e-5、混凝土 1.0e-5） |
| 模型里多出一堆梁单元 | 给纯几何边线挂了 `SectionType.Line` 截面 | 边界几何线不挂 `sid`（#47） |
| `Section.sub` 传 dict 报错 | 只接受实例/实例列表 | `Section("x", SectionType.Line, Rectangle(...))` |

## 验证清单

- [ ] `MatDB.load()` 在 `clc()` 之后、`assemble` 之前；`assemble` 传了 `setting=setting`
- [ ] 全脚本单位制统一；`setting.iTypeSI` 与尺寸量级一致（mm-t → `2`）
- [ ] 标准牌号全部查库，未手写 `Material(E0=...)`；需温度时 `expansion` 已填
- [ ] `Tube`/`IShape` 全位置传参；`Circle` 用小写 `d`
- [ ] 截面类型与构件维度匹配；纯几何边线未挂截面
- [ ] 每个要生成单元的构件都有 `sid`（`sid=-1` 的构件网格后无属性）
- [ ] 落盘核对：`pypcae.stru` 的 `materials[].E0/density`、`sections[].subs[].params` 与预期一致
