---
name: excel-link
description: 读取、统计、修改和新建 Excel/WPS 表格（.xlsx、.xlsm、.xls、.csv）。用户要整理或汇总工程数据、做计算表、按公式计算、统计分析、画曲线图或柱状图，或在已有表格中填数、改公式时，都使用本技能，即使用户没有提到 Excel。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# Excel / WPS 表格操作

代码在 python_executor 中执行，通过 COM 在用户的 WPS 表格 / Excel 中直接改表：公式由应用计算，用户能看着表格变化。表格在这里是存取数据、统计计算、出图的工具，要的是数据和公式正确，不追求版式。

## 任务路由

| 任务 | 流程 | 先读 |
|---|---|---|
| 在已有表格中填数、改公式、增删行列和工作表 | 编辑 | com.md |
| 按数据新建计算表、汇总表 | 新建 | com.md |
| 统计、筛选、分组汇总、比对、清洗数据 | 分析 | data.md |
| 曲线图、柱状图等图表，图表样式，限值线 | 编辑或新建 | charts.md |
| 汇总多个表格文件 | 批量 | data.md 的“多个文件” |
| 查看、提取内容 | 只读 | 不用读参考 |

参考文件用 `use_skill(skill="excel-link", file="references/文件名")` 读取，写代码前读完相关的几篇。

## 核心概念

### 只动目标工作簿

用户常在 WPS/Excel 中开着别的表格干活，Agent 改表时用户还在用。`ActiveWorkbook`、`ActiveSheet`、`Selection` 都随用户的操作而变：用户一切到别的工作簿，按活动对象写的代码就写进了用户正在用的文件。所以开始时用 ExcelSession 按路径锁定目标工作簿，之后一律从 `target.wb` 取工作表和区域。

- `target = ExcelSession(path, *, save_as=None)`：`path` 为绝对路径。在所有 WPS/Excel 中按路径找这个文件，开着就用它（用户未保存的修改也在其中），否则在用户的 WPS/Excel 中打开。
  - 开始时把工作簿当前的内容（含未保存的修改）另存到 `target.backup`：COM 的修改会清空应用的撤销记录，用户撤销不了，要退回只能用备份。
  - `save_as`：另存的绝对路径，后缀定格式（.xlsx、.xlsm、.xls、.csv）。给出时改另存的文件，原文件不动，用户开着的原文件保持打开；该路径已有文件时报错。
- `ExcelSession.new(path, *, template=None, overwrite=False)`：在用户的 WPS/Excel 中新建工作簿，立即保存到 `path`，之后同样按路径锁定。`template` 为模板文件路径，新工作簿复制它的内容。`path` 已存在时报错，免得覆盖用户的文件；从头重做本任务新建的文件时给 `overwrite=True`（开着时先关闭，不保存）。
- `ExcelSession.bind(wb, *, save_as=None)`：接管在应用中取得的工作簿对象，用于用户新建、从未保存过的工作簿，此时须给 `save_as`。`get_office_app("Excel")` 连接用户正在用的 WPS/Excel（失败时返回错误文字而不是报错），从它的 `Workbooks` 中核对名称和内容找到 `wb`。
- `target.wb`：工作簿对象，与 VBA 的 Workbook 相同；`target.path`：文件路径；`target.backup`：备份路径，新建和另存时为 None。
- `with target.quiet():`：with 中不弹提示，按默认选项执行。删除工作表、合并有内容的单元格、保存为 .xls 或 .csv 时应用会弹框确认，弹框会卡住调用，直到用户去点掉；这个设置对整个应用生效，所以只在 with 中关掉。
- `target.finish(*, show=True)`：任务结束时调用。把应用设置（提示、屏幕刷新、计算方式等）恢复成开始时的样子，保存工作簿，`show=True` 时切到这个工作簿给用户看。`show=False` 时本会话打开的工作簿随即关闭（用户原来开着的保持打开），用于批量处理和只读任务。

各次调用之间变量保留，`target` 一直指向同一个文件。执行环境重置、变量丢失后，重新 `ExcelSession(路径)` 即可找回，不会重复打开。

WPS 不能同时打开两个同名的文件（即使在不同文件夹）：会弹框卡住，或把已开的那个直接关掉。ExcelSession 打开和另存前都会检查，同名时报错，请用户关闭那个文件，或换一个文件名。

### 与用户同时使用

| 做法 | 原因 |
|---|---|
| 读写直接对区域对象做，不用 `Select`、`Activate`、`ActiveWindow`、`SendKeys` | 这些会切走用户的窗口和选区。冻结窗格只能通过窗口做，放在最后、finish 之前 |
| 复制单元格用赋值，两边区域大小相同：`目标.FormulaR1C1 = 源.FormulaR1C1` 像粘贴一样按相对位置平移引用，`目标.Formula = 源.Formula` 原样照搬，`目标.Value = 源.Value` 只要值；格式另设 | `Range.Copy` 即使给了目标，也会清掉用户剪贴板里的内容 |
| 改了应用级设置（`DisplayAlerts`、`ScreenUpdating`、`Calculation`、`EnableEvents`）要在同一段代码中改回，用 try/finally | 这些设置对用户的所有工作簿生效。finish 会恢复，但任务中途用户已受影响，如计算方式改成手动后，用户自己的表格也不再重算 |
| 调用报 `AttributeError: <unknown>.属性名` 或 `RPC_E_CALL_REJECTED` 时，请用户结束编辑、关掉对话框，再执行这一步 | 用户正在编辑单元格或应用弹着对话框时，应用拒绝外来调用。ExcelSession 会让调用自动等最多 30 秒，用户按下回车或关掉对话框后接着完成；等不到才报错 |
| 调用报“发生意外”且此前正常时，查 `target.wb` 是否还开着；用户关掉了就重新 `ExcelSession(路径)`，核对内容后继续 | 用户关闭了目标工作簿后，对象就失效了 |

### 公式优先

表格的用处在于改了输入数据，结果跟着变。所以能用公式表达的计算都写公式，不在 Python 里算好再写数值。

- 参数（荷载分项系数、材料强度等）单独放在带标签的单元格中，公式引用它：写 `=B5*$C$2`，不写 `=B5*1.3`。改参数时只改一处，别人也看得出数从哪来。
- 先写两三个公式并读回结果，核对确实取对了行列，再铺满整列：引用错一行不会报错，只会算出错数。
- 分母可能为 0 时加判断：`=IF(C5=0,"",B5/C5)`。
- 优先用 SUMIFS、INDEX/MATCH、IFERROR 等老函数。文件会在不同版本的 WPS/Excel 之间传，XLOOKUP、FILTER、UNIQUE、LET 等新函数在旧版本中显示 #NAME?。
- Python 只算公式做不到或很繁琐的（迭代求解、调用外部程序），写入结果时在表头或批注中注明“由程序计算，数据变了要重算”。

### 整块读写

每次读写都要跨进程，几毫秒一次：逐格循环写几千格要几十秒，用户还会看着表格一格格跳。所以一次读写整个区域。下列函数处理整块读写中容易出错的地方。`from PKPMAgent.software_link_kit.excel import *` 只导入这几个函数和 ExcelSession、get_office_app。

**`data_range(ws)`** → 有内容的区域（Range），空表为 None

- 从 A1 到最后一个有值或公式的单元格所在的行和列，区域第 i 行第 j 列即表中第 i 行第 j 列。
- 不用 `UsedRange`：它把只设过格式的空单元格也算进来，可能多出上万行。也不用 `End(xlUp)`：它按一列找，该列末尾有空格时会漏行。

**`values(rng)`** → 二维列表（行的列表）

- 单个单元格也是 `[[值]]`。空单元格为 None，数值都是 float，日期为 datetime，错误值为 `"#DIV/0!"` 等文字。
- 区域由几块组成（如 `"A1:B2,D1:D3"`）时只取第一块。

**`write(cell, rows)`** → 写入的区域（Range）

- 从 `cell` 的左上角起写入。`rows` 为行的列表，行长不齐时补空；给一维列表时写成一行，写一列用 `[[v] for v in 数据]`。
- 值可为数值、文字、bool、None（清空）、date、datetime，以及 numpy、pandas 的数值（NaN 写成空）；以 = 开头的文字写成公式。
- 直接给 `Range.Value` 赋值时，以下情况都不报错：
  - 区域比数据大，多出的格填 #N/A；比数据小，多出的数据被截掉。
  - datetime 会差 8 小时：pywin32 把它当本地时间换算成 UTC。
  - date 则直接报错。
  write 处理了这些。

**`check_formulas(wb)`** → `[("表名!C5", "#DIV/0!", "=A5/B5"), …]`

- 各工作表中结果为错误值的公式，没有时为空列表。

```python
from PKPMAgent.software_link_kit.excel import *

target = ExcelSession(r"C:\work\梁内力.xlsx")
ws = target.wb.Worksheets("内力")
rows = values(data_range(ws))
print(rows[0], len(rows) - 1)                  # 表头和数据行数
write(ws.Range("E1"), ["弯矩设计值(kN·m)"])
ws.Range(f"E2:E{len(rows)}").Formula = "=1.3*C2+1.5*D2"   # 整列同一公式，相对引用逐行调整
print(values(ws.Range("C2:E4")))               # 读回几行核对
print(check_formulas(target.wb))
```

## 流程

第一段代码先导入：`from PKPMAgent.software_link_kit.excel import *`。

### 编辑已有表格

1. **锁定**：`target = ExcelSession(路径)`；要保留原件时加 `save_as=新路径`。
2. **读懂**：逐个工作表 `values(data_range(ws))`，看清表头、单位、数据起止行，哪些列是公式（读 `rng.Formula`），输入格有什么标记（底色、字色）。据此列出要改的位置和写法。
3. **修改**：沿用表格原有的约定（单位、数字格式、公式写法），在输入格写数，不动已有公式，除非用户要求。
4. **检查**：`check_formulas(target.wb)` 为空；改动处读回核对；有图表时导出图片查看（charts.md）。
5. **交付**：`target.finish()`，按交付清单汇报。

### 新建表格

1. **规划**：各工作表的分工（原始数据、参数、计算、汇总、图表），每张表有哪些列、单位是什么。
2. **建文件**：`target = ExcelSession.new(路径)`；第一张表为 `target.wb.Worksheets(1)`，改名后使用。
3. **写内容**：
   - 表头一行，单位写在表头里，如 `跨度(m)`。
   - 数据用 write 整块写入，计算列写公式。
   - 设列宽和数字格式（com.md），数字格式按工程精度，如 `"0.00"`。
4. **检查、交付**：同上。

### 分析数据

- **读数据：**
  - 表格在应用中开着，或要读用户未保存的修改：`target = ExcelSession(路径)`，用 `values(data_range(ws))` 读出，不改表时最后 `target.finish(show=False)`。
  - 没开着的文件：直接读磁盘文件，不必打开应用（data.md）。
- **写结果：** 要写回表格时按“编辑”流程。统计结果尽量用公式（SUMIFS、COUNTIFS、AVERAGEIFS）或数据透视表放在表中，这样改数据时结果会跟着变。

### 批量处理多个文件

- 只读汇总：读磁盘文件（data.md），不在用户的应用中一个个打开。
- 逐个修改：`for p in 路径: t = ExcelSession(p); …; t.finish(show=False)`，每个文件在用户的应用中打开，改完关闭。

## 通用规则

| 事项 | 规则 |
|---|---|
| 文字与数值 | 应用会把像数值的文字转成数值、像日期的转成日期（“001”变成 1，轴号“1-2”变成 1 月 2 日）。编号、轴号等要原样保留的列，写入前先设 `rng.NumberFormat = "@"`。反过来，数存成文字时 SUM 会漏算、排序会乱，所以从文本、网页得来的数先转成 float 再写 |
| 单位 | 写在表头（`荷载(kN)`），单元格中只放数，同一列单位一致 |
| 百分比 | 存小数（0.15），用数字格式 `"0.0%"` 显示 |
| 合并单元格 | 值在左上角的单元格，其余为空。读多行表头时按左上角取值，再向右补齐 |
| 跨表引用 | 表名含空格、括号、横线或以数字开头时加单引号：`='1号楼 荷载'!B2` |
| 调用参数 | 按位置传参，跳过的写 None：`wb.Worksheets.Add(None, 末表)`。WPS 对命名参数处理不可靠，`Add(After=末表)` 会插到末表前面 |
| 带参数的属性 | `rng.Resize(2, 3)`、`rng.Offset(1, 0)` 在 pywin32 中不报错但取错，要写 `rng.GetResize(2, 3)`、`rng.GetOffset(1, 0)`；另有几个要加括号调用，见 com.md |
| 常量 | 写数值，如 xlUp 为 -4162，常用的见 com.md |
| 格式 | .xls 可直接改，要转新格式用 save_as。.csv 只存得下第一张表的值，要加公式、图表或多张表时 save_as 为 .xlsx |
| 保存 | finish 时保存；中途要让别的程序读磁盘上的文件时，先 `target.wb.Save()` |

## 校验与交付

- `check_formulas(target.wb)` 为空，或逐项说明了原因（如引用的数据待用户补）。
- 改动处和几个关键结果读回核对过；关键数值另用 Python 按原始数据算一遍对照。
- 图表按 charts.md 的 tidy 统一了样式，导出看过：每条系列的数据和名称对，坐标轴有标题和单位，限值线是线而不是柱。
- 新建文件按内容命名（不用“新建表格”“output”这类名称），没有空表头和占位文字。
- 已 `target.finish()`。交付时告知备份位置 `target.backup`：用户撤销不了本次的修改，要恢复只能用它。
