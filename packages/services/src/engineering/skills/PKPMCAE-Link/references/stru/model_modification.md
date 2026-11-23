# 模型修正（附加质量 / 铰接 / 偏移偏心 / 变截面 / 抑制） — 参考文档（结构·混合路线）


## 概述

**覆盖范围**：`NodeMass`/`ElemMass`（附加质量）、`NodeJoint`（节点铰接）、`NodeOffset`（节点偏移）、
`ElemNodeOffcenter`/`ElemSectOffcenter`（节点偏心 / 截面偏心）、`ElemNormal`（梁截面法向修正）、
`ElemPenalCoef`（罚单元系数）、`ElemSuppress`（单元抑制）、`TaperGroup`+`TaperShapeChange`（变截面组）、
`Change`（单元/支座生死，用于施工模拟）。

**用途**：在**不改几何**的前提下调整计算模型——设备附加质量、梁端铰接、梁顶与板顶齐平的截面偏心、
变截面梁、临时支撑的生死激活等。

> ★ **路线结论**：模型修正都是"对既有节点/单元的修正"，**混合路线一律写在
> `FemModel.fromViewer()` 之后**，`gnids`/`geids` 用网格后的节点号/单元号
> （`Node.all()` / `Element.all()`，或几何阶段 `Elset` 派生的 `xxx(node)`/`xxx(elem)` 集合）。
> 几何阶段按**构件号**布置（如 `ElemSectOffcenter(geids=[构件号])`）语法上可行，
> 但**是否随网格正确映射未实测**（荷载与 `Fixed` 已实测会映射，见 `loads.md`/`supports.md`）——
> 生产脚本请放有限元阶段，或先用小模型验证。

## 核心 API

实测签名（pypcae 2.1.0，构造一律关键字传参）：

```python
NodeMass(gnids=None, mass=0.0)                     # 节点附加质量（kg / t）
ElemMass(geids=None, mass=0.0)                     # 单元附加质量
NodeJoint(gnids=None, type=0, geids=None)          # 节点铰接：type=JointType.Sphere/BeamEnd；geids=作用单元号
NodeOffset(gnids=None, type=0, offset=None, sita=0.0, axisStart=None, axisEnd=None)
ElemNodeOffcenter(geid, offCenter=None)            # ★ geid 是单个 int（不是列表）
ElemSectOffcenter(geids=None, iType=1, vType=0, value=None)
ElemNormal(normal=None, geids=None)                # ★ 类名是 ElemNormal（没有 BeamNormal）
ElemPenalCoef(coef=None, geids=None)               # coef=[弹性模量, 墙厚, 梁高, 保留系数]
ElemSuppress(geids=None)                           # 被抑制单元不参与计算
TaperShapeChange(pType=0, exp=2.0, SP=1, dist=0.0)
TaperGroup(name='', geids=None, iSec=-1, jSec=-1, eccDir=-1,
           yAxisShape=None, zAxisShape=None)        # ★ 第三参是 jSec（大写 S）
Change(type=1, chType=0, geids=None)               # 生死：挂在 Step(changes=[...]) 上
```

枚举实测成员：`JointType`: `Sphere`（球铰）/ `BeamEnd`（杆端铰）；
`OffsetType`: `Translation`（平移）/ `Rotation`（绕轴旋转）；
`OffcenterType`: `Node / Beam / Shell`；
`OffcenterDir`: `Value`（自定义值）+ 8 种方位 `TopLeft / TopCenter / TopRight / MiddleLeft /
MiddleRight / BottomLeft / BottomCenter / BottomRight`；
`ChangeType`: `Add / Remove`；
`ChangeChType`: `Element / ElasSupport / Contact / Connect / IsolationBearing`
（★ 不只是单元——弹性支座、接触、连接器、隔震支座都能按施工阶段生死）。

| 参数 | 含义与规则 |
|---|---|
| `NodeOffset.offset` / `sita` / `axisStart` / `axisEnd` | `type=Translation` 用 `offset=[dx,dy,dz]`；`type=Rotation` 用 `sita`（角度）+ 转轴起终点 |
| `ElemNodeOffcenter.offCenter` | 该单元**各节点**的 xyz 偏心值（`list[list]`，与单元节点数对应） |
| `ElemSectOffcenter.iType` / `vType` / `value` | `iType=OffcenterType.Node/Beam/Shell`；`vType=OffcenterDir.Value` 时用 `value` 给自定义偏心，否则用 8 种方位之一 |
| `TaperGroup.geids` | ★ 组内单元必须**连续**；`iSec`/`jSec` 为起/止截面号（两个截面都要先建好） |
| `TaperShapeChange` | `pType`: 0 线性 / 1 多项式；`exp`: 多项式指数；`SP`: 对称面位置（1 起点 / 2 终点）；`dist`: 距对称面距离 |
| `ElemSuppress.geids` | 抑制前确认没有荷载/边界作用在被抑制单元上 |

## 代码模板

### 模板 1：设备附加质量 + 梁端铰接（混合路线，FEM 阶段）

```python
# fromViewer() 之后
top_nids = [n.id for n in Node.all() if abs(n.z - Z_TOP) < 1e-6]
NodeMass(gnids=top_nids, mass=500.0)                       # kg（SI）；仅对动力/模态/谱生效

beam_eids = [e.id for e in Element.all() if e.dimension == 1]
end_nid = [n.id for n in Node.all() if abs(n.x - X_END) < 1e-6][0]
NodeJoint(gnids=[end_nid], type=JointType.BeamEnd, geids=beam_eids[-1:])
```

### 模板 2：梁截面偏心（梁顶与板顶齐平）+ 变截面组

```python
ElemSectOffcenter(geids=beam_eids, iType=OffcenterType.Beam, vType=OffcenterDir.TopCenter)

sec_small = Section("H400", SectionType.Line, IShape(mat.id, 8, 400, 200, 13, 200, 13))
sec_big   = Section("H700", SectionType.Line, IShape(mat.id, 12, 700, 300, 20, 300, 20))
TaperGroup(name="taper_1", geids=taper_eids, iSec=sec_small.id, jSec=sec_big.id,
           yAxisShape=TaperShapeChange(pType=0), zAxisShape=TaperShapeChange(pType=0))
```

### 模板 3：施工模拟（分期激活单元与弹性支座）

```python
stage2_elems = [e.id for e in Element.all() if <第二期判据>]
step1 = Step(name="Stage_1",
             changes=[Change(type=ChangeType.Remove, chType=ChangeChType.Element, geids=stage2_elems)],
             loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
step2 = Step(name="Stage_2",
             changes=[Change(type=ChangeType.Add, chType=ChangeChType.Element, geids=stage2_elems)],
             loadCases=[LoadCaseCombine(lc_dl.id, 1.0)], keyInherit=1)      # 继承前一步
analy = Analy(name="Construction", steps=[step1, step2])
# 之后 Job + JobManager（见 analysis.md）
```

## 最佳实践

1. **一律在 `fromViewer()` 之后**按网格后的编号施加；需要按部位批量施加时，
   用几何阶段 `Elset` 派生出的 `xxx(elem)` 集合（见 `shared_api.md` 阶段划分总表）；
2. **附加质量只对动力类分析生效**（模态/谱/时程）；静力分析里加了没有意义；
   单位随单位制（SI kg、mm-t 制 t）；
3. 铰接与抑制都会改变约束路径：改完先跑一次**模态**看前 6 阶是否出现 ≈0 频率（形成机构）；
4. `ElemNodeOffcenter` 的 `geid` 是**单个单元号**（要批量就循环），别传列表；
5. 变截面组的两个截面必须都已定义，且组内单元连续；`jSec` 大小写别写成 `jsec`；
6. 截面偏心方位（`OffcenterDir`）依赖截面局部坐标系，而局部系由 `normal` 推得——
   改过 `ElemNormal` 后要重新确认方位；
7. 施工模拟用 `Change` 挂在 `Step.changes` 上，`chType` 选对对象类型
   （单元 / 弹性支座 / 接触 / 连接器 / 隔震支座），配合 `keyInherit=1` 继承前一步荷载。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `NameError: BeamNormal` | ★ 本版本类名是 **`ElemNormal`**（`BeamNormal`、`LocalCSYS` 都不存在） | 用 `ElemNormal(normal=[...], geids=[...])` |
| `TaperGroup(..., jsec=...)` 报 TypeError | ★ 形参是 **`jSec`**（大写 S） | 关键字写对；或全位置传参 |
| 附加质量不生效 | 做的是静力分析 | 附加质量仅对动力/模态/谱有效 |
| 铰接后奇异 / 位移异常大 | 释放过多形成机构 | 检查该节点剩余约束；`Sphere`（球铰）与 `BeamEnd`（杆端铰）别选错 |
| 变截面组报错 | `geids` 不连续，或 `iSec`/`jSec` 截面未定义 | 组内单元连续；先建两个截面 |
| 偏心方向反了 | `vType` 方位与截面朝向不匹配 | 结合 `ElemNormal`/`normal` 推导局部系后再定方位 |
| 抑制单元后荷载丢失 | 荷载/边界作用在被抑制单元上 | 抑制前检查作用对象 |
| 几何阶段写的修正网格后"消失" | 修正对象是节点/单元，几何阶段还没有网格（是否按构件号映射未实测） | 移到 `fromViewer()` 之后 |
| `Change` 不生效 | 挂错位置（不是 `Step.changes`）或 `chType` 与对象类型不符 | `Step(changes=[Change(...)])`；`chType` 按对象选 |

## 验证清单

- [ ] 全部修正写在 `fromViewer()` 之后，`gnids`/`geids` 是网格后的编号（或派生集合号）
- [ ] 类名用对：`ElemNormal`（非 `BeamNormal`）、`TaperGroup(jSec=...)`、`ElemNodeOffcenter(geid=单个int)`
- [ ] `int` 参数取枚举值（`JointType`/`OffsetType`/`OffcenterType`/`OffcenterDir`/`ChangeType`/`ChangeChType`）
- [ ] 附加质量单位与单位制一致，且分析类型是动力类
- [ ] 铰接/抑制/生死后跑模态确认无刚体模态（前 6 阶不为 0）
- [ ] 变截面组内单元连续、起止截面已定义
