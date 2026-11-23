# 节点、单元与工具类 — 参考文档




## 概述

覆盖 `Node` / `Element` / 集合（`Nset`/`Elset`）/ 局部坐标系（`Csys`）/
接触单元与表面（`Contactor`/`ContactSet`）/ 曲线（`DataCurve`）。

## 核心 API

### 节点 Node

```python
Node(x: float, y: float, z: float)     # 坐标（默认 m；z 竖直向上）
```

- 按创建顺序自动编号（从 1 开始）；引用必须 `node.id`，禁止硬编码数字；
- **相连构件在连接点必须共享同一个 `Node` 对象**——同坐标重复 `Node(...)` 会产生
  零长度单元，modelcheck 报"单元法向有错"。

### 单元 Element

```python
Element(nids: list[int], type: int = ElementType.Link, sid: int = -1, normal=None)
```

- `nids`：节点编号列表（2 节点梁/杆传 2 个；4 节点壳传 4 个；8 节点实体传 8 个）；
- `sid`：截面编号 `sec.id`；
- `normal`：梁单元为截面局部 y 方向；壳单元为面外法向（局部 z 向）。

常用单元类型：

| 枚举 | 用途 | nids |
|---|---|---|
| `Link` | 桁架杆（仅轴力） | 2 |
| `BeamEuler` | 梁柱（弯剪扭） | 2 |
| `BeamTimoshenko` | 深梁（计剪切变形） | 2 |
| `BeamLink` | 梁杆 | 2 |
| `Cable` / `CableCatenary` | 索 | 2 |
| `Pipe` | 管 | 2 |
| `ShellAssembled` | 组合壳（常用） | 4 |
| `ShellDegenerated` | 退化壳 | 4 |
| `PlateMitc` | MITC 板 | 4 |
| `Membrane` | 膜 | 4 |
| `Solid` | 三维实体 | 8 |
| `PlaneClassic` | 平面应力 | 4 |
| `PlaneStress2D` / `PlaneStrain2D` | 二维平面应力/应变 | - |
| `Penalty` | 罚单元 | - |

### 集合 Nset / Elset

```python
Nset(name: str, ids: list[int] = None)      # 节点集合
Elset(name: str, ids: list[int] = None)     # 单元/构件集合
```

- 只接受**整数 ID 列表**，禁止传对象列表；
- `add()` 逐个添加**单个 int**：`nset.add(node.id)` ✅；`nset.add([1,2,3])` ❌。

### 局部坐标系 Csys

```python
Csys(name: str, iType: int = LOCALCSYS.Cartesian, xAxis=None, yAxis=None)
```

**三个坐标系枚举别搞混**：

| 枚举 | 成员 | 用在哪 |
|---|---|---|
| `CSYS` | `GlobalSystem` / `LocalCoordinateSystem` | 荷载类的 `iCoord` |
| `LOCALCSYS` | `Cartesian` / `Cylindrical` / `Spherical` | `Csys.iType` |
| `ConnCoordType` | `Auto` / `Fixed` / `Follow` | `Connector.iCoord` |

### 接触单元与表面

```python
Contactor(att: int, side: int = None, nids: list[int] = None)
# att=附着单元号；side=附着单元表面号（面单元正1反2，四面体1~4，六面体1~6）；
# side 缺省时用 nids 确定（面单元顺时针对应正向）

ContactSet(name: str, contactors: list[Contactor] = None)   # 表面，供相互作用引用
```

### 曲线 DataCurve

```python
DataCurve(name: str, data: list[list[float]] = None)   # 材料曲线/荷载曲线/自定义截面
```

## 代码模板

### 模板 1：参数化节点阵列 + 梁单元链

```python
SPAN, N = 6.0, 6          # m，6 等分
nods = [Node(i * SPAN / N, 0.0, 0.0) for i in range(N + 1)]
elems = [Element(nids=[nods[i].id, nods[i + 1].id],
                 type=ElementType.BeamEuler, sid=sec.id) for i in range(N)]
Elset("AllBeams", [e.id for e in elems])
```

### 模板 2：壳单元网格（m×n 四边形）

```python
L, B, NX, NY = 1.0, 1.0, 20, 20          # m
nods = []
for i in range(NX + 1):
    for j in range(NY + 1):
        nods.append(Node(i * L / NX, j * B / NY, 0.0))
for i in range(NX):
    for j in range(NY):
        Element(nids=[nods[(NY+1)*i + j].id, nods[(NY+1)*(i+1) + j].id,
                      nods[(NY+1)*(i+1) + j+1].id, nods[(NY+1)*i + j+1].id],
                type=ElementType.ShellAssembled, sid=sec.id)
```

### 模板 3：8 节点实体块

```python
# n1..n8 为角点节点（先底面 4 点、后顶面 4 点）
Element(nids=[n1.id, n2.id, n3.id, n4.id, n5.id, n6.id, n7.id, n8.id],
        type=ElementType.Solid, sid=sec.id)
```

## 最佳实践

1. 节点由循环/函数生成时，把节点对象存入 list 并建立**索引规则注释**；
2. 连接点从同一 list 中取节点对象，天然满足"共享 Node"铁律；
3. 集合命名语义化（`"AllBeams"`/`"TopSlab"`），后续荷载/约束按集合施加。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| modelcheck"单元法向有错/零长度单元" | 同坐标重复建 Node | 共享 Node 对象 |
| 集合报错 | `Elset` 传了对象列表或 `add(list)` | 传 `[e.id ...]`；`add` 逐个 int |
| 壳单元结果方向混乱 | 单元法向不一致 | 统一节点绕序（右手螺旋），必要时用 `normal` |
| 局部坐标系不生效 | 误用 `CSYS` 枚举 | `Csys.iType` 用 `LOCALCSYS` |

## 验证清单

- [ ] 节点总数与参数推导一致（如 (N+1) 个、网格 (NX+1)*(NY+1) 个）
- [ ] 连接点共享 Node
- [ ] 集合成员为 int id
- [ ] 壳单元绕序一致（法向统一）
