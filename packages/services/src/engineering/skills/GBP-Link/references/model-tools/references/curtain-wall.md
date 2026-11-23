# CreateCurtainWall — 创建幕墙

**说明**：必须先有标准层才能创建幕墙，当前仅支持直线幕墙和弧形幕墙。参数与普通墙创建工具 `CreateWall` 类似，额外支持网格配置。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |
| `wallType` | string | 是 | 同 CreateWall |
| `linearData` | object | 是 | 同 CreateWall |
| `thickness` | float | 是 | 厚度 |
| `placement` | object | 是 | `{"elevation":3000,"height":1000}` |
| `verticalGrid` | object | 否 | 垂直网格配置 |
| `horizontalGrid` | object | 否 | 水平网格配置 |

**网格配置 (verticalGrid / horizontalGrid)**：

- `alignment`：`start`=起点，`end`=终点，`center`=中心
- `layout`：`fixDistance`=固定距离有梃，`fixNumber`=固定数量有梃，`fixDistanceWithoutJamb`=固定距离无梃，`fixNumberWithoutJamb`=固定数量无梃
- `rotationAngle` (float)：旋转角度
- `spacing` (float)：梃间距
- `mullion`：`{"length":50,"width":200}`

**调用示例**：

```json
{"idStdFlr":"110","wallType":"linear","linearData":{"baseCurve":{"type":"line","datas":{"startPoint":{"x":0,"y":0},"endPoint":{"x":6000,"y":0}}},"slantAngle":90},"thickness":200,"placement":{"elevation":3000,"height":1000},"verticalGrid":{"alignment":"start","layout":"fixDistance","rotationAngle":60,"spacing":1500,"mullion":{"length":50,"width":200}},"horizontalGrid":{"alignment":"start","layout":"fixDistance","rotationAngle":60,"spacing":1500,"mullion":{"length":50,"width":200}}}
```

**成功返回**：

```json
{"idCurtainWall":"112"}
```

# DeleteCurtainWall

**说明**：删除幕墙，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idCurtainWalls` | string[] | 是 | 幕墙 ID 列表 |

**调用示例**：

```json
{"idCurtainWalls":["113","114"]}
```

# SetCurtainWall

**说明**：修改幕墙的属性，支持批量操作。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idCurtainWalls` | string[] | 是 | 幕墙 ID 列表 |
| `thickness` | float | 否 | 厚度 |
| `elevation` | float | 否 | 标高 |
| `height` | float | 否 | 高度 |

除 `idCurtainWalls` 以外，其余均为可选的修改属性。

**调用示例**：

```json
{"idCurtainWalls":["113","114"],"thickness":200,"elevation":0,"height":3300}
```

# GetCurtainWalls

**说明**：查询指定标准层下所有幕墙属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |

**调用示例**：

```json
{"idStdFlr":"110"}
```

# GetCurtainWall

**说明**：查询单个幕墙属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idCurtainWall` | string | 是 | 幕墙 ID |

**调用示例**：

```json
{"idCurtainWall":"115"}
```
