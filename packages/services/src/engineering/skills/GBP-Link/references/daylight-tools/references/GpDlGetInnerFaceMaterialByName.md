# GpDlGetInnerFaceMaterialByName

根据内饰面名称查询材料全部信息。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 内饰面名称，需在软件内饰面库中存在 |

**请求示例**：
```json
{
  "command": "GpDlGetInnerFaceMaterialByName",
  "parameters": { "name": "白色乳胶漆" }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询内饰面材料成功！",
  "result": {
    "material": {
      "source": "《建筑采光设计标准》GB 50033-2013",
      "name": "白色乳胶漆",
      "reflectance": 0.84
    }
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.material.source | string | 材料来源 |
| result.material.name | string | 材料名称 |
| result.material.reflectance | number | 反射比 |
