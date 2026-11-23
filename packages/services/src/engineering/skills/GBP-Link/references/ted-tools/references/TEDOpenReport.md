# TEDOpenReport

打开现有报告书文件。检查报告书文件是否存在，存在则直接使用系统默认程序打开（通常为 Word）。

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "TEDOpenReport",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "报告书已打开"
}
```

## 说明

- 该工具会检查报告书文件是否真实存在于磁盘上；
- 如果不存在，会返回错误信息，提示用户先生成报告书；
- 打开操作使用 `GpExt::ReportFile::OpenReport` 接口，不会弹出额外提示框；
- 典型的完整流程为：`TEDCompute` → `TEDCreateReport` → `TEDOpenReport`。

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 报告书不存在，请先生成报告书 |
| 1003 | 打开报告书异常: \<具体异常信息\> |
