# CFDShowReport

打开(查看)已生成的室外风环境 CFD 模拟分析报告书。该工具不生成报告书，仅打开已存在的报告书文件供用户查看。

## 请求参数

无参数。

## 请求示例

```json
{
    "command":"CFDshowReport",
    "parameters":{}
}
```

## 返回结果

成功时:
```json
{
    "code": 1000,
    "msg": "报告书已打开",
    "result": {}
}

```

## 典型使用场景

1.先用`CFDCreateReport`生成报告书;
2.再用`CFDShowReport`打开报告书供用户查看。
