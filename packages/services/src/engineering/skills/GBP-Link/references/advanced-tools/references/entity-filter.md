# EntityFilter

**说明**：根据条件筛选建筑中所有实体，并在对话框中展示筛选结果，无需返回任何数据。当前支持同时筛选多种类型的实体。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `category` | int[] | 是 | 筛选实体类别，1=楼板，2=门，3=窗 |
| `option` | object | 是 | 筛选参数，字段根据 `category` 类型动态变化 |

**楼板（category=[1]）**：

`option` 支持：

| 参数 | 类型 | 说明 |
|------|------|------|
| `boardType` | int | 楼板类型，1=普通楼板，2=架空楼板，3=地面 |

调用示例：

```json
{"category":[1],"option":{"boardType":2}}
```

**门（category=[2]）**：

`option` 支持：

| 参数 | 类型 | 说明 |
|------|------|------|
| `isTransparent` | bool | 是否有透明部分 |

调用示例：

```json
{"category":[2],"option":{"isTransparent":true}}
```

**窗（category=[3]）**：

`option` 支持：

| 参数 | 类型 | 说明 |
|------|------|------|
| `isShadingCoeff` | bool | 是否带有遮阳 |

调用示例：

```json
{"category":[3],"option":{"isShadingCoeff":true}}
```

**同时筛选多种类型实体**：

```json
{"category":[1, 2, 3],"option":{"boardType": 1,"isTransparent":false,"isShadingCoeff":true}}
```

> 当前工具仅支持楼板、门和窗三种实体类型的过滤，且仅支持对应专属筛选条件，如楼板按类型筛选，门按是否含透明部分筛选、窗按是否带遮阳筛选，用户提及其他实体类型或筛选条件时，需如实告知当前工具支持范围。
