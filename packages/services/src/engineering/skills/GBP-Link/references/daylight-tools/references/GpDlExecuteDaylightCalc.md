# GpDlExecuteDaylightCalc

按当前配置执行采光计算。注意：采用静态或动态计算由项目选择的标准决定，不可通过参数控制。

- 计算完成后默认返回统计分析结果（与调用 `GpDlGetCalcResult` 返回格式一致，按 summary 级别输出用户界面勾选的统计方法的结果）
- 计算结束后不生成报告书

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| calcType | string | 是 | 计算类型：`daylight`-采光计算，`glare`-眩光，`artificiality`-人工照明 |
| returnResult | bool | 否 | 是否在计算完成后直接返回计算结果。默认 true。true 时返回与 GetCalcResult 一致的格式；false 时仅返回计算状态 |

**请求示例**：
```json
{
  "command": "GpDlExecuteDaylightCalc",
  "parameters": { "calcType": "daylight" }
}
```

**返回结果（returnResult=true 时，默认）**：
与 `GpDlGetCalcResult` 接口一致（summary 级别，按用户界面勾选的统计方法输出）。详细字段说明请参考 [GpDlGetCalcResult.md](GpDlGetCalcResult.md)。

**返回结果（returnResult=false 时）**：
```json
{
  "code": 1000,
  "msg": "成功完成计算任务。",
  "result": { "status": "计算完成" }
}
```
