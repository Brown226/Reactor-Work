# CreateReport

生成室外声环境模拟计算分析报告书。该工具不弹出界面，也不自动打开报告书，仅在后台执行报告书文件生成。会返回报告书路径

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "SdOutCreateReport",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "报告书生成成功",
  "result": {
    "reportPath": "D:\\新项目-节能及绿建报告书汇总\\室外声环境模拟分析报告_新项目.doc"
  }
}
```


