# SetRoad

**说明**：修改道路属性，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idRoads` | string[] | 是 | 道路 ID 数组 |
| `leftWidth` | float | 否 | 道路左宽 |
| `rightWidth` | float | 否 | 道路右宽 |

除 `idRoads` 以外，其余均为可选的修改属性。

**调用示例**：

```json
{"idRoads":["109","110"],"leftWidth":1000,"rightWidth":2000}
```

# GetRoads

**说明**：查询当前工程下所有道路建筑属性。

**参数**：无。