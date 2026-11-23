# 条件查询（试验功能） — 参考文档（结构·混合路线）


## 概述

按**属性 / 坐标 / 名称**筛选材料、截面、节点、单元，聚合为临时集合，支持并 / 交 / 差运算与拓扑关联查询。
**官方标注为试验功能**：生产脚本优先用 `Nset`/`Elset` 显式分组（几何阶段建、网格后自动派生
`xxx(node)`/`xxx(elem)`，见 `shared_api.md`），查询作为兜底手段，用前先小范围验证。

> ★ **路线结论（2026-10-12 实测，pypcae 2.1.0）**：条件查询在**几何阶段与有限元阶段都能用**。
> 几何阶段实测 `NodeQuery().ge("x", 0.0).ids` 正常返回 `[0, 1]`；
> 有限元阶段（`fromViewer()` 之后）可用来按坐标/维度重筛网格后的节点与单元，
> 是"编号一律重新取"的推荐手段之一。

## 核心 API

```python
from pypcae.query import *        # ★ 查询类在独立模块，pypcae.comp 三件套不导出（否则 NameError）

# 查询实体（scope = 元素列表或 id 列表，默认全部）
MaterialQuery(scope=None)   SectionQuery(scope=None)   NodeQuery(scope=None)   ElemQuery(scope=None)

# 取结果（实测 NodeQuery 的全部公开方法）
.one / .items        # 单个 / 多个元素
.id  / .ids          # 单个 / 多个编号
.all                 # 全部
# 筛选比较器（k = 属性名字符串；可链式）
.eq(k, v, tol=None)  # 等于 —— ★ 实测唯一带 tol 的比较器
.gt(k, v)  .ge(k, v)  .lt(k, v)  .le(k, v)      # 大于/大于等于/小于/小于等于（手册：无 tol）
.min(k, tol)  .max(k, tol)                      # 属性最小/最大的元素 —— ★ 实测 tol 是必传位置参数
# 集合运算
.union(query)  .intersection(query)  .difference(query)
# 拓扑关联
NodeQuery().elems(elems)     # 这些单元包含的节点
ElemQuery().nodes(nodes)     # 这些节点从属的单元
```

实测签名：`eq(self, k, v, tol=None)`、`min(self, k, tol)`；
`NodeQuery` 方法清单：`all / difference / elems / eq / ge / gt / id / ids / intersection / le / lt /
max / min / one / union`。

| 要点 | 说明 |
|---|---|
| 属性名 | 节点坐标是小写 `x` / `y` / `z`（已实测）；其他属性名（单元维度、截面名等）**用前先小范围试**，拼错会返回空集而不报错 |
| `tol` | 只有 `eq` 有；浮点坐标必须给（`tol=1e-6`），否则漏选 |
| `min`/`max` 的 `tol` | **必传位置参数**（`min("z", 1e-6)`），不是关键字、也不能省 |
| 空集 | 查询结果为空时 `.ids` 是空列表 → 施加前先判空，否则"约束/荷载没生效"却查不出原因 |

## 代码模板

### 模板 1：几何阶段按坐标选点布约束 / 荷载

```python
from pypcae.query import *
# 底面全部节点（z = 0，容差 1e-6）→ 固定
Fixed(gnids=NodeQuery().eq("z", 0.0, tol=1e-6).ids, dof=[Dof.All])
# 顶面且 x > 0 的节点（交集）→ 加载
q = NodeQuery().eq("z", H_TOP, tol=1e-6).intersection(NodeQuery().gt("x", 0.0))
lc.add(Cload(gnids=q.ids, dof=[FDof.Fz], value=[-1000.0]))   # ★ 每节点各 -1000 N（不可写 value=[-1000]*N，见 ERRATA #140）
```

### 模板 2：混合路线有限元阶段重筛编号（推荐写法）

```python
FemModel.fromViewer()
# 方式 A：直接遍历（最稳，属性明确）
eids_shell = [e.id for e in Element.all() if e.dimension == 2]
nids_bot   = [n.id for n in Node.all() if n.z <= Z_FIX]
# 方式 B：条件查询（表达式更短）
nids_left  = NodeQuery().eq("x", 0.0, tol=1e-6).ids
eids_by_set = Elset.all()                       # 几何阶段 Elset 派生的 xxx(elem) 集合
# 关联查询：某个面上所有单元 → 这些单元的节点
face_nodes = NodeQuery().elems(face_eids).ids
```

## 最佳实践

1. **能用 `Nset`/`Elset` 显式分组就用集合**：几何阶段建 `Elset(name="hopper", ids=[...])`，
   网格后自动得到 `hopper(elem)`（单元）与 `hopper(node)`（节点），比坐标查询稳且可读；
2. 查询选"面/区域"（如 `z=0` 全部节点）比手工维护 id 列表稳，但**必须给 `tol`**；
3. 施加前**先核对数量**：`len(ids)` 与几何推导值一致才继续（调试期可在 Agent 侧打印，
   脚本内禁止 `print()`）；
4. 结果为空要显式处理（`if ids:`），否则会静默"没施加"；
5. 复杂筛选优先用 Python 列表推导（`[e.id for e in Element.all() if e.dimension == 3 and ...]`）——
   可读性与可控性都比链式查询好，查询类留给"按属性极值/集合运算"的场景；
6. 查询是**试验功能**：跨版本升级后先跑一遍小模型确认行为未变。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `NameError: name 'NodeQuery' is not defined` | 查询类在独立模块 | `from pypcae.query import *` |
| 查不到元素 / 结果为空 | 属性名拼写错（大小写敏感，坐标是小写 `x/y/z`）；或没给 `tol` | 核对属性名；`eq` 加 `tol=1e-6` |
| 边界节点漏选 | 浮点比较无容差 | 用 `eq(..., tol=)`，或 `ge`+`le` 夹出区间 |
| `min("z")` 报缺参数 | ★ `tol` 是必传位置参数 | `min("z", 1e-6)` |
| `gt("x", 0, tol=1e-6)` 报 TypeError | `gt/ge/lt/le` 无 `tol` 形参 | 只有 `eq` 支持 `tol` |
| 荷载/约束"没生效" | 查询返回空集就直接施加了 | 先 `len(ids)` 核对，`if ids:` 再施加 |
| 网格后查询结果与几何阶段不一致 | `fromViewer()` 内部先 `clc()`，编号与对象全部重建 | 网格后重新查询，不要复用几何阶段的 id 列表 |

## 验证清单

- [ ] `from pypcae.query import *` 已加（独立模块）
- [ ] `eq` 给了 `tol`；`min`/`max` 的 `tol` 按位置传
- [ ] 查询结果数量与几何推导一致（施加前核对）
- [ ] 关键分组优先用 `Nset`/`Elset` 显式定义，查询只作兜底
- [ ] 混合路线中，网格后的查询在 `fromViewer()` **之后**重新执行
