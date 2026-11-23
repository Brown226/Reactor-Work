# 图表

系列直接引用单元格区域，改数据时图表跟着变。示例中 `ws` 为数据所在的工作表：

- 第 1–7 行：A 列位移(mm)，B、C 列两组荷载(kN)，第 1 行为表头。
- 第 10–16 行：A 列楼层（数 1–6），B、C 列 X 向、Y 向层间位移角，第 10 行为表头；G11:G12 两格都是位移角限值 1/800，H11:H12 为 0 和 6.5，供画竖向限值线。
- 第 20–25 行：A 列柱编号，B 列轴压比，C 列轴压比限值（每行都是 0.85），第 20 行为表头。

图表放在 J 列以右，免得盖住数据。

## 选类型

| 数据 | 类型 | ChartType |
|---|---|---|
| 楼层指标：层间位移角、位移比、楼层剪力、刚度比等 | 散点图，楼层放纵轴，X、Y 两个方向画在一张图里 | 74 |
| X 为数值的曲线：荷载-位移、反应谱、时程 | 散点图，带直线和标记 | 74；不要标记 75；只画点 -4169 |
| 按类别比较：各构件、各方案 | 簇状柱形图 | 51；横向条形 57；堆积柱形 52 |
| X 为等间距的类别：月份、施工阶段 | 折线图 | 4；带标记 65 |
| 占比 | 饼图 | 5 |

X 为数值时不要用折线图。折线图把 X 当作文字类别等距排开：X 为 0、1、2、4、8、16 时，8 到 16 与 0 到 1 画得一样宽，直线会画成弯曲线，曲线形状全错。平滑曲线（72、73）在数据点之间会冲出虚假的峰值，实测数据用直线连接。

## 建图

```python
at = ws.Range("J2")                            # 图表左上角对齐的单元格
chart = ws.Shapes.AddChart(74, at.Left, at.Top, 480, 300).Chart   # 类型, 左, 上, 宽, 高（磅）
while chart.SeriesCollection().Count:          # Excel 可能按表上选中的区域自动加系列，先清掉
    chart.SeriesCollection(1).Delete()
for col in ("B", "C"):
    s = chart.SeriesCollection().NewSeries()
    s.Name = f"='{ws.Name}'!${col}$1"          # 名称引用表头，也可直接写文字；不给时图例显示“系列1”
    s.XValues = ws.Range("A2:A7")
    s.Values = ws.Range(f"{col}2:{col}7")
chart.Parent.Name = "荷载位移曲线"             # 之后用 ws.ChartObjects("荷载位移曲线").Chart 取回
```

- 用 `AddChart`，不用 `AddChart2`：后者在 Excel 2010 和旧版 WPS 中没有。
- 每条系列都用 `NewSeries` 给出 X、Y 区域和名称，不用 `SetSourceData`：后者要猜数据按行还是按列排、哪行是表头，猜错时系列和坐标就乱了。
- 新系列的类型跟随整张图：在柱状图中加的系列也是柱。要画成线（限值线、趋势线），就把这条系列的 `ChartType` 改掉。
- 数据在别的工作表时，区域照样写 `wb.Worksheets("数据").Range(…)`。

## 样式

应用默认的图没有标题和单位，图例挤在右侧，线粗、标记大。下面的 tidy 统一成适合工程报告的样式：

- 去掉外框，只留一个方向的浅色网格。
- 线宽 1.75 磅，标记小而空心。
- 图例放到底部，全图用一种字体。

建好系列、设好坐标轴范围后调用一次：

```python
def rgb(r, g, b):
    return r + (g << 8) + (b << 16)                # COM 的颜色值：红在低位

COLORS = [rgb(31, 78, 121), rgb(197, 90, 17), rgb(84, 130, 53), rgb(112, 48, 160)]   # 深蓝、橙、绿、紫，依次给各系列
INK, GRID, RED = rgb(64, 64, 64), rgb(217, 217, 217), rgb(192, 0, 0)


def tidy(chart, title, x_title, y_title):
    chart.ChartArea.Format.Line.Visible = 0        # 去掉外框
    chart.HasTitle = True
    chart.ChartTitle.Text = title
    for axis, text in ((chart.Axes(1), x_title), (chart.Axes(2), y_title)):
        axis.HasTitle = True
        axis.AxisTitle.Text = text
        axis.AxisTitle.Font.Bold = False
        axis.Format.Line.ForeColor.RGB = INK
        axis.MajorTickMark = 3                     # 刻度线在轴外侧；内侧 2，无 -4142
    chart.Axes(1).HasMajorGridlines = False
    chart.Axes(2).HasMajorGridlines = True
    chart.Axes(2).MajorGridlines.Format.Line.ForeColor.RGB = GRID
    n = chart.SeriesCollection().Count
    for i in range(1, n + 1):
        s, color = chart.SeriesCollection(i), COLORS[(i - 1) % len(COLORS)]
        if s.ChartType in (51, 52, 57, 58):        # 柱、条
            s.Format.Fill.ForeColor.RGB = color
        else:
            s.Format.Line.ForeColor.RGB = color
            s.Format.Line.Weight = 1.75
            if s.MarkerStyle != -4142:
                s.MarkerSize = 5
                s.MarkerForegroundColor = color
                s.MarkerBackgroundColor = rgb(255, 255, 255)
    chart.HasLegend = n > 1                        # 只有一条系列时标题已说明，不要图例
    if n > 1:
        chart.Legend.Position = -4107              # 底部；右侧 -4152，顶部 -4160
    chart.ChartArea.Font.Name = "微软雅黑"         # 字体最后设：在它之后才建的标题不会跟着变
    chart.ChartArea.Font.Size = 9
    chart.ChartArea.Font.Color = INK
    chart.ChartTitle.Font.Size = 11


x = chart.Axes(1)
x.MinimumScale, x.MaximumScale, x.MajorUnit = 0, 16, 2   # 坐标范围和刻度间隔，不设时自动
tidy(chart, "荷载-位移曲线", "位移(mm)", "荷载(kN)")
```

- 对数坐标：`chart.Axes(2).ScaleType = -4133`，改回线性为 -4132；数据中有 0 或负数时不能用。
- 数据标签只加在要强调的点上（最大值、超限处），全加会挤成一片：`s.Points(3).HasDataLabel = True`，`s.Points(3).DataLabel.NumberFormat = "0.00"`；整条系列都加用 `s.HasDataLabels = True`，`s.DataLabels().NumberFormat = "0.0"`（DataLabels 要加括号）。
- 柱的间距：`chart.ChartGroups(1).GapWidth = 80`，为柱宽的 80%。

以下写法在 WPS 中不能用或会出错：

- `chart.ChartStyle = …`、`chart.ClearToMatchStyle()`：会清掉已设的颜色和标记，标题也变成几种颜色。
- `chart.HasLegend = False` 时访问 `chart.Legend` 报“发生意外”：先设 `HasLegend = True`。
- 绘图区的位置和大小（`PlotArea.Left`、`Top`、`Width`、`Height` 及 `Inside…`）设了也不生效，由应用自动排布。留白多时，去掉不需要的标题和图例，或把图例放到底部。

## 限值线

限值写在单元格里，限值线的系列引用这些单元格，改限值时图跟着变；限值线在 tidy 之后设成红色虚线。

楼层指标图中画竖线：两个点 X 相同、Y 从轴底到轴顶。下例为层间位移角，X、Y 两个方向画在一起，楼层放在纵轴；位移比、楼层剪力等换数据列和限值照此画：

```python
at = ws.Range("J24")
chart = ws.Shapes.AddChart(74, at.Left, at.Top, 400, 420).Chart   # 楼层图竖长一些
while chart.SeriesCollection().Count:
    chart.SeriesCollection(1).Delete()
for col, name in (("B", "X向"), ("C", "Y向")):
    s = chart.SeriesCollection().NewSeries()
    s.Name, s.XValues, s.Values = name, ws.Range(f"{col}11:{col}16"), ws.Range("A11:A16")   # X 为指标，Y 为楼层
limit = chart.SeriesCollection().NewSeries()
limit.Name = "限值 1/800"
limit.XValues = ws.Range("G11:G12")            # 两格都是 1/800
limit.Values = ws.Range("H11:H12")             # 0 和 6.5，与楼层轴的范围相同，竖线贯穿全高
limit.ChartType = 75                           # 这条不要标记
x, y = chart.Axes(1), chart.Axes(2)
y.MinimumScale, y.MaximumScale, y.MajorUnit = 0, 6.5, 1   # 顶层加 0.5；楼层多时刻度间隔取 5 或 10
x.MinimumScale = 0
tidy(chart, "层间位移角", "层间位移角", "楼层")
y.TickLabels.NumberFormat = '0"F";;""'         # 刻度显示为 1F、2F…，0 不显示
x.TickLabels.NumberFormat = "0.0000"
y.HasMajorGridlines = False                    # 这张图横向比较位移角，改用竖向网格
x.HasMajorGridlines = True
x.MajorGridlines.Format.Line.ForeColor.RGB = GRID
limit.Format.Line.ForeColor.RGB = RED
limit.Format.Line.DashStyle = 4                # 虚线
limit.Format.Line.Weight = 1.25
```

柱状图中画横线：每个类别都给限值，这条系列改成折线：

```python
at = ws.Range("J52")
chart = ws.Shapes.AddChart(51, at.Left, at.Top, 480, 300).Chart
while chart.SeriesCollection().Count:
    chart.SeriesCollection(1).Delete()
bars = chart.SeriesCollection().NewSeries()
bars.Name, bars.XValues, bars.Values = "轴压比", ws.Range("A21:A25"), ws.Range("B21:B25")
limit = chart.SeriesCollection().NewSeries()
limit.Name, limit.XValues, limit.Values = "限值 0.85", ws.Range("A21:A25"), ws.Range("C21:C25")
limit.ChartType = 4                            # 不改就是一排柱，会盖住数据
chart.Axes(2).MinimumScale = 0
tidy(chart, "框架柱轴压比", "柱", "轴压比")
chart.ChartGroups(1).GapWidth = 80
limit.Format.Line.ForeColor.RGB = RED
limit.Format.Line.DashStyle = 4
limit.Format.Line.Weight = 1.25
bars.Points(3).HasDataLabel = True             # 只标超限的 KZ3
bars.Points(3).DataLabel.NumberFormat = "0.00"
```

## 其他

- 两组量纲不同的数画在一张图上时，把其中一条系列放到右侧的次坐标轴：`s.AxisGroup = 2`，次 Y 轴为 `chart.Axes(2, 2)`；它的标题在 tidy 之后才建，要自己设 `AxisTitle.Font.Bold = False`。
- 饼图的系列要给 XValues（各块的名称），否则各块没有标签；显示百分比用 `s.DataLabels().ShowPercentage = True`。

## 导出查看

```python
import os, tempfile

png = os.path.join(tempfile.mkdtemp(), "荷载位移曲线.png")
chart = ws.ChartObjects("荷载位移曲线").Chart
chart.Export(png)                              # WPS 中导出成功也返回 False，以文件是否生成为准
print(os.path.exists(png))
print([chart.SeriesCollection(i).Formula for i in range(1, chart.SeriesCollection().Count + 1)])
```

- 用 view_image 查看 png。检查：
  - 曲线形状与数据相符；
  - 坐标轴有标题和单位，刻度与数据点对齐；
  - 图例名称不是“系列1”；
  - 限值线是线而不是柱。
- 系列的 Formula 为 `=SERIES(名称, X 区域, Y 区域, 序号)`，用来核对引用的区域。
- 图片放在临时目录，不要放进用户的文件夹。导出的 png 中文字边缘有彩色像素，是系统的字体平滑，不是颜色设错了。
