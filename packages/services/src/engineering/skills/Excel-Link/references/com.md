# COM 速查

对象模型与 VBA 相同，属性和方法同名；下面的写法都在 WPS 表格中实测过。示例中 `target` 为 ExcelSession，`ws` 为 `target.wb.Worksheets("名称")`。

## 调用规则

- **按位置传参**，跳过的参数写 None。WPS 对命名参数处理不可靠：`Worksheets.Add(After=末表)` 会插到末表前面，`ws.Copy(After=末表)` 会复制到一个新工作簿并切走用户的窗口。
- **带参数的属性加 Get 或括号**。pywin32 不知道属性要不要参数，`rng.Resize(2, 3)` 会先按默认参数取属性（区域本身），再把 `(2, 3)` 当作取单元格，结果是区域中第 2 行第 3 列的单元格，不报错：

| 写法 | 说明 |
|---|---|
| `rng.GetResize(行数, 列数)` | 从 rng 左上角扩成的区域；`rng.Resize(…)` 取错 |
| `rng.GetOffset(行, 列)` | 平移后的区域；`rng.Offset(…)` 取错 |
| `rng.Address`、`rng.GetAddress(False, False)` | `"$A$1:$C$3"`；不带 $ 的 `"A1:C3"` |
| `series.DataLabels()` | 不加括号时报 `'method' object has no attribute` |
| `chart.SeriesCollection()`、`chart.SeriesCollection(1)` | 集合要加括号；带序号取其中一个 |
| `ws.ChartObjects()`、`ws.ChartObjects("名称")`、`chart.Axes(1)`、`rng.Borders(9)` | 同上 |

- **常量写数值**，常用的见文末。颜色为 BGR：`0xBBGGRR`，红色是 `0x0000FF`。

## 工作表

```python
wb = target.wb
ws = wb.Worksheets("计算")                   # 按名称；wb.Worksheets(1) 按序号，从 1 起
print([wb.Worksheets(i).Name for i in range(1, wb.Worksheets.Count + 1)])
last = wb.Worksheets(wb.Worksheets.Count)
new = wb.Worksheets.Add(None, last)         # 加在最后；参数为 (Before, After)
new.Name = "汇总"
ws.Copy(None, wb.Worksheets(wb.Worksheets.Count))   # 复制到最后，副本名为“计算 (2)”
copy = wb.Worksheets(wb.Worksheets.Count)
copy.Name = "计算-备用"
with target.quiet():                        # 删除时应用会弹框确认
    wb.Worksheets("计算-备用").Delete()
```

## 区域

```python
rng = ws.Range("A1:C6")
cell = ws.Cells(5, 3)                       # C5，行列从 1 起
block = ws.Range(ws.Cells(2, 1), ws.Cells(6, 3))    # 由两角的单元格定区域
print(rng.Rows.Count, rng.Columns.Count, cell.Row, cell.Column)
print(rng.Rows(2).Address, rng.Columns(3).Address, rng.Cells(2, 3).Address)   # 区域内第 2 行、第 3 列、(2,3) 单元格
print(rng.GetResize(3, 2).Address, rng.GetOffset(1, 0).Address)
ws.Rows("3:4").Insert()                      # 插入两行，原第 3 行起下移；整列用 ws.Columns("C:D")
ws.Rows("3:4").Delete()
ws.Range("E2:E6").ClearContents()            # 清内容，保留格式
```

## 公式与名称

```python
target.wb.Names.Add("gamma_G", "=参数!$B$2")      # 给参数单元格起名，公式中可直接写名称
ws.Range("D2:D6").Formula = "=C2*gamma_G"          # 整列同一公式，相对引用逐行调整：D3 为 =C3*gamma_G
print(ws.Range("D2:D3").Formula, ws.Range("D2").Value)   # 读公式；没有公式的单元格返回其值的文字
if target.wb.Application.Calculation == -4135:   # 计算方式为手动时，读结果前先重算
    target.wb.Application.Calculate()
```

## 格式

```python
ws.Range("C2:D6").NumberFormat = "0.00"      # 两位小数；"0" 整数、"0.0%" 百分比、"yyyy-mm-dd" 日期、"@" 文字
header = ws.Range("A1:D1")
header.Font.Bold = True
header.HorizontalAlignment = -4108           # 居中；-4131 靠左，-4152 靠右
header.Interior.Color = 0xD9D9D9             # 底色
ws.Range("A1:D6").Borders.LineStyle = 1      # 全部细框线；无框线为 -4142
header.Borders(9).Weight = -4138             # 表头下边线加粗；9 为下边线，见文末
ws.Columns("A:D").AutoFit()                  # 按内容定列宽，免得数显示成 ####
ws.Columns("A").ColumnWidth = 12             # 约 12 个半角字符宽
```

冻结表头只能通过窗口做，而且只作用于窗口中当前的工作表，所以要先切到这个工作表，这会把用户的窗口切过来。放在最后、finish 之前做：

```python
ws.Activate()
win = target.wb.Windows(1)
win.SplitRow, win.SplitColumn = 1, 0          # 冻结第 1 行；也冻结第 1 列时 SplitColumn = 1
win.FreezePanes = True
```

## 排序、筛选

```python
s = ws.Sort
s.SortFields.Clear()
s.SortFields.Add(ws.Range("C2:C6"), 0, 2)    # 按 C 列的值降序；参数为 (关键列, 0 按值, 1 升序 / 2 降序)，多列排序时依次 Add
s.SetRange(ws.Range("A1:D6"))
s.Header = 1                                  # 第一行是表头，不参与排序
s.Apply()

ws.Range("A1:D6").AutoFilter(2, "梁")         # 第 2 列等于“梁”的行留下，其余隐藏；条件可写 ">1000"
ws.AutoFilterMode = False                     # 取消筛选
```

筛选会改变用户看到的表格。只为统计时，读出数据后在 Python 中筛选（data.md）；用户要表格保持筛选状态时才用 AutoFilter。

## 下拉列表

```python
v = ws.Range("E2:E6").Validation
v.Delete()
v.Add(3, 1, 1, "C25,C30,C35,C40")            # 3 为序列，选项用英文逗号分隔；也可引用区域 "=$H$2:$H$5"
```

## 数据透视表

```python
out = target.wb.Worksheets.Add(None, target.wb.Worksheets(target.wb.Worksheets.Count))
out.Name = "统计"
cache = target.wb.PivotCaches().Create(1, ws.Range("A1:C6"))    # 1 为本工作簿中的区域
pt = cache.CreatePivotTable(out.Range("A3"), "用钢量统计")
pt.PivotFields("类型").Orientation = 1                            # 1 行、2 列、3 筛选
pt.AddDataField(pt.PivotFields("用钢量(t)"), "用钢量合计", -4157)   # -4157 求和，-4112 计数，-4106 平均，-4136 最大
print(out.Range("A3").CurrentRegion.Value)
```

源数据改了之后，透视表要 `pt.RefreshTable()` 才更新。几行的分类汇总用 SUMIFS、COUNTIFS 公式更直接，数据一改结果就跟着变。

## 常量

| 用途 | 值 |
|---|---|
| 方向 `End(…)` | 上 -4162，下 -4121，左 -4159，右 -4161 |
| 水平对齐 | 居中 -4108，靠左 -4131，靠右 -4152 |
| 边线 `Borders(…)` | 左 7，上 8，下 9，右 10，内部竖线 11，内部横线 12 |
| 线型 `LineStyle` | 实线 1，虚线 -4115，无 -4142 |
| 线宽 `Weight` | 细 2，中 -4138，粗 4 |
| 计算方式 `Calculation` | 自动 -4105，手动 -4135 |
| 汇总 `AddDataField` | 求和 -4157，计数 -4112，平均 -4106，最大 -4136，最小 -4139 |
| 文件格式 `SaveAs` | .xlsx 51，.xlsm 52，.xls 56，.csv 6 |
| 图表类型 | 见 charts.md |
