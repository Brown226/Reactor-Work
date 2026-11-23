# GetShadeDetailedInfo

**工具说明**：获取遮阳设置需要的参数。

**调用工具 Json**：
```json
{
    "command": "GetShadeDetailedInfo",
    "parameters": {
	"type":"水平遮阳"
	}
}
```

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "遮阳信息已返回",
  "param": [
    {
      "name": "水平挡板深度",
      "type": "double",
      "required": true,
      "unit": "mm",
      "min": 0
    },
    {
      "name": "与窗垂直距离",
      "type": "double",
      "required": true,
      "unit": "mm",
      "min": 0
    },
    {
      "name": "水平挡板角度",
      "type": "double",
      "required": true,
      "unit": "°",
      "min": 0,
      "max": 90
    },
    {
      "name": "材质",
      "type": "string",
      "required": false,
      "enum": ["织物面料", "玻璃、有机玻璃（深色：0<Se≤0.6）"] 
    },
    {
      "name": "布置位置",
      "type": "string",
      "required": true,
      "enum": ["全楼", "当前层"]
    },
    {
      "name": "朝向",
      "type": "string",
      "required": true,
      "enum": ["东", "南", "西", "北", "全朝向"]
    }
  ]
}
```
