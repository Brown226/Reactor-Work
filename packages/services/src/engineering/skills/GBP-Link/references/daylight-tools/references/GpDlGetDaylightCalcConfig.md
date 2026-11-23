# GpDlGetDaylightCalcConfig

查询当前的采光计算配置。

**请求示例**：
```json
{
  "command": "GpDlGetDaylightCalcConfig",
  "parameters": {}
}
```

**返回结果**：
```json
{
  "code": 1000,
  "msg": "查询采光计算配置成功！",
  "result": {
    "calcScope": {
      "type": "wholeBuild",
      "ids": []
    },
    "calcMethod": { "formula": true, "simulate": true },
    "statMethod": { "gb50033": true, "points": true, "gbt5699": false },
    "gridConfig": { "maxGridDist": 2000, "distToWall": 500, "minGridNum": 4 },
    "modelConfig": {
      "considerBalconyClosed": true,
      "considerShade": true,
      "considerBalconyOpen": false,
      "considerWinShineReduce": true,
      "considerWinPolluteReduce": true,
      "considerOtherBuilds": false,
      "otherBuildsShineRef": 0.2
    },
    "skyConfig": {
      "skyModel": "cloudy",
      "defType": "angle",
      "altitude": 45, "azimuth": 180,
      "month": 9, "day": 21, "hour": 9, "minute": 0,
      "considerGroundShineRef": true,
      "groundShineReflectance": 0.2
    },
    "radParam": {
      "accuracy": "accurate",
      "diffuseBounces": 3
    }
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| code | int | 状态码（1000 成功） |
| msg | string | 提示信息 |
| result.calcScope.type | string | 计算范围：`wholeBuild`-整栋建筑，`byStandardFloors`-按标准层，`byCommonFloors`-按普通层，`byComparts`-按户型/分隔区，`byRooms`-按房间 |
| result.calcScope.ids | array | 楼层/户型/分隔区/房间 ID 列表 |
| result.calcMethod.formula | bool | 是否使用公式法 |
| result.calcMethod.simulate | bool | 是否使用模拟法 |
| result.statMethod.gb50033 | bool | 按国标GB50033统计法 |
| result.statMethod.points | bool | 逐点统计法 |
| result.statMethod.gbt5699 | bool | 绿建统计法 |
| result.gridConfig.maxGridDist | int | 最大网格距离(mm) |
| result.gridConfig.distToWall | int | 网格距墙距离(mm) |
| result.gridConfig.minGridNum | int | 房间最小网格数 |
| result.modelConfig.considerBalconyClosed | bool | 是否考虑封闭阳台影响 |
| result.modelConfig.considerShade | bool | 是否考虑遮挡物影响 |
| result.modelConfig.considerBalconyOpen | bool | 是否考虑开敞阳台影响 |
| result.modelConfig.considerWinShineReduce | bool | 是否考虑窗的挡光折减 |
| result.modelConfig.considerWinPolluteReduce | bool | 是否考虑窗污染折减 |
| result.modelConfig.considerOtherBuilds | bool | 是否考虑周边建筑反射 |
| result.modelConfig.otherBuildsShineRef | number | 周边建筑反射比 |
| result.skyConfig.skyModel | string | 天空模型：`sunny`-全晴天，`cloudy`-全阴天，`intermediate`-中间，`night`-夜间 |
| result.skyConfig.defType | string | 定义方式：`angle`-按角度，`timeLocation`-按时间位置 |
| result.skyConfig.altitude | number | 太阳高度角（angle 时） |
| result.skyConfig.azimuth | number | 太阳方位角（angle 时） |
| result.skyConfig.month/day/hour/minute | int | 月/日/时/分（timeLocation 时） |
| result.skyConfig.considerGroundShineRef | bool | 是否考虑地面反射 |
| result.skyConfig.groundShineReflectance | number | 地面反射比 |
| result.radParam.accuracy | string | 计算精度：`min`-最小最快，`fast`-快速，`accurate`-精确，`veryAccurate`-非常精确，`max`-最高精度，`default`-默认，`ecotect`-Ecotect 默认 |
| result.radParam.diffuseBounces | int | 地面反射次数 |
