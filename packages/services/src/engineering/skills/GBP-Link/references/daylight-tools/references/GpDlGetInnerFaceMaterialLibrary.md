# GpDlGetInnerFaceMaterialLibrary

查询所有可用的内饰面材料库。

**请求示例**：
```json
{
  "command": "GpDlGetInnerFaceMaterialLibrary",
  "parameters": {}
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询可用的内饰面材料库成功！",
  "result": {
    "library": [
      {
        "source": "《建筑采光设计标准》GB 50033-2013",
        "materials": [
          { "name": "白色乳胶漆", "reflectance": 0.84 },
          { "name": "浅色壁纸", "reflectance": 0.5 },
          { "name": "深色壁纸", "reflectance": 0.3 }
        ]
      },
      {
        "source": "自定义",
        "materials": []
      }
    ]
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.library | array | 材料库列表，按来源分组 |
| library[].source | string | 材料来源 |
| library[].materials | array | 该来源下的材料列表，每项含 name（名称）和 reflectance（反射比） |
