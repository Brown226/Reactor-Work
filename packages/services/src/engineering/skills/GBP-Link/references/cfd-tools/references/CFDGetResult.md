# GetResult

获取统计分析判断结论。返回每个工况的各项指标达标判断、季节性分组综合判断结论、评分和最终结论。该工具会自动完成达标判断（`AnalyseAllWorkCondition`），如果已计算过则直接返回已有结论。

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "CFDGetResult",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "获取结论成功",
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
          },
          {
            "targetName": "涡旋",
            "judgment": "无明显涡旋区域",
            "isOk": true
          },
          {
            "targetName": "无风区",
            "judgment": "无风区面积占比5%，满足限值要求",
            "isOk": true
          },
          {
            "targetName": "外窗压力差",
            "judgment": "外窗压力差满足要求",
            "isOk": true
          }
        ]
      },
      {
        "name": "冬季-东北风",
        "season": "冬季",
        "windDirection": "东北",
        "windSpeed10m": 3.5,
        "isCaled": true,
        "status": "正常结束",
        "beginTime": "2026-10-20 10:30:00",
        "endTime": "2026-10-20 12:00:00",
        "targetJudgments": [
          {
            "targetName": "人行区风速",
            "judgment": "1.5m高度处风速为2.8m/s，满足限值要求",
            "isOk": true
          },
          {
            "targetName": "风速放大系数",
            "judgment": "风速放大系数为2.0，满足限值要求",
            "isOk": true
          },
          {
            "targetName": "建筑前后压差",
            "judgment": "建筑迎背风面压差为2.0Pa，满足限值要求",
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
            "conclusion": "夏季工况风速、风速放大系数、建筑前后压差、涡旋、无风区、外窗压力差均达标"
          }
        ]
      },
      {
        "season": "winter",
        "groups": [
          {
            "isOk": true,
            "conclusion": "冬季工况风速、风速放大系数、建筑前后压差均达标"
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
| `workConditions` | array | 所有工况的详细达标判断数据 |
| `seasons` | array | 季节性分组综合判断结论 |
| `score` | number | 最终评分（仅打分制标准有值，否则为0） |
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
| `status` | string | 计算状态（未计算、计算中、正常结束、异常结束、用户终止等） |
| `beginTime` | string | 计算开始时间 |
| `endTime` | string | 计算结束时间 |
| `targetJudgments` | array | 各项指标的达标判断结果 |

### targetJudgments[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `targetName` | string | 指标名称（如"人行区风速"、"风速放大系数"、"建筑前后压差"、"涡旋"、"无风区"、"外窗压力差"等） |
| `judgment` | string | 判断详细描述 |
| `isOk` | boolean | 是否达标 |

### seasons[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `season` | string | 季节标识（如 summer, winter, transition 等） |
| `groups` | array | 该季节下的判断分组 |
| `groups[].isOk` | boolean | 该组是否达标 |
| `groups[].conclusion` | string | 该组判断结论描述 |

### finalConclusion 说明

- **打分制标准**（如 GB/T 50378-2019）：返回"通过模拟分析，针对《标准名称》第X.X.X条的评判要求，本项目得分为XX分。"
- **非打分制标准**：返回"通过模拟分析，场地内的风环境满足/不满足《标准名称》第X.X.X条的要求。"

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 重新统计失败: \<具体错误信息\> |
| 1003 | 获取结论异常: \<具体异常信息\> |
