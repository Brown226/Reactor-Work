# SetProjectProperties

**说明**：修改当前项目的基本属性，包括项目名称、所属省份、城市、城市别名、经纬度、海拔高度信息。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
| ------ | ------ | ------ | ------ |
| `projectName` | string | 否 | 项目名称 |
| `province` | string | 否 | 项目所属省份名称 |
| `city` | string | 否 | 项目所属城市名称，指定城市时必须同时指定所属省份 |
| `cityUser` | string | 否 | 城市别名，用于表示城市的其他名称或自定义名称 |
| `longitude` | float | 否 | 项目经度，单位为度(°)。东经使用正值，西经使用负值 |
| `latitude` | float | 否 | 项目纬度，单位为度(°)。北纬使用正值，南纬使用负值 |
| `altitude` | float | 否 | 项目海拔高度，单位为毫米(mm) |
| `landUseNature` | int | 否 | 项目用地性质。0=其他用地，1=居住用地，3=工业用地，-1=无用 |

**调用示例**：

```json
{"projectName":"PROJ-1","province":"福建","city":"厦门","cityUser":"厦门","longitude":118.0894,"latitude":24.4798,"altitude":5000,"landUseNature":1}
```

# GetProjectProperties

**说明**：查询当前项目的基本属性，包括项目名称、所属省份、城市、城市别名、经纬度、海拔高度信息。

**参数**：无

**成功返回**：

```json
{"projectName":"PROJ-1","province":"福建","city":"厦门","cityUser":"厦门","longitude":118.0894,"latitude":24.4798,"altitude":5000,"landUseNature":1}
```

# SaveProject

**说明**：保存当前工程。若保存失败，即可能当前工程未存在于本地。

**参数**：无。
