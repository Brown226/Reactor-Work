# SetStandard

**工具说明**：依据入参设置对应节能标准。

**调用工具 Json**：
```json
{
    "command": "SetStandard",
    "parameters": {
        "公建标准": "xxxx",
		"居建标准": "xxxx"
    }
}
```

**参数说明**：

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `公建标准` | string | 标准名称 |
| `居建标准` | string | 标准名称 |

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "标准设置成功"
}
```
