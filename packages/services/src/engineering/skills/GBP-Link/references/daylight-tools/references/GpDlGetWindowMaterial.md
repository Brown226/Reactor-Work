# GpDlGetWindowMaterial

查询窗体的材料及其属性。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ids | array | 是 | 需要查询的窗体 ID 列表（string 类型） |

**请求示例**：
```json
{
  "command": "GpDlGetWindowMaterial",
  "parameters": { "ids": ["2001"] }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询窗体材料成功！",
  "result": {
    "windows": [
      {
        "idWindow": "2001",
        "material": {
          "frameName": "铝窗",
          "glassName": "6mm普通白玻 0.89",
          "transmittance": 0.89,
          "reflectance": 0.08,
          "reductionRatio": 0.75
        }
      }
    ]
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.windows | array | 窗体材料列表 |
| windows[].idWindow | string | 窗体 ID |
| windows[].material.frameName | string | 窗框材料名称 |
| windows[].material.glassName | string | 玻璃材料名称 |
| windows[].material.transmittance | number | 可见光透射比 |
| windows[].material.reflectance | number | 可见光反射比 |
| windows[].material.reductionRatio | number | 挡光折减系数 |