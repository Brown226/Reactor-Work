# GetResult

获取统计分析判断结论。
## 请求参数

无参数。

## 请求示例

```json
{
  "command": "SdOutGetResult",
  "parameters": {}
}
```

## 返回结果

```json
{
  "code": 1000,
  "msg": "一键计算完成",
  "result": {
    "allresult": [
      {
        "name": "区域红线内",
        "achievement": "满足标准要求"
      }
    ],
    "name": "新项目",
    "achievement": "满足标准要求",
    "isAllOk": true
  }
}
```
## 返回结果

```json
{
  "code": 1000,
  "msg": "一键计算完成",
  "result": {
    "allresult": [
      {
        "name": "区域红线内",
        "achievement": "满足标准要求"
      }
    ],
    "name": "新项目",
    "achievement": "满足标准要求",
    "isAllOk": true
  }
}
```

## 返回字段说明

### result 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `allresult` | array | 所有子项的详细达标判断数据 |、
| `name` | string | 项目名称 |
| `achievement` | string | 达标情况结论 |
| `isAllOk` | boolean | 是否全部达标 |