# GpDlSetWindowMaterial

设置窗体的透射比、反射比、挡光折减系数。

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| scope.type | string | 是 | 范围类型：`wholeBuild`-整栋建筑，`byStandardFloors`-按标准层，`byCommonFloors`-按普通层，`byTransEntityBDs`-按透明实体 |
| scope.ids | array | 否 | 楼层 ID 或窗体 ID 列表（string 类型）。type 为 wholeBuild/byStandardFloors/byCommonFloors 时可选，默认 wholeBuild；type 为 byTransEntityBDs 时必填 |
| scope.orientations | array | 否 | 朝向筛选：`东`、`南`、`西`、`北`。不传或为空表示所有朝向 |
| components | array | 否 | 构件类型筛选，如 `["外窗","内窗"]`。可选值：外窗、内窗、外门的透明部分、内门的透明部分、外玻璃幕墙、内玻璃幕墙、天窗、凸窗。type=byTransEntityBDs 时忽略 |
| material.frameName | string | 是 | 窗框材料名称 |
| material.glassName | string | 是 | 玻璃材料名称 |
| material.transmittance | number | 否 | 可见光透射比 [0,1]。不传则从材料库中查找 |
| material.reflectance | number | 否 | 可见光反射比 [0,1]。不传则从材料库中查找 |
| material.reductionRatio | number | 否 | 挡光折减系数 [0,1]。不传则从材料库中查找 |

**请求示例**：
```json
{
  "command": "GpDlSetWindowMaterial",
  "parameters": {
    "scope": {
      "type": "wholeBuild",
      "ids": ["10023", "20114"],
      "orientations": ["东", "南"]
    },
    "components": ["外窗", "内窗"],
    "material": {
      "frameName": "铝窗",
      "glassName": "6mm普通白玻 0.89",
      "transmittance": 0.89,
      "reflectance": 0.08,
      "reductionRatio": 0.75
    }
  }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "窗体材料设置成功！",
  "result": { "setCount": 120 }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.setCount | int | 设置的窗体数量 |
