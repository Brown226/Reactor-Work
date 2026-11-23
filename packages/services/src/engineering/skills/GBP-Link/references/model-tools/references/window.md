# CreateWindow

**说明**：创建窗时必须指定所属墙体（如普通墙、幕墙等），窗不能独立存在。当前仅支持普通窗、凸窗、转角窗三种类型。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `windowType` | string | 是 | `standard`=普通，`bay`=凸窗，`corner`=转角窗 |
| `datas` | object | 是 | 窗数据（按类型不同） |
| `position` | object | 是 | 3D 中心定位点 |
| `seriesName` | string | 是 | 样式名称为空时，系统使用默认窗样式；传入样式名称时，必须为 `GetComponentSeriesName` 返回列表中的有效值 |

**普通窗 (standard) datas**：

- `idWall` (string)：依附墙体 ID
- `width` (float), `height` (float)
- `isSlant` (bool, 可选), `isArc` (bool, 可选)

调用示例：

```json
{"windowType":"standard","datas":{"idWall":"111","width":1500,"height":1800},"position":{"x":2000,"y":0,"z":900},"seriesName":"<普通窗样式名称>"}
```

**凸窗 (bay) datas**：

- 基础同上 + `bayWidth` (float)：凸出距离
- `shapeStyle`：`rectangle`/`circular`/`triangle`/`trapezium`
- `lWidth` (float, 可选)：梯形时前板宽度

调用示例：

```json
{"windowType":"bay","datas":{"idWall":"111","width":1500,"height":1800,"bayWidth":500,"shapeStyle":"rectangle"},"position":{"x":2000,"y":0,"z":900},"seriesName":"<凸窗样式名称>"}
```

**转角窗 (corner) datas**：

- 基础同上 + `isBay` (bool), `idWall2` (string), `width2` (float), `bayWidth` (float, 可选)，`bayWidth2` (float, 可选)

调用示例：

```json
{"windowType":"corner","datas":{"idWall":"111","width":1500,"height":1800,"isBay":true,"idWall2":"112","width2":1800,"bayWidth":500,"bayWidth2":500},"position":{"x":2000,"y":0,"z":900},"seriesName":"<转角窗样式名称>"}
```

**成功返回**：

```json
{"idWindow":"112"}
```

# DeleteWindow

**说明**：删除窗，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWindows` | string[] | 是 | 窗 ID 列表 |

**调用示例**：

```json
{"idWindows":["113","114"]}
```

# SetWindow

**说明**：修改窗的属性，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWindows` | string[] | 是 | 窗 ID 列表 |
| `width` | float | 否 | 窗宽 |
| `height` | float | 否 | 窗高 |
| `sillHeight` | float | 否 | 窗台高 |

除 `idWindows` 以外，其余均为可选的修改属性

**调用示例**：

```json
{"idWindows":["113","114"],"width":2100,"height":900,"sillHeight":0}
```

# GetWindows

**说明**：查询指定标准层中所有窗属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |

**调用示例**：

```json
{"idStdFlr":"110"}
```

# GetWindow

**说明**：查询单个窗属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWindow` | string | 是 | 窗 ID |

**调用示例**：

```json
{"idWindow":"115"}
```
