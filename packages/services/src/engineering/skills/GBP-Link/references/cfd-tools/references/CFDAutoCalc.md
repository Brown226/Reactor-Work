# AutoCalc

执行一键计算（计算、统计、分析判断全流程）。自动创建 OpenFOAM 计算对话框，设置自动启动和自动关闭模式，计算完成后自动关闭对话框并返回统计分析判断结论。

## 请求参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `forceRecalc` | 否 | `false` | 是否强制所有工况重新计算。`true`-清除已有计算结果后重新计算；`false`-仅计算未完成的工况 |

## 请求示例

```json
{
  "command": "CFDAutoCalc",
  "parameters": {}
}
```

强制重新计算：
```json
{
  "command": "CFDAutoCalc",
  "parameters": {
    "forceRecalc": true
  }
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "一键计算完成",
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
          },
          {
            "targetName": "风速放大系数",
            "judgment": "风速放大系数为1.8，满足限值要求",
            "isOk": true
          },
          {
            "targetName": "建筑前后压差",
            "judgment": "建筑迎背风面压差为1.5Pa，满足限值要求",
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

### result 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `workConditions` | array | 所有工况的详细达标判断数据，见下方 workConditions 说明 |
| `seasons` | array | 季节性分组综合判断结论 |
| `score` | number | 最终评分（仅打分制标准有值） |
| `clauseNumber` | string | 引用的标准条款编号 |
| `finalConclusion` | string | 最终结论文本描述 |
| `isAllOk` | boolean | 是否全部达标 |

### workConditions[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 工况名称 |
| `season` | string | 所属季节（夏季/过渡季/冬季/春季/秋季） |
| `windDirection` | string | 风向（中文，如"西南"、"东北"） |
| `windSpeed10m` | number | 10m 高度处入口风速（m/s） |
| `isCaled` | boolean | 是否已计算完成 |
| `status` | string | 计算状态（正常结束、用户终止、异常结束等） |
| `beginTime` | string | 计算开始时间 |
| `endTime` | string | 计算结束时间 |
| `targetJudgments` | array | 各项指标的达标判断结果 |

### targetJudgments[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `targetName` | string | 指标名称（如"人行区风速"、"风速放大系数"等） |
| `judgment` | string | 判断详细描述 |
| `isOk` | boolean | 是否达标 |

### seasons[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `season` | string | 季节标识 |
| `groups` | array | 该季节下的判断分组 |
| `groups[].isOk` | boolean | 该组是否达标 |
| `groups[].conclusion` | string | 该组判断结论描述 |

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 当前没有计算工况，请先创建工况 |
| 1003 | Stream 内核已不再使用，仅支持 OpenFOAM 内核 |
| 1003 | 验授权失败 |
| 1003 | 一键计算异常: \<具体异常信息\> |
