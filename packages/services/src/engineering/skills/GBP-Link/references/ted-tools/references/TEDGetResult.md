# TEDGetResult

获取当前计算结果与结论（不做重新计算，直接提取当前工程已有的结论数据）。返回项目综合结论、规定性设计结论、评价性设计结论和降低热岛强度结论。

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "TEDGetResult",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "获取结论成功",
  "result": {
    "projectConclusions": [
      "通过模拟分析，住区热环境满足《绿色建筑评价标准》GB/T 50378-2019第4.2.6条的要求。",
      "本项目得分为80分。"
    ],
    "standardDesignConclusions": [
      "平均迎风面积比达标，得5分",
      "通风架空率达标，得5分",
      "场地遮阳覆盖率达标，得5分",
      "渗透与蒸发措施完善，得5分",
      "屋顶绿化率达标，得5分",
      "叶面积指数达标，得5分"
    ],
    "performanceEvaluationConclusions": [
      "湿球黑球温度（WBGT）达标，得15分",
      "热岛强度（HII）达标，得15分"
    ],
    "heatIslandReductionConclusions": [
      "降低热岛强度措施满足要求"
    ]
  }
}
```

## 返回字段说明

### result 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectConclusions` | array[string] | 项目综合结论描述列表 |
| `standardDesignConclusions` | array[string] | 规定性设计各项指标的达标结论 |
| `performanceEvaluationConclusions` | array[string] | 评价性设计各项指标的达标结论 |
| `heatIslandReductionConclusions` | array[string] | 降低热岛强度措施的综合结论 |

各项结论的详细含义与 [TEDCompute.md](TEDCompute.md) 中相同。

## 典型使用场景

1. 先调用 `TEDCompute` 执行一键计算；
2. 再调用 `TEDGetResult` 查看计算结果（也可在计算后直接用返回的结果，无需再次调用）；
3. 如果只需要查看已有结论而不触发重新计算，可直接调用本工具。

## 注意事项

- 本工具**不执行计算**，仅返回当前工程已有的结论数据。
- 如果当前工程中没有结论数据，将返回错误。
- 结论内容取决于当前工程选用的绿建标准，不同标准的指标项和评分规则不同。

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 获取结论失败 |
| 1003 | 获取结论异常: \<具体异常信息\> |
