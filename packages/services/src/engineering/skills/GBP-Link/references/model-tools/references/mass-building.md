# SetBuildingMass

**说明**：修改体量建筑属性，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idBuilds` | string[] | 是 | 体量建筑 ID 数组|
| `elevation` | float | 否 | 标高 |
| `height` | float | 否 | 高度 |

除 `idBuilds` 以外，其余均为可选的修改属性。

**调用示例**：

```json
{"idBuilds":["109","110"],"elevation":1000,"height":3000}
```

# GetBuildingMasses

**说明**：查询当前工程下所有体量建筑属性。

**参数**：无。
