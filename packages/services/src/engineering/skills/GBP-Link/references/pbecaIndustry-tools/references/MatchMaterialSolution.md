# MatchMaterialSolution

**工具说明**：材料设置。

**调用工具 Json**：
```json
{
    "command": "MatchMaterialSolution",
    "parameters": {
      "bdlsPH": 0,  //需要设置哪种建筑类型的材料，公建或者居建0-公建1-居建
      "calType":0   //规定性指标还是强条0-规定性1-权衡强条
    }
}
```

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "已完成材料设置"
}
```
