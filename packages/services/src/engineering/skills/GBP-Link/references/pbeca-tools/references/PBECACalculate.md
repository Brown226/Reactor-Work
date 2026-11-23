# PBECACalculate

**工具说明**：进行规定性指标计算或权衡计算。

**调用工具 Json**：
```json
{
    "command": "PBECACalculate",
    "parameters": {
        "CalType": 0
    }
}
```

**参数说明**：

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `CalType` | int | 计算类型：0-规定性指标计算，1-权衡计算 |

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "已完成计算"
}
```
