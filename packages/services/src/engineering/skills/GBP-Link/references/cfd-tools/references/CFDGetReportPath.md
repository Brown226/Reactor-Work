# GetReportPath

获取报告书文件路径，并检查报告书文件是否存在。该工具不生成报告书，仅查询已生成的报告书文件。

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "CFDGetReportPath",
  "parameters": {}
}
```

## 返回结果

报告书存在时：
```json
{
  "code": 1000,
  "msg": "报告书存在",
  "result": {
    "reportPath": "D:\\bdlsFileName-节能及绿建报告书汇总\\室外风环境模拟分析报告_projectName.doc",
    "exist": true
  }
}
```

报告书不存在时：
```json
{
  "code": 1000,
  "msg": "报告书不存在",
  "result": {
    "reportPath": "D:\\bdlsFileName-节能及绿建报告书汇总\\室外风环境模拟分析报告_projectName.doc",
    "exist": false
  }
}
```

## 返回字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `reportPath` | string | 报告书文件的完整路径（即使文件不存在也会返回预期路径） |
| `exist` | boolean | 报告书文件是否真实存在于磁盘上 |

## 典型使用场景

1. 先用 `CFDCreateReport` 生成报告书；
2. 再用 `GetReportPath` 获取报告书路径；
3. 根据返回的 `reportPath` 打开或分享报告书文件。

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 获取报告书路径异常: \<具体异常信息\> |
