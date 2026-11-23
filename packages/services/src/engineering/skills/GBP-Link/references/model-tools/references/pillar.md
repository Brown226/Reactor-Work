# CreatePillar

**说明**：必须先有标准层，才能创建柱。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |
| `rorateAngle` | float | 是 | 旋转角度 |
| `crossSection` | object | 是 | 截面配置 |
| `placement` | object | 是 | 放置配置 |

**crossSection 结构**：

- `shape` (int)：1=矩形，2=圆形，3=正三角形，4=正五边形，5=正六边形，6=正八边形，7=正十二边形，8=异形
- `datas`：按 shape 变化
  - shape=1：`{"length":600,"width":600}`（矩形截面长、宽）
  - shape=2：`{"diameter":300}`（圆形截面直径）
  - shape=3~7：`{"sideLength":500}`（多边形截面边长）
  - shape=8：`{"outline":[{"x":4000,"y":3000},{"x":5000,"y":4000},{"x":6000,"y":3000},{"x":4000,"y":3000}]}`（异形截面轮廓点坐标）

**placement 结构**：

- `position`：2D 中心定位点
- `elevation` (float), `height` (float)
- `isInclined` (bool)：是否斜柱
- `topPosition` (object, 可选)：斜柱时顶部 3D 定位点

**调用示例**：

矩形柱：

```json
{"idStdFlr":"110","rorateAngle":0,"crossSection":{"shape":1,"datas":{"length":600,"width":600}},"placement":{"position":{"x":3000,"y":3000},"elevation":0,"height":3000,"isInclined":false}}
```

圆形柱：

```json
{"idStdFlr":"110","rorateAngle":0,"crossSection":{"shape":2,"datas":{"diameter":500}},"placement":{"position":{"x":4000,"y":3000},"elevation":0,"height":3000,"isInclined":false}}
```

正多边形柱：

```json
{"idStdFlr":"110","rorateAngle":0,"crossSection":{"shape":3,"datas":{"sideLength":500}},"placement":{"position":{"x":4000,"y":3000},"elevation":0,"height":3000,"isInclined":false}}
```

异形柱：

```json
{"idStdFlr":"110","rorateAngle":0,"crossSection":{"shape":8,"datas":{"outline":[{"x":4000,"y":3000},{"x":5000,"y":4000},{"x":6000,"y":3000},{"x":4000,"y":3000}]}},"placement":{"position":{"x":4000,"y":3000},"elevation":0,"height":3000,"isInclined":false}}
```

**成功返回**：

```json
{"idPillar":"114"}
```

# DeletePillar

**说明**：删除柱，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idPillars` | string[] | 是 | 柱 ID 列表 |

**调用示例**：

```json
{"idPillars":["113","114"]}
```

# SetPillar

**说明**：修改柱的属性，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idPillars` | string[] | 是 | 柱 ID 列表 |
| `rorateAngle` | float | 否 | 旋转角度 |
| `position` | object | 否 | 定位点 |
| `elevation` | float | 否 | 标高 |
| `height` | float | 否 | 高度 |

除 `idPillars` 以外，其余均为可选的修改属性

**调用示例**：

```json
{"idPillars":["115","116"],"rorateAngle":45,"position":{"x":200,"y":200},"elevation":0,"height":2100}
```

# GetPillars

**说明**：查询指定标准层中所有柱属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |

**调用示例**：

```json
{"idStdFlr":"110"}
```

# GetPillar

**说明**：查询单个柱属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idPillar` | string | 是 | 柱 ID |

**调用示例**：

```json
{"idPillar":"115"}
```
