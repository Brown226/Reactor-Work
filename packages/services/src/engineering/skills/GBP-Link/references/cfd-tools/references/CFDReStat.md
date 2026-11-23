# ReStat

重新统计分析（包含重新生成图片）。当计算结果已存在但需要更新统计结果或重新生成图片时使用。执行完重新统计后，会自动返回与 `GetResult` 相同的统计分析判断结论数据。

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "CFDReStat",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "重新统计分析完成",
  "result": {
    "workConditions": [
      {
        "name": "夏季-西南风",
        "season": "夏季",
        "windDirection": "西南",
        "windSpeed10m": 3.0,
        "isCaled": true,
        "status": "正常结束",
        "beginTime": "2026-10-20 09:00:00",
        "endTime": "2026-10-20 10:30:00",
        "targetJudgments": [
          {
            "targetName": "人行区风速",
            "judgment": "1.5m高度处风速为2.5m/s，满足限值要求",
            "isOk": true
          }
        ]
      }
    ],
    "seasons": [
      {
        "season": "summer",
        "groups": [
          {
            "isOk": true,
            "conclusion": "夏季工况达标"
          }
        ]
      }
    ],
    "score": 80.0,
    "clauseNumber": "4.2.6",
    "finalConclusion": "通过模拟分析，针对《绿色建筑评价标准》GB/T 50378-2019第4.2.6条的评判要求，本项目得分为80分。",
    "isAllOk": true
  }
}
```

## 返回字段说明

返回结果结构与 `GetResult` 完全相同，详见 [GetResult.md](GetResult.md) 的字段说明。

| 字段 | 类型 | 说明 |
|------|------|------|
| `workConditions` | array | 所有工况的详细达标判断数据 |
| `seasons` | array | 季节性分组综合判断结论 |
| `score` | number | 最终评分（仅打分制标准有值） |
| `clauseNumber` | string | 引用的标准条款编号 |
| `finalConclusion` | string | 最终结论文本描述 |
| `isAllOk` | boolean | 是否全部达标 |

## 注意

- 重新统计前会检查授权，授权失败时将返回错误。
- 如果计算结果不存在或统计失败，将返回详细错误信息。

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 验授权失败 |
| 1003 | 重新统计失败: \<具体错误信息\> |
| 1003 | 重新统计异常: \<具体异常信息\> |
