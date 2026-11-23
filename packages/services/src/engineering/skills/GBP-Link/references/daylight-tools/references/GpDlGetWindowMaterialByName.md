# GpDlGetWindowMaterialByName

根据窗框和玻璃名称查询窗体的来源及材料属性。传入的窗框和玻璃名称组合需在窗体材料库中存在。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| frameName | string | 是 | 窗框材料名称 |
| glassName | string | 是 | 玻璃材料名称 |

**请求示例**：
```json
{
  "command": "GpDlGetWindowMaterialByName",
  "parameters": {
    "frameName": "铝窗",
    "glassName": "6mm普通白玻 0.89"
  }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询内饰面材质成功！",
  "result": {
    "material": {
      "source": "《建筑采光设计标准》GB 50033-2013",
      "frameName": "铝窗",
      "glassName": "6mm普通白玻 0.89",
      "transmittance": 0.89,
      "reflectance": 0.08,
      "reductionRatio": 0.75
    }
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.material.source | string | 来源 |
| result.material.frameName | string | 窗框材料名称 |
| result.material.glassName | string | 玻璃材料名称 |
| result.material.transmittance | number | 可见光透射比 |
| result.material.reflectance | number | 可见光反射比 |
| result.material.reductionRatio | number | 挡光折减系数 |