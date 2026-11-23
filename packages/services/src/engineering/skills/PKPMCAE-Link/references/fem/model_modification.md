# 模型修正 — 参考文档




## 概述

模型修正类用于在不改几何的前提下调整计算模型：附加质量、节点铰接、偏移/偏心、
单元抑制、变截面组等。**全部是对既有节点/单元的"修正"，必须在相应节点单元创建之后调用。**

## 核心 API

### 质量与铰接

```python
NodeMass(gnids=None, mass=0)          # 节点附加质量（动力分析常用，kg）
ElemMass(geids=None, mass=0)          # 单元附加质量
NodeJoint(gnids=None, type=JointType.Sphere, geids=None)
# 节点铰接：type=Sphere 球铰 / BeamEnd 杆端铰；geids 为作用单元号
```

### 偏移与偏心

```python
NodeOffset(gnids=None, type=OffsetType.Translation, offset=None,
           sita=0, axisStart=None, axisEnd=None)
# type=Translation 平移（offset=[dx,dy,dz]）/ Rotation 绕轴旋转（sita 角度 + 转轴起终点）

ElemNodeOffcenter(geid, offCenter=None)     # 单元节点偏心（该单元各节点 xyz 偏心值）
ElemSectOffcenter(geids=None, iType=OffcenterType.Beam,
                  vType=OffcenterDir.Value, value=None)
# 截面偏心：iType=Node/Beam/Shell；vType=Value 自定义或 TopCenter 等 9 种方位

ElemNormal(normal=None, geids=None)         # 梁单元截面法向修正
ElemPenalCoef(coef=None, geids=None)        # 罚单元系数：[弹性模量, 墙厚度, 梁高度, 保留系数]
```

### 单元抑制

```python
ElemSuppress(geids)    # 被抑制单元不参与划分与计算（唯一必填参数 geids）
```

### 梁变截面组

```python
TaperShapeChange(pType=0, exp=2.0, SP=1, dist=0.0)
# pType: 0 线性 / 1 多项式；exp: 多项式指数；SP: 对称面位置(1起点/2终点)；dist: 距对称面距离

TaperGroup(name="", geids=None, iSec=-1, jSec=-1, eccDir=-1,
           yAxisShape=None, zAxisShape=None)
# ★ 首参是 name；关键字是 jSec（大写 S）。写法见 references/fem/known_issues.md #128
# geids 组内单元号必须【连续】；iSec/jSec 起止截面号；eccDir 偏心位置
# 连续性已做反例实测（2026-10-28，#147）：非连续组会让 genfea 报
#   **Error:读取变截面组出错:*taperGroupCoefs:1（exit 0xffffff9c），
#   且 12_TaperGroups.inp 的 *taperGroupCoefs 数据段为空
```

## 代码模板

### 模板 1：顶部设备附加质量

```python
NodeMass(gnids=[n_top.id], mass=500.0)        # kg，设备质量附加到柱顶
```

### 模板 2：梁端铰接（释放转动）

```python
NodeJoint(gnids=[n_beam_end.id], type=JointType.BeamEnd, geids=[e_beam.id])
```

### 模板 3：梁截面顶中偏心（梁顶与板顶齐平）

```python
ElemSectOffcenter(geids=[e.id for e in beams],
                  iType=OffcenterType.Beam, vType=OffcenterDir.TopCenter)
```

### 模板 4：变截面梁组

```python
TaperGroup(name="TG1", geids=taper_beam_ids, iSec=sec_small.id, jSec=sec_big.id,
           yAxisShape=TaperShapeChange(pType=0), zAxisShape=TaperShapeChange(pType=0))
```

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 附加质量不生效 | 静力分析中质量无意义 | 附加质量仅对动力/模态/谱分析生效 |
| 铰接后奇异 | 铰接释放过多形成机构 | 检查该节点剩余约束；球铰 vs 杆端铰别选错 |
| 变截面组报错 `TypeError: __init__() got an unexpected keyword argument 'jsec'` | 照抄了手册/旧文档的小写 `jsec`、或漏了首参 `name` | 用 `TaperGroup(name=..., geids=..., iSec=..., jSec=...)`（#128） |
| `**Error:读取变截面组出错:*taperGroupCoefs:1`（genfea，`exit status 0xffffff9c`） | `geids` 里的单元号**不连续**（如 `[1,2,4]` 跳过 3） | 组内单元号必须连续；不连续就拆成多个 `TaperGroup`（2026-10-28 实测 #147） |
| 偏心方向错 | vType 方位与截面朝向不匹配 | 结合 normal 推导截面局部系后再定方位 |
| 抑制后荷载丢失 | 荷载加在被抑制单元上 | 抑制前检查荷载/边界的作用对象 |

## 验证清单

- [ ] 修正对象（gnids/geids）确实存在且编号正确
- [ ] 附加质量单位与项目单位制一致（SI 为 kg）
- [ ] 铰接/抑制后结构无机构、无刚体模态（可模态分析验证前 6 阶）
- [ ] 变截面组内单元连续，起止截面已定义
- [ ] `TaperGroup` 用 `name=`/`jSec=`（不是 `jsec`），且 `geids` 编号无跳号（跳号 → genfea `读取变截面组出错`）
