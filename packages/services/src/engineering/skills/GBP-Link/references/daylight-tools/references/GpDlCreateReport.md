# GpDlCreateReport

**工具说明**：生成采光及眩光计算分析报告书。该工具执行后**不会弹出对话框阻塞进程**，执行完成后不会打开报告书，直接返回生成的报告书路径列表。报告书默认放在"bdls所在路径\\$bdlsFileName-节能及绿建报告书汇总\\"文件夹下。

**请求示例**：
```json
{
  "command": "GpDlCreateReport",
  "parameters": {}
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "生成报告书成功，共生成 1 份报告书。",
  "result": {
    "reportPaths": [
      "D:\\bdlsFileName-节能及绿建报告书汇总\\采光及眩光计算分析报告书_办公楼A.docx"
    ]
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息，含生成报告数量 |
| result.reportPaths | array | 生成的报告书文件路径列表（string 数组） |
