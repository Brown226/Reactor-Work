# GetCalcStatus

获取所有工况的计算状态。返回每个工况的名称、季节、风向、风速、是否已计算、计算状态、开始/结束时间等信息。

## 请求参数

无参数。

## 请求示例

```json
{
  "command": "CFDGetCalcStatus",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "获取工况计算状态成功",
  "result": {
    "workConditions": [
      {
        "name": "夏季-西南风",
        "season": "夏季",
        "windDirection": "西南",
        "isCaled": true,
        "status": "正常结束",
        "beginTime": "2026-10-20 09:00:00",
        "endTime": "2026-10-20 10:30:00"
      },
      {
        "name": "冬季-东北风",
        "season": "冬季",
        "windDirection": "东北",
        "isCaled": false,
        "status": "未计算",
        "beginTime": "--",
        "endTime": "--"
      }
    ]
  }
}
```

## 返回字段说明

### result 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `workConditions` | array | 所有工况的计算状态列表 |

### workConditions[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 工况名称 |
| `season` | string | 所属季节（夏季/过渡季/冬季/春季/秋季） |
| `windDirection` | string | 风向（中文，如"西南"、"东北"） |
| `isCaled` | boolean | 是否已计算完成 |
| `status` | string | 计算状态（未计算、计算中、正常结束、异常结束、用户终止等） |
| `beginTime` | string | 计算开始时间，未计算时返回"--" |
| `endTime` | string | 计算结束时间，未计算时返回"--" |

## 错误情况

| 错误码 | msg 说明 |
|--------|----------|
| 1003 | 获取工况计算状态异常: \<具体异常信息\> |
