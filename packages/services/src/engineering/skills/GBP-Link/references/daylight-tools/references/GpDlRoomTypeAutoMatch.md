# GpDlRoomTypeAutoMatch

**工具说明**：房间类型智能匹配工具。根据其他模块已经设置过的房间类型（默认节能模块）自动匹配房间类型，如果没有模块设置过房间类型，和图纸上提取到的房间名称进行匹配。比如，房间名称为"办公室"的房间自动匹配为办公建筑的"办公室"类型）。匹配完成后返回当前建筑中所有房间类型的分配情况。无需传参。

**请求示例**：
```json
{
  "command": "GpDlRoomTypeAutoMatch",
  "parameters": {}
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "房间类型智能匹配成功！",
  "result": {
    "types": [
      {
        "buildingType": "办公",
        "roomTypes": [
          { "id": "2001", "name": "办公室" },
          { "id": "2002", "name": "走廊" }
        ]
      }
    ]
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.types | array | 按建筑类型分组的房间类型列表（同 GpDlGetAllRoomTypes 返回格式） |
| types[].buildingType | string | 建筑类型名称 |
| types[].roomTypes[].id | string | 房间类型 ID |
| types[].roomTypes[].name | string | 房间类型名称 |
