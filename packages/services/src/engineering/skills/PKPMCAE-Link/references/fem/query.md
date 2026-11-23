# 条件查询（试验功能）— 参考文档




## 概述

按属性/坐标/名称筛选材料、截面、节点、单元，聚合为临时集合，支持并/交/差运算。
**官方标注为试验功能**：生产脚本优先用 `Nset`/`Elset` 显式分组；查询作兜底，用前先验证。

## 核心 API

```python
from pypcae.query import *        # ⚠️ 查询类在独立模块，comp 三件套不导出（否则 NameError）

# 查询实体（scope = 元素或 id 列表，默认全部）
MaterialQuery(scope=None)
SectionQuery(scope=None)
NodeQuery(scope=None)
ElemQuery(scope=None)

# 取结果
.one / .items      # 单个 / 多个元素
.id  / .ids        # 单个 / 多个编号

# 筛选比较器（k=属性名字符串，tol=容差；可链式）
.eq(k, v, tol=None)   # 等于（唯一支持 tol 的比较器）
.gt(k, v)             # 大于（无 tol！）
.ge(k, v)             # 大于等于（无 tol！）
.lt(k, v)             # 小于（无 tol！）
.le(k, v)             # 小于等于（无 tol！）
.min(k, tol)          # 属性最小的元素（tol 必传位置参数）
.max(k, tol)          # 属性最大的元素（tol 必传位置参数）

# 集合运算
.union(query)         # 并
.intersection(query)  # 交
.difference(query)    # 差

# 拓扑关联
NodeQuery().elems(elems)   # 这些单元包含的节点
ElemQuery().nodes(nodes)   # 这些节点从属的单元
```

## 代码模板

```python
# 1. 按坐标范围选节点（0 ≤ x ≤ 10）
sel = NodeQuery().ge("x", 0.0).le("x", 10.0).ids

# 2. 顶面节点（z = H，容差 1e-6）
top_ids = NodeQuery().eq("z", H, tol=1e-6).ids

# 3. 交集：顶面且 x>0
q = NodeQuery().eq("z", H, tol=1e-6).intersection(NodeQuery().gt("x", 0.0))
corner_ids = q.ids

# 4. 施加到查询结果
Fixed(gnids=NodeQuery().eq("z", 0.0, tol=1e-6).ids, dof=[Dof.All])
```

## 最佳实践

- 用查询选**面**（如"z=0 全部节点"）比手工维护列表更稳；
- tol 别省：浮点坐标用 `tol=1e-6` 防漏选；
- 查询结果先打印核对数量（调试期），确认后删除调试代码（禁止 print 上生产脚本——
  可在开发环境用，交付前删除）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 查不到元素 | 属性名拼写错（x/y/z 小写） | 核对属性名 |
| 边界漏选 | 没给容差 | eq/ge/le 加 tol |
| 结果为空集后用错 | 未判空 | 先 `if ids:` 再施加 |

## 验证清单

- [ ] tol 已设置
- [ ] 查询结果数量符合预期（与几何推导一致）
- [ ] 关键分组优先用 Nset/Elset 显式定义
