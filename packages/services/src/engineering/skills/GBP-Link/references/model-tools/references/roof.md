# CreateRoof

**说明**：必须先有标准层，才能创建屋顶。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |
| `roofType` | string | 是 | 屋顶类型 |
| `elevation` | float | 是 | 标高 |
| `geometry` | object | 是 | 几何参数 |

`point2D` 表示二维点坐标，格式为 `{"x":0,"y":0}`
`point3D` 表示三维点坐标，格式为 `{"x":0,"y":0,"z":0}`

**平屋顶（roofType="flat"）**：

`geometry` 结构如下：

- `boundary` (point2D[])：平屋顶轮廓点坐标集合

**人字坡屋顶（roofType="gable"）**：

`geometry` 结构如下：

- `boundary` (point2D[])：人字坡轮廓点坐标集合
- `dividingLine` (point2D[])：人字坡双坡分界线点坐标集合
- `leftSlopeAngle` (float)：人字坡左坡坡度
- `rightSlopeAngle` (float)：人字坡右坡坡度
- `ridgeElevation` (float)：人字坡分界线标高

**歇山屋顶（roofType="hip"）**：

`geometry` 结构如下：

- `bottomLeft` (point2D)：歇山屋顶主坡左下角点坐标
- `bottomRight` (point2D)：歇山屋顶主坡右下角点坐标
- `topRight` (point2D)：歇山屋顶主坡右上角点坐标
- `gableHeight` (float)：歇山屋顶歇山高
- `slopeAngle` (float)：歇山屋顶主坡坡度
- `sideSlopeAngle` (float)：歇山屋顶侧坡坡度

**攒尖屋顶（roofType="pyramidal"）**：

`geometry` 结构如下：

- `centerPosition` (point2D)：攒尖屋顶位置点坐标
- `sideCount` (int)：攒尖屋顶边数
- `radius` (float)：攒尖屋顶半径
- `slopeAngle` (float)：攒尖屋顶坡度

**多坡屋顶（roofType="multiSlope"）**：

`geometry` 结构如下：

- `boundary` (point2D[])：多坡屋顶轮廓点坐标集合
- `slopeAngles` (float[])：每个坡面的坡度集合
- `heightLimit` (float)：多坡屋顶限制高度

**拉伸屋顶（roofType="extruded"）**：

`geometry` 结构如下：

- `path` (point2D[])：拉伸屋顶路径线点坐标集合
- `extrusionLine` (point2D[])：拉伸屋顶拉伸线点坐标集合
- `extrusionStart` (point2D)：拉伸起点坐标

**斜板屋顶（roofType="slab"）**：

`geometry` 结构如下：

- `boundary` (point3D[])：斜板屋顶轮廓点坐标集合
- `referencePoints` (point3D[])：斜板屋顶定位点，包含点A、B、C

**成功返回**：

```json
{"idRoof":"113"}
```

# DeleteRoof

**说明**：删除屋顶，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idRoofs` | string[] | 是 | 屋顶 ID 列表 |

**调用示例**：

```json
{"idRoofs":["113","114"]}
```

# GetRoofs

**说明**：查询指定标准层下所有屋顶的 ID。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idStdFlr` | string | 是 | 标准层 ID |

**调用示例**：

```json
{"idStdFlr":"110"}
```

# GetRoof

**说明**：查询单个屋顶的属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idRoof` | string | 是 | 屋顶 ID |

**调用示例**：

```json
{"idRoof":"113"}
```
