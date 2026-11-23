# GpDlAutoDaylightCalc / GpDlAutoDaylightCalc_Formula / GpDlAutoDaylightCalc_Simulate

三个一键采光计算工具**共用本文档**。三者的请求参数、调用方式与返回结构完全一致，仅自动应用的计算配置不同（见下表）。

## 三个工具的差异

| 工具 | 自动设置的计算配置 | 适用场景 |
|------|--------------------|----------|
| `GpDlAutoDaylightCalc` | 不修改配置，按项目当前设置计算 | 常规一键计算 |
| `GpDlAutoDaylightCalc_Formula` | 仅公式法：calcMethod.formula=true、calcMethod.simulate=false；统计方法仅勾选 gb50033 | 方案阶段快速计算 |
| `GpDlAutoDaylightCalc_Simulate` | 仅模拟法：calcMethod.simulate=true；统计方法按绿建统计法（gbt5699=true） | 详细采光分析 |

## 共同行为

- 仅执行采光计算（模拟法会同时进行稳态 + 全年动态计算，不含眩光）
- 如果当前项目没有设置计算范围，默认按全楼计算
- 如果没有进行房间类型设置（没有主要功能房间），会自动进行房间类型智能匹配
- 计算完成后默认返回统计分析结果（与调用 `GpDlGetCalcResult` 返回格式一致，summary 级别）
- 计算结束后不生成报告书。若需生成报告书，调用`GpDlCreateReport`，接口说明详见references/GpDlCreateReport.md。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| returnResult | bool | 否 | 是否在计算完成后直接返回计算结果。默认 true。true 时返回与 GetCalcResult 一致的格式；false 时仅返回计算状态 |

**请求示例**（三个工具仅 `command` 值不同，参数均为空对象）：
```json
{
  "command": "GpDlAutoDaylightCalc",
  "parameters": {}
}
```

## 返回结果

**returnResult=true（默认）**：与 `GpDlGetCalcResult` 接口一致（summary 级别），详细字段说明参考 [GpDlGetCalcResult.md](GpDlGetCalcResult.md)。各工具返回的统计方法：

- `GpDlAutoDaylightCalc`：按用户界面勾选的统计方法输出
- `GpDlAutoDaylightCalc_Formula`：返回 `gb50033`（国标公式法统计）结果
- `GpDlAutoDaylightCalc_Simulate`：返回 `gbt5699`（绿建统计法）结果

**returnResult=false 时**：
```json
{
  "code": 1000,
  "msg": "成功完成计算任务。",
  "result": { "status": "计算完成" }
}
```
