# GpDlGetWindowMaterialLibrary

查询可用的窗体材料库。

**请求示例**：
```json
{
  "command": "GpDlGetWindowMaterialLibrary",
  "parameters": {}
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询可用的窗体材料库成功！",
  "result": {
    "library": [
      {
        "source": "《建筑采光设计标准》GB 50033-2013",
        "materials": [
          { "frameName": "铝窗", "glassName": "6mm普通白玻 0.89", "transmittance": 0.89, "reflectance": 0.08, "reductionRatio": 0.75 },
          { "frameName": "铝窗", "glassName": "12mm透明白玻 0.72", "transmittance": 0.72, "reflectance": 0.08, "reductionRatio": 0.75 },
          { "frameName": "铝窗", "glassName": "6mm超白玻璃 0.91", "transmittance": 0.91, "reflectance": 0.08, "reductionRatio": 0.75 }
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
| result.library | array | 窗体材料库列表，按来源分组 |
| library[].source | string | 材料来源 |
| library[].materials | array | 材料列表，每项包含 frameName（窗框）、glassName（玻璃）、transmittance（可见光透射比）、reflectance（可见光反射比）、reductionRatio（挡光折减系数） |
