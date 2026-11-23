# CreateShading

**说明**：创建遮阳时必须依附某个实体。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idHost` | string | 是 | 遮阳依附的实体 ID |
| `type` | int | 是 | 1=外遮阳 2=百叶遮阳 3=活动遮阳 |
| `datas` | object | 是 | 具体遮阳参数 |

**datas 结构**：

`datas` 由两部分组成：

1. 公共参数：所有遮阳类型均必须提供。
2. 类型参数：根据 type 类型不同填写对应参数。

公共参数（所有 type 必填）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| lightPass | double | 是 | 遮阳透射比，0：完全不透光 1：完全透光 |

**外遮阳（type=1）**：

`datas` 类型参数如下：

- `horizontalWidth` (double)：水平挡板深度
- `verticalDistance` (double)：水平挡板与依附实体的垂直距离
- `verticalWidth` (double)：垂直挡板深度
- `horizontalDistance` (double)：垂直挡板与依附实体的水平距离
- `height` (double)：挑出挡板的高度

调用示例：

```json
{"idHost":"111","type":1,"datas":{"horizontalWidth":1000,"verticalDistance":200,"verticalWidth":1000,"horizontalDistance":200,"height":1000,"lightPass":0.4}}
```

**百叶遮阳（type=2）**：

`datas` 类型参数如下：

- `style` (int)：百叶样式，0=水平，1=垂直
- `distance` (double)：百叶间距
- `width` (double)：百叶宽度
- `angle` (double)：百叶角度

调用示例：

```json
{"idHost":"111","type":2,"datas":{"style":0,"distance":200,"width":200,"angle":90,"lightPass":0.4}}
```

**活动遮阳（type=3）**：

`datas` 类型参数如下：

- `summerSC` (double)：夏季遮阳系数
- `winterSC` (double)：冬季遮阳系数

调用示例：

```json
{"idHost":"111","type":3,"datas":{"summerSC":0.4,"winterSC":0.8,"lightPass":0.4}}
```

**成功返回**：

```json
{"idShadings":["113","114"]}
```

# DeleteShading

**说明**：删除遮阳，支持批量操作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idShadings` | string[] | 是 | 遮阳 ID 列表 |

**调用示例**：

```json
{"idShadings":["113","114"]}
```

# GetShadings

**说明**：查询某个实体中所有遮阳属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idHost` | string | 是 | 依附实体 ID |

**调用示例**：

```json
{"idHost":"115"}
```

# GetShading

**说明**：查询单个遮阳属性。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idShading` | string | 是 | 遮阳 ID |

**调用示例**：

```json
{"idShading":"115"}
```
