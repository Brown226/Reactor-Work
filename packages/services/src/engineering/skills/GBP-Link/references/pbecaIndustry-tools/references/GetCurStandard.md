# GetCurStandard

**工具说明**：获取当前选择标准。

**调用工具 Json**：
```json
{
    "command": "GetCurStandard",
}
```

**参数说明**：

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "获取当前选择标准成功"
  "result": {
	"bdlsPH": 2,//0是公建，1是居建，2是商住，3是工业
	"StandardName": [
		{"当前公建选择标准": "xxx"},
		{"当前居建选择标准": "xxx"}
	]
  }
}
```
