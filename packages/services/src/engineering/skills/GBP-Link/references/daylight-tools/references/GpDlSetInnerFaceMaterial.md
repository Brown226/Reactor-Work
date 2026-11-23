# GpDlSetInnerFaceMaterial

按房间、楼层、房间类型或整栋建筑设置内饰面反射比。若设置的材料不存在于工程中，会自动添加到用户自定义分类。

**请求参数**：

**scope 范围配置**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| scope.type | string | 是 | 范围类型：`wholeBuild`-整栋建筑，`byStandardFloors`-按标准层，`byCommonFloors`-按普通层，`byRoomTypes`-按房间类型 |
| scope.ids | array | 否 | 楼层 ID 或房间类型 ID 列表（string）。为空时：type 为 byStandardFloors/byCommonFloors 时设置所有楼层；type 为 byRoomTypes 且 roomTypes 也为空时设置所有房间类型 |
| scope.roomTypes | array | 否 | 房间类型名称列表（type=byRoomTypes 且 ids 为空时使用） |

**components 材料配置**（每项）：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| componentType | string | 是 | 构件类型：`wall`-墙面，`ceiling`-顶棚，`floor`-地板 |
| material.source | string | 是 | 材料来源 |
| material.name | string | 是 | 材料名称 |
| material.reflectance | number | 是 | 反射比 [0,1] |

**请求示例**：
```json
{
  "command": "GpDlSetInnerFaceMaterial",
  "parameters": {
    "scope": {
      "type": "wholeBuild",
      "ids": ["109", "110", "111"],
      "roomTypes": ["办公室", "走廊"]
    },
    "components": [
      {
        "componentType": "wall",
        "material": {
          "source": "《建筑采光设计标准》GB 5033-2013",
          "name": "白色乳胶漆",
          "reflectance": 0.84
        }
      },
      {
        "componentType": "ceiling",
        "material": {
          "source": "自定义",
          "name": "新科技乳胶漆",
          "reflectance": 0.95
        }
      }
    ]
  }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "内饰面材料设置成功！",
  "result": {
    "setCountCommonFlr": 100,
    "setCountStdFlr": 50
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.setCountCommonFlr | int | 普通层中设置内饰面材料的构件次数 |
| result.setCountStdFlr | int | 标准层中设置内饰面材料的构件次数 |
