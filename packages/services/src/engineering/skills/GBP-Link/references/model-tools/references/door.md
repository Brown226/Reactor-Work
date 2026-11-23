# CreateDoor

**说明**：创建门时必须指定所属墙体（如普通墙、幕墙等），门不能独立存在。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWall` | string | 是 | 依附墙体 ID |
| `width` | float | 是 | 门宽 |
| `height` | float | 是 | 门高 |
| `position` | object | 是 | 3D 中心定位点 `{"x":0,"y":0,"z":0}` |
| `seriesName` | string | 是 | 样式名称为空时，系统使用默认门样式；传入样式名称时，必须为 `GetComponentSeriesNames` 返回列表中的有效值 |

**调用示例**：

```json
{"idWall":"111","width":900,"height":2100,"position":{"x":1000,"y":0,"z":0},"seriesName":"<门样式名称>"}
```

**成功返回**：

```json
{"idDoor":"112"}
```

# DeleteDoor

**说明**：删除门，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idDoors` | string[] | 是 | 门 ID 列表 |

**调用示例**：

```json
{"idDoors":["113","114"]}
```

# SetDoor

**说明**：修改门的属性，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idDoors` | string[] | 是 | 门 ID 列表 |
| `width` | float | 否 | 门宽 |
| `height` | float | 否 | 门高 |
| `sillHeight` | float | 否 | 门槛高 |
| `seriesName` | string | 否 | 门样式名称 |

除 `idDoors` 以外，其余均为可选的修改属性

**调用示例**：

```json
{"idDoors":["115"],"width":1000,"height":2100,"sillHeight":0, "seriesName":"<门样式名称>"}
```

# GetDoors

**说明**：查询指定标准层中所有门属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |

**调用示例**：

```json
{"idStdFlr":"110"}
```

# GetDoor

**说明**：查询单个门属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idDoor` | string | 是 | 门 ID |

**调用示例**：

```json
{"idDoor":"115"}
```
