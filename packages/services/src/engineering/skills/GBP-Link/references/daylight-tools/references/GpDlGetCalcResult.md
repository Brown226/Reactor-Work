# GpDlGetCalcResult

**工具说明**：查询当前建筑采光计算结果，含采光系数、年度动态采光、窗地面积比等。

**特别说明**：resultType为detail时，若statMethod为gb50033，结果包含每间房间的数据，数据量可能会很大。由于 python_executor 环境是持久化的，可以在同一个脚本中直接处理数据，在单个脚本内完成"调用 → 解析 → 统计 → 只打印统计摘要"的全流程，避免打印整个 JSON。**如果本工具返回的字符串本身在MCP层已经被截断，则改用summary结果类型，不要再尝试detail类型了。**

**调用参数**：

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `resultType` | 否 | `summary` | `summary`-仅返回建筑级统计结果；`detail`-含楼层明细 |
| `statMethod` | 否 | 按用户界面勾选的统计方法输出 | 指定统计方法：<br>`gb50033` / `national`-国标公式法统计（统计每间房间的公式法采光系数）；<br>`gbt5699` / `lvjian`-绿建统计法，《采光测量方法》GB/T 5699 中推荐的统计方法（详见 GBT5699-2017-7.2.md）；<br>`points`-逐点统计法，按每个网格点是否达标进行统计。<br>**不传时默认按用户在界面上勾选的统计方法输出**；如果用户界面也未勾选任何统计方法，默认输出国标统计法（gb50033） |

**工具执行完返回 Json**：
```json
{
  "code": 1000,
  "msg": "查询计算结果成功。",
  "result": {
    "public": {
      "name": "办公楼A",
      "type": "公建",
      "cav": {
        "gb50033": {
          "building": {
            "formula_conclusion": {
              "is_ok": false,
              "text": "采光计算结果不满足《建筑环境通用规范》GB 55016-2021的要求"
            }
          },
          "floors": [
            {
              "idFloor": "101",
              "name": "1层",
              "areas": [
                {
                  "name": "办公区",
                  "rooms": [
                    {
                      "name": "办公室1",
                      "room_type": "办公室",
                      "formula": {
                        "dl_type": 1,
                        "cav_side": 2.5,
                        "cav_limit_side": 2.0,
                        "cav_top": 0,
                        "cav_limit_top": 0,
                        "is_ok": true,
                        "is_force": false
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        "gbt5699": {
          "building": {
            "illuminance": {
              "totalArea": 5000.0,
              "areaOk": 4200.0,
              "areaOkRatio": 84.0,
              "meshCount": 5000,
              "cavMean": 2.5,
              "specialCavMean": 2.2,
              "conclusion": { "is_ok": true, "score": 10, "text": "达标" }
            },
            "illuminanceInner": {
              "totalArea": 2000.0,
              "areaOk": 1200.0,
              "areaOkRatio": 60.0,
              "meshCount": 2000,
              "cavMean": 1.2,
              "specialCavMean": 1.0,
              "conclusion": { "is_ok": true, "score": 8, "text": "达标" }
            },
            "annual": {
              "totalArea": 5000.0,
              "aveLumHours": 2850.5,
              "aveLumHoursTotal": 24954375.0,
              "areaOk": [4200.0, 3800.0, 3200.0],
              "areaOkRatio": [84.0, 76.0, 64.0],
              "areaOkASE1000Gt250": 3800.0,
              "areaOkASE1000Gt250Ratio": 76.0,
              "conclusion": { "is_ok": true, "score": 12, "text": "达标" }
            }
          },
          "floors": [
            {
              "idFloor": "101",
              "name": "1层",
              "illuminance": {
                "totalArea": 1000.0,
                "areaOk": 900.0,
                "areaOkRatio": 90.0,
                "meshCount": 1000,
                "cavMean": 3.0,
                "specialCavMean": 2.8
              },
              "annual": {
                "totalArea": 1000.0,
                "aveLumHours": 3100.0,
                "aveLumHoursTotal": 3100000.0,
                "areaOk": [900.0, 850.0, 750.0],
                "areaOkRatio": [90.0, 85.0, 75.0],
                "areaOkASE1000Gt250": 850.0,
                "areaOkASE1000Gt250Ratio": 85.0
              }
            }
          ]
        },
        "points": { "building": { "illuminance": {}, "annual": {} } }
      }
    }
  }
}
```

**字段说明**：

| 路径 | 字段名 | 类型 | 说明 |
|------|--------|------|------|
| `result` | `{type}` | object | 建筑类型根节点，键为 `public`（公建）/ `residential`（居建）/ `industrial`（工业），根据项目实际类型返回 |
| `result.{type}` | `name` | string | 建筑名称 |
| `result.{type}` | `type` | string | 建筑类型显示名称（如：公建、居建） |
| `result.{type}` | `cav` | object | 采光系数统计区域 |
| `cav` | `gbt5699` | object | 绿建统计法结果，结构同 `points` |
| `cav` | `points` | object | 逐点统计法结果，结构同 `gbt5699` |
| `cav` | `gb50033` | object | 国标公式法统计结果 |
| `cav.{method}` | `building` | object | 建筑级别统计汇总数据（始终返回）；包含 `illuminance`（全区域采光数据）、`illuminanceInner`（内区采光数据）、`annual`（全年动态采光数据） |
| `cav.{method}` | `floors` | array | 楼层级别详细数据（`resultType=detail` 时返回），每项结构与 `building` 同级字段一致，但**不含 `conclusion`** |
| `illuminance` / `illuminanceInner` | `totalArea` | number | 总计算面积（㎡） |
| | `areaOk` | number | 达标面积（㎡） |
| | `areaOkRatio` | number | 达标面积比例（%） |
| | `meshCount` | int | 计算网格数量 |
| | `cavMean` | number | 平均采光系数（%） |
| | `specialCavMean` | number | 房间向内偏移1.1米后的平均采光系数（%），对应 GB55015-2021 中普通教室采光均匀度计算要求 |
| `annual` | `aveLumHours` | number | 每天平均达标小时数（按网格面积加权） |
| | `aveLumHoursTotal` | number | 全年达标小时总和（按网格面积加权） |
| | `areaOk` | array | 各阈值达标面积数组，具体阈值因采用标准而异 |
| | `areaOkRatio` | array | 各阈值达标比例数组（%），阈值因标准而异 |
| | `areaOkASE1000Gt250` | number | ASE1000（照度>1000lx）时数多于250h/a的区域面积（㎡） |
| | `areaOkASE1000Gt250Ratio` | number | ASE1000 达标面积比例（%） |
| | `conclusion` | object | 结论信息（**仅 `building` 层级包含**） |
| `conclusion` | `is_ok` | boolean | 是否达标 |
| | `score` | number | 得分 |
| | `text` | string | 结论文本描述 |

**gb50033 国标公式法特有字段说明**：

| 路径 | 字段名 | 类型 | 说明 |
|------|--------|------|------|
| `cav.gb50033.building` | `formula_conclusion` | object | 国标统计法整体结论 |
| `formula_conclusion` | `is_ok` | boolean | 国标统计法是否全部达标（所有标记了"强制达标"的房间均满足公式法要求） |
| `formula_conclusion` | `text` | string | 国标统计法结论文本 |
| `cav.gb50033.floors[]` | `areas` | array | 区域列表（gb50033 detail模式下直接嵌套 areas→rooms→formula） |
| `areas[].rooms[]` | `name` | string | 房间名称 |
| `areas[].rooms[]` | `room_type` | string | 房间功能类型 |
| `areas[].rooms[]` | `formula` | object | 公式法采光系数结果 |
| `formula` | `dl_type` | int | 采光类型：0=无采光，1=侧面采光，2=顶部采光，3=侧面+顶部采光，4=间接采光（对于房间有采光，但是不存在窗的情况，比如天井） |
| | `cav_side` | number | 侧面采光系数平均值（公式法，%） |
| | `cav_limit_side` | number | 侧面采光系数限值（%） |
| | `cav_top` | number | 顶部采光系数平均值（公式法，%） |
| | `cav_limit_top` | number | 顶部采光系数限值（%） |
| | `is_ok` | boolean | 该房间公式法是否达标 |
| | `is_force` | boolean | 是否强制达标。用户勾选了"强制达标"的房间，如果公式法不满足，则整体公式法结论 is_ok 为 false |
