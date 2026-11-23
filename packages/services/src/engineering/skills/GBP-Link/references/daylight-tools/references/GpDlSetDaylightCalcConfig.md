# GpDlSetDaylightCalcConfig

设置采光计算的配置参数。

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| calcScope.type | string | 是 | 计算范围：`wholeBuild`-整栋建筑，`byStandardFloors`-按标准层，`byCommonFloors`-按普通层，`byComparts`-按户型/分隔区，`byRooms`-按房间 |
| calcScope.ids | array | 否 | 楼层/户型/分隔区/房间 ID 列表（string 类型） |
| calcMethod.formula | bool | 否 | 是否使用公式法 |
| calcMethod.simulate | bool | 否 | 是否使用模拟法 |
| statMethod.gb50033 | bool | 否 | 按国标 GB50033 统计法（formula=true 时可选） |
| statMethod.points | bool | 否 | 逐点统计法（simulate=true 时可选） |
| statMethod.gbt5699 | bool | 否 | 绿建统计法（simulate=true 时可选） |
| gridConfig.maxGridDist | number | 否 | 最大网格距离(mm) |
| gridConfig.distToWall | number | 否 | 网格距墙距离(mm) |
| gridConfig.minGridNum | int | 否 | 房间最小网格数 |
| modelConfig.considerBalconyClosed | bool | 否 | 是否考虑封闭阳台影响 |
| modelConfig.considerShade | bool | 否 | 是否考虑遮挡物影响 |
| modelConfig.considerBalconyOpen | bool | 否 | 是否考虑开敞阳台影响 |
| modelConfig.considerWinShineReduce | bool | 否 | 是否考虑窗的挡光折减 |
| modelConfig.considerWinPolluteReduce | bool | 否 | 是否考虑窗污染折减 |
| modelConfig.considerOtherBuilds | bool | 否 | 是否考虑周边建筑反射 |
| modelConfig.otherBuildsShineRef | number | 否 | 周边建筑反射比 [0,1] |
| skyConfig.skyModel | string | 否 | 天空模型：`sunny`-全晴天，`cloudy`-全阴天，`intermediate`-中间，`night`-夜间 |
| skyConfig.defType | string | 否 | 定义方式：`angle`-按角度，`timeLocation`-按时间位置 |
| skyConfig.altitude | number | 否 | 太阳高度角（defType=angle 时） |
| skyConfig.azimuth | number | 否 | 太阳方位角（defType=angle 时） |
| skyConfig.month/day/hour/minute | int | 否 | 月/日/时/分（defType=timeLocation 时） |
| skyConfig.considerGroundShineRef | bool | 否 | 是否考虑地面反射 |
| skyConfig.groundShineReflectance | number | 否 | 地面反射比 [0,1] |
| radParam.accuracy | string | 否 | 计算精度：`min`-最小最快，`fast`-快速，`accurate`-精确，`veryAccurate`-非常精确，`max`-最高精度，`default`-默认，`ecotect`-Ecotect 默认 |
| radParam.diffuseBounces | int | 否 | 地面反射次数（0=不考虑，须>0） |

**请求示例**：
```json
{
  "command": "GpDlSetDaylightCalcConfig",
  "parameters": {
    "calcScope": { "type": "wholeBuild", "ids": [] },
    "calcMethod": { "formula": true, "simulate": true },
    "statMethod": { "gb50033": true, "points": true, "gbt5699": false },
    "gridConfig": { "maxGridDist": 2000.0, "distToWall": 500.0, "minGridNum": 4 },
    "modelConfig": {
      "considerBalconyClosed": true, "considerShade": true,
      "considerBalconyOpen": false, "considerWinShineReduce": true,
      "considerWinPolluteReduce": true, "considerOtherBuilds": false,
      "otherBuildsShineRef": 0.2
    },
    "skyConfig": {
      "skyModel": "cloudy", "defType": "angle",
      "altitude": 45.0, "azimuth": 180.0,
      "month": 9, "day": 21, "hour": 9, "minute": 0,
      "considerGroundShineRef": true, "groundShineReflectance": 0.2
    },
    "radParam": { "accuracy": "accurate", "diffuseBounces": 3 }
  }
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "采光计算配置设置成功！",
  "result": {}
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
