# GpDlGetDefaultInnerFaceMaterial

查询构件默认的内饰面材料。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| componentType | string | 否 | 构件类型：`wall`-墙面，`ceiling`-顶棚，`floor`-地板。不传则返回所有类型。 |

**请求示例**：
```json
{
  "command": "GpDlGetDefaultInnerFaceMaterial",
  "parameters": { "componentType": "wall" }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询构件默认的内饰面材料成功！",
  "result": {
    "materials": {
      "wall":    { "source": "《建筑采光设计标准》GB 50033-2013", "name": "绿建新国标推荐值：墙面", "reflectance": 0.6 },
      "ceiling": { "source": "《建筑采光设计标准》GB 50033-2013", "name": "绿建新国标推荐值：顶棚", "reflectance": 0.75 },
      "floor":   { "source": "《建筑采光设计标准》GB 50033-2013", "name": "绿建新国标推荐值：地板", "reflectance": 0.3 }
    }
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.materials | object | 各构件的默认内饰面材料，键为构件类型，值为材料信息（source/name/reflectance） |
