# BatchCalculationBuildings

**工具说明**：批量计算。

**调用工具 Json**：
```json
{
    "command": "BatchCalculationBuildings",
    "parameters": {
      "bdlPath": "D:\\test\\bdls" ,    //文件路径
      "calConfig":0,                   //0-规定性指标+权衡，1-但规定性，2-单权衡
      "localBdls":1                    //是否包含打开的模型0-不包含 1-包含
    }
}
```

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "已完成批量计算",
  "result": 10  // 完成批量计算数量
}
```
