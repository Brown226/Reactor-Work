# GpDlAddCustomInnerFaceMaterial

添加自定义内饰面材料。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | string | 是 | 材料来源 |
| name | string | 是 | 材料名称 |
| reflectance | number | 是 | 反射比，范围 [0,1] |

**请求示例**：
```json
{
  "command": "GpDlAddCustomInnerFaceMaterial",
  "parameters": {
    "source": "某图集",
    "name": "新科技乳胶漆",
    "reflectance": 0.95
  }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "添加自定义内饰面材料成功！",
  "result": {}
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |