# GpDlGetAllRoomTypes

查询当前建筑中某模块下的所有房间类型。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| subCate | string | 否 | 子分类名称，对应模块自己的房间类型。不传默认 `"采光"`。 |

**请求示例**：
```json
{
  "command": "GpDlGetAllRoomTypes",
  "parameters": {
    "subCate": "采光"
  }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询当前建筑中某模块下的所有房间类型成功！",
  "result": {
    "types": [
      {
        "buildingType": "医疗",
        "roomTypes": [
          { "id": "1001", "name": "治疗室" },
          { "id": "1002", "name": "诊室" }
        ]
      },
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
| result.types | array | 按建筑类型分组的房间类型列表 |
| types[].buildingType | string | 建筑类型名称 |
| types[].roomTypes[].id | string | 房间类型 ID |
| types[].roomTypes[].name | string | 房间类型名称 |