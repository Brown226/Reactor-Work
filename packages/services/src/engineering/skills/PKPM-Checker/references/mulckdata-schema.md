# MulCkdata SQLite 精简解析参考

## 核心目标

仅服务设计师快速查看：项目图纸、图纸基本信息、审查意见、构件数量、指定构件图纸识别/配筋和构件级意见。默认不输出原始字段。

## 表关系

| 目标 | 主表 | 关联/说明 |
| --- | --- | --- |
| 项目与图纸 | `DwgInfo` | `ProjectName`、`CutName`、`DrwKind`、`CutID` |
| 图纸信息 | `DrawInfo` / `WpjInfo` | 通过 `DrwCutID/WpjCutID` 与 `CutID` 对应；按 `Kind` 解读图名、类型、外框 |
| 图纸级审查意见 | `SElesTable` | 通过 `DrwCutID` 对应图纸；`eleName` 对应构件名 |
| 梁构件 | `CheckDataBeamTable` | `nNoDrwDataBeam -> DrwDataBeamTable.iNo`；`nNoBaseCheckData -> CheckBaseDataTable.iNo` |
| 柱构件 | `CheckDataColTable` | `nNoDrwDataCol -> DrwDataColTable.iNo`；`nNoBaseCheckData -> CheckBaseDataTable.iNo` |
| 构件级意见 | `CheckBaseDataTable` | 一个构件可有多条意见；详情字段用 `;+;` 分隔 |

## 图纸信息

### DwgInfo

常用字段：

- `ProjectName`：项目名
- `CutName`：切分图纸名
- `DrwKind`：0 施工图，1 配筋简图
- `CutID`：图纸 ID

### DrawInfo / WpjInfo

按 `Kind` 解析 `Content`：

| Kind | DrawInfo 含义 | WpjInfo 含义 |
| ---: | --- | --- |
| 0 | 图纸类型代码 | 配筋简图类型代码 |
| 3 | CAD 外框四角点 | CAD 外框四角点 |
| 4 | 图纸名称 | 来源 DWG 名 |
| 5 | 楼层关键字 | 图纸名称 |
| 6 | 图纸类型关键字 |  |

图纸文本只展示：图纸名称、类型、校审意见数量。

图纸 CAD 使用 `Kind=3` 的外框点绘制矩形，并在左上角写单行文字。

## 图纸级审查意见：SElesTable

常用字段：

- `DrwCutID`：图纸 ID
- `iNo`：意见序号
- `OV_type`：规范条文 ID
- `iOG`：规范/意见类型位值
- `OV_str_Detail` / `OV_str` / `cContent` / `cPropertyloss`：意见内容，按优先级取第一个非空值；默认按 SQLite 原文输出，不改写、不概括、不截断
- `eleName`：构件名
- `MarkPoint` / `leftPoint` / `rightPoint`：CAD 定位点

排序规则：

1. 默认 `--sort spec`：强条、应、宜、其他；同一规范 ID 相邻。
2. `--sort component`：同一构件放在一起。
3. `--sort raw`：按原始序号。

级别筛选：

| 参数 | 含义 |
| --- | --- |
| `--level strong` | 强条 |
| `--level ying` | 应 |
| `--level yi` | 宜 |
| `--level other` | 其他 |

## 构件统计与构件信息

默认只统计总数：

- 梁数量：`CheckDataBeamTable` 中当前 `DrwCutID` 行数
- 柱数量：`CheckDataColTable` 中当前 `DrwCutID` 行数

指定构件时再展示：构件名、截面尺寸、PMID、配筋字符串、构件级意见数量、首条构件级意见原文。

## 梁图纸识别/配筋

链路：`CheckDataBeamTable -> DrwDataBeamTable -> CheckBaseDataTable`。

`DrwDataBeamTable` 常用字段：

- `scMergeName`：构件名
- `scSectSize`：截面尺寸
- `siPmids`：PMID 集合
- `sBeamintData`：梁整型属性；其中 `m_bN=1` 表示受扭腰筋，输出前缀 `N`，否则输出 `G`
- `sMainBar`：梁纵筋数组

梁 `sMainBar` 按 `[5][7][2]` 解读：5 排、7 个位置、每排每位置最多 2 种规格。

7 个原始位置：

1. 上部通长筋
2. 左支座
3. 右支座
4. 架立筋
5. 下部入支座筋
6. 不入支座筋
7. 腰筋

展示时输出 6 类：上通、左支座、右支座、架立、底筋、腰筋。

- 底筋 = 下部入支座筋 + 不入支座筋合并。
- 腰筋根据 `m_bN` 自动加 `G` 或 `N`。

## 柱图纸识别/配筋

链路：`CheckDataColTable -> DrwDataColTable -> CheckBaseDataTable`。

`DrwDataColTable` 常用字段：

- `scMergeName`：构件名
- `scSectSize`：截面尺寸
- `siPmids`：PMID 集合
- `sDrwintData.m_iSectType`：截面类型，优先用于判断柱类型
- `sColintData.m_bCicle`、`siSect`、`sPlx/sPly`、`sikindType/sisectType/sistruc`：截面判断辅助信息
- `sMainBar`：柱纵筋数组

柱 `sMainBar` 按 `[5][3][2]` 解读：5 排、3 个位置、每排每位置最多 2 种规格。

柱截面输出：

| 截面 | 输出 |
| --- | --- |
| 矩形柱 | 角筋、B边、H边 |
| 圆形柱 | 全截面 |
| 异形柱 | 按截面/非空肢输出第 1～3 肢 |

截面类型常用值：1 矩形，3 圆形，4 L形，5 T形，6 Z形，7 十字形。

## 钢筋字符串

钢筋等级字母：

| 等级 | 字母 |
| ---: | --- |
| 1 | F |
| 2 | B |
| 3 | C |
| 4 | C |
| 5 | A |
| 6 | D |
| 7 | E |
| 8 | G |
| 9 | H |
| 10 | I |

格式示例：`2D22` 表示 2 根 D 级、直径 22 的钢筋。

## 构件级意见：CheckBaseDataTable

常用字段：

- `DrwCutID`：图纸 ID
- `iNo`：被 `CheckData*Table.nNoBaseCheckData` 引用
- `iCheckComPonent`：构件类别，0 梁、1 柱、2 墙身、3 边缘构件、4 墙梁、5 板、6 板支座
- `scSele_Details`：意见详情，多条用 `;+;` 分隔；分隔后的每条意见默认保留原文内容，不做摘要或截断
- `scSele_Titles`、`siCodeIdSs`、`sbDeletes`、`sbShows`、`siOG`、`siTitle_Colors`：与详情按顺序对应

## 输出约束

- 默认不展示原始字段、结构体展开和中间表。
- JSON 也保持精简，只保留可直接回答用户的字段；其中意见文本保留 SQLite 原文。
- CAD 绘制只使用外框点、意见定位点和意见文本；意见文本默认保留 SQLite 原文，用户要求简化时才压缩。
