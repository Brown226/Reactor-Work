# CreateWall

**说明**：必须先有标准层才能创建墙，当前仅支持直线墙和弧形墙。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |
| `wallType` | string | 是 | `linear`=线性墙，其余类型暂不支持 |
| `linearData` | object | 是 | 线性数据（见下方） |
| `isShear` | bool | 是 | 是否为剪力墙 |
| `thickness` | float | 否 | 墙厚，默认 200mm |
| `placement` | object | 是 | 布置数据（见下方）|

**linearData 结构**：

- `baseCurve.type`：`"line"`=直线，`"arc"`=弧线
- **直线** datas：`startPoint`, `endPoint`（2D 坐标）
- **弧线** datas：`center`, `radius`, `startAngle`, `endAngle`, `isClockwise`
- `slantAngle`：倾斜角，正常墙为 90
  
**placement 结构**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `elevation` | float | 是 | 墙体底部标高，相对于标准层局部坐标系 |
| `height` | float | 是 | 墙体高度 |

**调用示例**：

直线墙：

```json
{"idStdFlr":"110","wallType":"linear","linearData":{"baseCurve":{"type":"line","datas":{"startPoint":{"x":0,"y":0},"endPoint":{"x":5000,"y":0}}},"slantAngle":90},"isShear":false,"thickness":200,"placement":{"elevation":0,"height":3300}}
```

弧形墙：

```json
{"idStdFlr":"110","wallType":"linear","linearData":{"baseCurve":{"type":"arc","datas":{"center":{"x":2500,"y":0},"radius":2500,"startAngle":0,"endAngle":180,"isClockwise":false}},"slantAngle":90},"isShear":false,"thickness":200,"placement":{"elevation":0,"height":3300}}
```

**成功返回**：

```json
{"idWall":"111"}
```

# DeleteWall

**说明**：删除普通墙，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWalls` | string[] | 是 | 普通墙 ID 列表 |

**调用示例**：

```json
{"idWalls":["113","114"]}
```

# SetWall

**说明**：修改普通墙的属性，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWalls` | string[] | 是 | 普通墙 ID 列表 |
| `thickness` | float | 否 | 墙厚 |
| `elevation` | float | 否 | 标高 |
| `height` | float | 否 | 高度 |
| `isShear` | bool | 否 | 是否为剪力墙 |

除 `idWalls` 以外，其余均为可选的修改属性。

**调用示例**：

```json
{"idWalls":["111","112"],"thickness":200,"elevation":0,"height":3300,"isShear":true}
```

# GetWalls

**说明**：查询指定标准层下所有普通墙属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |

**调用示例**：

```json
{"idStdFlr":"110"}
```

# GetWall

**说明**：查询单个普通墙属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idWall` | string | 是 | 普通墙 ID |

**调用示例**：

```json
{"idWall":"115"}
```
