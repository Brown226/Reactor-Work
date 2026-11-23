# 表格与图表

## 表格

python-pptx 的 `table.cell(r, c)`、`table.rows[r]` 行列从 0 开始；view 中的表格网格和 `f.at("页N/K(r,c)")` 从 1 开始。合并区的文字在左上角格，被覆盖的格 `cell.is_spanned` 为 True。

### 辅助函数

**`insert_table(slide, data, left, top, width, *, widths=None, merges=(), row_height=None, font_size=12)`** → 表格形状，其 `.table` 为 python-pptx 的 Table

- `data`：按行排列的文字，行列数即表格大小；数字自动转为文字，None 为空。
- `widths`：各列宽度的比例，如 `[1, 3, 2]`，省略时等宽，合计为 `width`。
- `merges`：合并区 `(上, 左, 下, 右)` 的列表，行列从 1 开始、含两端；文字写在左上角，被覆盖处写 `""` 或 None。
- `row_height`：最小行高，省略时约为两倍字高；文字放不下时应用自动加高该行。
- 新表无样式、无底纹、无框线，文字 `font_size` 磅、竖向居中。python-pptx 的 `add_table` 会套用主题色的表格样式（深色表头、隔行底纹），不要用。

**`set_borders(table, width=0.5, *, outer=None, inner=None, top=None, bottom=None, left=None, right=None, inside_h=None, inside_v=None, color="000000")`** → None

- 统一设置全表的线，覆盖各格原有的线。
- 每条线给宽度（磅，0 为无线）或 `(宽度, 颜色)`；省略的线取 `outer`（四周边线）或 `inner`（内部横竖线），再省略取 `width` 和 `color`。

**`set_row_border(table, after_row, *, cols=None, width=0.5, color="000000")`** → None：在第 `after_row` 行之后画横线，0 为表顶、总行数为表底；`cols` 限定画线的列（整数、range 或列表，从 1 开始），省略为整行；`width=0` 去掉此处的线。

**`set_col_border(table, after_col, *, rows=None, width=0.5, color="000000")`** → None：在第 `after_col` 列之后画竖线，0 为左边线、总列数为右边线；`rows` 限定画线的行。

**`set_three_line(table, header_rows=1, *, footer_rows=0, color="000000", outer=1.5, inner=0.5)`** → None：清除原有的全部表格线，画顶线、底线（`outer` 磅）和表头下的栏目线（`inner` 磅），多层表头中跨列栏目下画短线，无竖线；`footer_rows` 为末尾的表内注释行，底线画在它们上方。

以上函数的 `table` 可为 Table 或表格形状。合并区内部不画线，合并格的每条边整条有线或无线：分组表的组内细线整行画即可，合并的类别列自动跳过，见示例。底纹用 `set_fill`，字体用 `set_font`，都可传单元格、表格行 `t.rows[r]`、整表或它们的列表。`t.rows`、`t.columns` 不能切片，取表头以下各行写 `list(t.rows)[1:]`，其首列为 `[r.cells[0] for r in list(t.rows)[1:]]`。

### python-pptx 直接写

```python
from copy import deepcopy
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Cm, Pt
```

| 任务 | 写法 |
|---|---|
| 行高、列宽 | `t.rows[r].height = Pt(30)`（最小行高）；`t.columns[c].width = Cm(4)` |
| 对齐 | `cell.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT`；竖向 `cell.vertical_anchor = MSO_ANCHOR.MIDDLE` |
| 内边距 | `cell.margin_left = Pt(6)`，`margin_right`、`margin_top`、`margin_bottom` 同理 |
| 改文字 | `set_text(cell, "…")`，保留格式 |
| 合并、拆分 | `t.cell(0, 0).merge(t.cell(1, 0))`，各格文字并到左上角；`cell.split()` 拆开 |
| 追加行 | `t._tbl.append(deepcopy(t._tbl.tr_lst[-1]))`：新行照抄末行的格式和文字，再逐格 `set_text` |
| 删除行 | `t._tbl.remove(t._tbl.tr_lst[r])` |
| 删除列 | `t._tbl.tblGrid.remove(t._tbl.tblGrid.gridCol_lst[c])`，再对每行 `tr.remove(tr.tc_lst[c])`（`for tr in t._tbl.tr_lst`）；表格随之变窄，重设列宽 |

- 增删行列前，先拆开跨过该处的合并区；增删后框线要重设（如再调用一次 `set_three_line`）。
- 表格形状的 `height` 是新建时的值，行被文字撑高或增删行后不更新；表格下方的元素是否被压住，用 `check_slides` 核对。
- 页面上的表格只放读者要比较的数据：行多时只留关键行，完整数据放附录页；字号不小于 12 磅；数字右对齐、同列小数位数一致，单位写在表头；结论所在的行或列用强调色或浅底纹标出。

### 示例

方案比选表：三线表，数字右对齐，推荐方案整行标出。

```python
from pptx.enum.text import PP_ALIGN
from pptx.util import Pt

INK, BODY, ACCENT = "1A1A1A", "595959", "C0392B"
rows = [["方案", "结构体系", "单方造价（元/㎡）", "工期（月）", "用钢量（kg/㎡）"],
        ["A", "钢筋混凝土框架—剪力墙", 3150, 26, 58],
        ["B", "钢框架—支撑", 2980, 27, 72],
        ["C", "装配式混凝土", 3320, 22, 55]]
shape = insert_table(s, rows, M, H * 0.25, W - 2 * M, widths=[1, 3, 2, 1.5, 2], row_height=Pt(34), font_size=14)
t = shape.table
set_three_line(t, 1, color=INK)
for row in t.rows:
    for c, cell in enumerate(row.cells):
        cell.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT if c >= 2 else PP_ALIGN.LEFT
set_font(t.rows[0], bold=True, color=INK)
set_font(t.rows[2], bold=True, color=ACCENT)
set_fill(t.rows[2], "FBEDEB")
add_text(s, M, shape.top + shape.height + Pt(10), W * 0.8, Pt(16), "注：造价为方案阶段估算，不含地下室。", size=11, color=BODY)
```

分组表：首列按类别合并，组内浅色细线，表头下和组与组之间深色线，类别列浅底纹。

```python
rows = [["类别", "能力", "状态"],
        ["建模", "读取 PKPM 模型", "已上线"], [None, "生成计算书", "已上线"], [None, "超限判定", "试点"],
        ["审图", "规范条文检索", "已上线"], [None, "图纸比对", "开发中"]]
groups = [(2, 4), (5, 6)]                                   # 各组的首行、末行
shape = insert_table(s, rows, M, H * 0.25, W * 0.6, widths=[1, 3, 1.5], row_height=Pt(30), font_size=14,
                     merges=[(a, 1, b, 1) for a, b in groups])
t = shape.table
set_borders(t, 0)
for after_row in range(2, len(rows)):                       # 组内细线，合并的首列自动跳过
    set_row_border(t, after_row, width=0.5, color="D9D9D9")
for after_row in [0, 1] + [b for _, b in groups]:           # 表顶、表头下、每组之后
    set_row_border(t, after_row, width=1, color=INK)
set_fill([t.cell(a - 1, 0) for a, _ in groups], "F2F2F2")
set_font(t.rows[0], bold=True, color=INK)
```

## 图表

用 python-pptx 的原生图表：数据存在图表内嵌的 Excel 中，用户能在 PowerPoint/WPS 里直接改数据和样式。能用原生图表表达的，不要画成图片。

### 新建与改数据

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

data = CategoryChartData()
data.categories = ["2022", "2023", "2024"]
data.add_series("竣工面积（万㎡）", (150, 180, 210))
data.add_series("同比增长", (0.25, 0.20, 0.17), number_format="0%")
chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, left, top, width, height, data).chart
```

| 用途 | 图表类型 `XL_CHART_TYPE.…` |
|---|---|
| 比较大小 | `COLUMN_CLUSTERED` 柱形；`BAR_CLUSTERED` 条形，类别名长或类别多时用 |
| 构成 | `COLUMN_STACKED`、`COLUMN_STACKED_100` 堆积柱形；`DOUGHNUT` 环形、`PIE` 饼图，只用于 2–5 项 |
| 趋势 | `LINE`、`LINE_MARKERS`（带数据点）；`AREA` 面积 |
| 两个变量的关系 | `XY_SCATTER`，数据用 `XyChartData`：`sr = data.add_series("名称")`，`sr.add_data_point(x, y)` |
| 多项评价 | `RADAR` |

- 条形图的类别从下往上排，要第一项在最上面时把类别和数值都倒序给出。
- 改已有图表的数据：按新数据建好 `data`，`chart.replace_data(data)`，类别、系列和内嵌的 Excel 一起换掉，格式保留。原数据在 view 中，或读 `chart.plots[0].categories`、`series.values`。

**`set_series_type(chart, series, chart_type, *, secondary=False)`** → 新图形（python-pptx 的 plot）

- 把图表中的部分系列改为另一种图形，做柱线组合图；python-pptx 新建的图表只有一种图形。
- `series`：系列序号（从 0 开始，同 `chart.series` 的顺序）或序号列表，至少留一个系列不改。
- `chart_type`：柱形、条形、折线或面积类的 `XL_CHART_TYPE`，如 `XL_CHART_TYPE.LINE_MARKERS`。
- `secondary=True`：这些系列用右侧的次数值轴，数量级不同（如面积与增长率）时用；次数值轴为 `ValueAxis(chart._chartSpace.valAx_lst[-1])`（`from pptx.chart.axis import ValueAxis`）。
- 系列的名称、数据、颜色不变；改后 `chart.series` 中移过去的系列排在后面，view 中的系列后注明图形和所用的数值轴。

### 格式

```python
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_LABEL_POSITION, XL_LEGEND_POSITION, XL_MARKER_STYLE, XL_TICK_LABEL_POSITION, XL_TICK_MARK
from pptx.enum.dml import MSO_LINE_DASH_STYLE
```

| 任务 | 写法 |
|---|---|
| 字体 | `set_font(chart, size=12, color=…, latin=…, east_asia=…)`；新建的图表字号为 18 磅，都要设 |
| 标题 | 标题写成页面上的文字，图表的标题关掉：`chart.has_title = False` |
| 图例 | `chart.has_legend = True`，`chart.legend.position = XL_LEGEND_POSITION.TOP`，`chart.legend.include_in_layout = False`；单系列或已直接标注时 `chart.has_legend = False` |
| 系列颜色 | 柱、面积、扇区 `series.format.fill.solid()`，`series.format.fill.fore_color.rgb = RGBColor.from_string("C0392B")`；折线 `series.format.line.color.rgb`、`series.format.line.width = Pt(2)` |
| 单个柱或扇区的颜色 | `series.points[i].format.fill`，写法同上 |
| 柱宽、间距 | `plot.gap_width = 80`（类别之间的空隙为柱宽的 80%）；簇状柱形中同一类别的几根柱之间留缝 `plot.overlap = -20` |
| 数据标签 | `plot.has_data_labels = True`，`labels = plot.data_labels`，`labels.show_value = True`（饼图、环形图不写这句不显示数值），`labels.number_format = "0.0"`，`labels.number_format_is_linked = False`，`labels.position = XL_LABEL_POSITION.OUTSIDE_END`（堆积柱形只能用 `CENTER`、`INSIDE_END`、`INSIDE_BASE`） |
| 只标一个点、自定标签文字 | `label = series.points[i].data_label`，`label.text_frame.text = "12.0"`，`label.position = …`，字体 `set_font(label.text_frame, …)` |
| 数值轴 | `axis = chart.value_axis`；范围 `axis.minimum_scale`、`axis.maximum_scale`，刻度间隔 `axis.major_unit`；刻度格式 `axis.tick_labels.number_format = "0%"`，`axis.tick_labels.number_format_is_linked = False` |
| 网格线 | `axis.has_major_gridlines = False`；颜色 `axis.major_gridlines.format.line.color.rgb` |
| 隐去数值轴 | `axis.tick_label_position = XL_TICK_LABEL_POSITION.NONE`，`axis.major_tick_mark = XL_TICK_MARK.NONE`，`axis.format.line.fill.background()`；WPS 不认 `axis.visible = False` |
| 类别轴 | 去刻度线 `chart.category_axis.major_tick_mark = XL_TICK_MARK.NONE`；轴线颜色 `chart.category_axis.format.line.color.rgb` |
| 折线的数据点 | `series.marker.style = XL_MARKER_STYLE.CIRCLE`，`series.marker.size = 7`，颜色 `series.marker.format.fill`、`series.marker.format.line` |
| 预测段画虚线 | 实际值、预测值分成两个系列，衔接的那一期两个系列都给值，其余为 None；预测系列 `series.format.line.dash_style = MSO_LINE_DASH_STYLE.DASH`。不要只给几个数据点设虚线，WPS 会把这些点逐个列进图例 |
| 环形图 | 内径 `get_or_add(chart.plots[0]._element, "c:holeSize", val=70)`（占外径的 %）；环中的数字另用 `add_text` 放在环的中心，此时关掉图例，否则环偏向一侧 |

- 图表区默认透明，透出页面背景，不要另加底色；深色背景上把字体、轴线和网格线改成浅色。
- 数据要能说明标题中的结论：要强调的系列或那一期用强调色，其余用灰色或同色系的浅色；直接标出关键数值，不要只靠图例和坐标轴让读者自己读数。单位、数据来源写在图下方的小字中。

### 原生图表做不出的图

python-pptx 的原生图表没有瀑布图、甘特图、热力图、漏斗图、桑基图、树状图等：

| 图 | 做法 |
|---|---|
| 瀑布图 | 堆积柱形，最下面的底座系列无填充，见示例 3 |
| 热力图、评价矩阵 | 表格，按数值用 `set_fill` 设单元格底纹 |
| 甘特图、时间轴、进度 | `add_shape` 画条，`add_line` 画“今日”线，`add_text` 标注 |
| 漏斗图 | 各层用居中、逐层变窄的矩形或梯形（`add_shape(s, "trapezoid", …)`） |
| 同坐标的多个小图 | 并排几个小图表，数值轴设相同的 `minimum_scale`、`maximum_scale` |
| 其他（桑基图、树状图、复杂的统计图） | matplotlib 画成 PNG（dpi 不低于 200，透明底，中文字体设为本机字体，如 `plt.rcParams["font.family"] = "Microsoft YaHei"`），`add_picture(…, fit="contain")` 插入；图中的数据用户改不了，交付时说明 |

### 示例

以下示例中 `s` 为幻灯片，`W, H = f.prs.slide_width, f.prs.slide_height`，`M` 为页边距，颜色常量同表格示例，另有 `GRAY = "BFBFBF"`。

1 突出一期的柱形图：主体用灰色，要说的那一期用强调色，直接标数值、隐去数值轴。

```python
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_TICK_LABEL_POSITION, XL_TICK_MARK
from pptx.util import Pt

add_text(s, M, H * 0.08, W * 0.8, Pt(36), "开馆第三年日均客流预计达到 1.2 万人次", size=24, color=INK, bold=True)
data = CategoryChartData()
data.categories = ["第一年", "第二年", "第三年", "第四年", "第五年"]
data.add_series("日均客流（千人次）", (6.5, 9.0, 12.0, 12.8, 13.1))
chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, M, H * 0.22, W * 0.6, H * 0.62, data).chart
chart.has_title = chart.has_legend = False
set_font(chart, size=12, color=BODY)
plot = chart.plots[0]
plot.gap_width = 80
for i, point in enumerate(plot.series[0].points):
    point.format.fill.solid()
    point.format.fill.fore_color.rgb = RGBColor.from_string(ACCENT if i == 2 else GRAY)
plot.has_data_labels = True
labels = plot.data_labels
labels.show_value = True
labels.number_format, labels.number_format_is_linked = "0.0", False
labels.position = XL_LABEL_POSITION.OUTSIDE_END
axis = chart.value_axis
axis.tick_label_position = XL_TICK_LABEL_POSITION.NONE
axis.major_tick_mark = XL_TICK_MARK.NONE
axis.format.line.fill.background()
axis.has_major_gridlines = False
chart.category_axis.major_tick_mark = XL_TICK_MARK.NONE
chart.category_axis.format.line.color.rgb = RGBColor.from_string(GRAY)
add_text(s, W * 0.68, H * 0.3, W * 0.28, H * 0.4,
         "第三年起客流趋稳，年增长降到 5% 以下。\n按此规模，二期展厅宜在第三年前建成。", size=14, color=BODY)
add_text(s, M, H * 0.88, W * 0.6, Pt(16), "单位：千人次/日；来源：项目可研报告（2026）", size=10, color=BODY)
```

2 柱线组合：面积用柱形，增长率用折线和右侧的次数值轴。

```python
from pptx.chart.axis import ValueAxis
from pptx.enum.chart import XL_LEGEND_POSITION

data = CategoryChartData()
data.categories = ["2021", "2022", "2023", "2024", "2025"]
data.add_series("竣工面积（万㎡）", (120, 150, 180, 210, 236))
data.add_series("同比增长", (0.10, 0.25, 0.20, 0.17, 0.12), number_format="0%")
chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, M, H * 0.15, W - 2 * M, H * 0.7, data).chart
line = set_series_type(chart, 1, XL_CHART_TYPE.LINE_MARKERS, secondary=True)
right = ValueAxis(chart._chartSpace.valAx_lst[-1])
right.tick_labels.number_format, right.tick_labels.number_format_is_linked = "0%", False
right.maximum_scale = 0.4
chart.has_title, chart.has_legend = False, True
chart.legend.position, chart.legend.include_in_layout = XL_LEGEND_POSITION.TOP, False
bars = chart.plots[0].series[0]
bars.format.fill.solid()
bars.format.fill.fore_color.rgb = RGBColor.from_string(GRAY)
growth = line.series[0]
growth.format.line.color.rgb = RGBColor.from_string(ACCENT)
growth.format.line.width = Pt(2.25)
growth.marker.format.fill.solid()
growth.marker.format.fill.fore_color.rgb = RGBColor.from_string(ACCENT)
growth.marker.format.line.color.rgb = RGBColor.from_string(ACCENT)
set_font(chart, size=12, color=BODY)
```

3 瀑布图：造价从 2024 年到 2025 年的变化。底座系列垫到每步变化后的低点，增、减各为一个系列。

```python
steps = [("2024 年造价", 3150), ("结构优化", -120), ("幕墙调整", -80), ("机电升级", 60)]
level = steps[0][1]
base, up, down, texts = [0], [level], [0], [f"{level:,}"]
for _, value in steps[1:]:
    base.append(level + min(value, 0))
    up.append(max(value, 0))
    down.append(-min(value, 0))
    texts.append(f"{value:+,}")
    level += value
base.append(0), up.append(level), down.append(0), texts.append(f"{level:,}")   # 末柱为合计，从 0 画起

data = CategoryChartData()
data.categories = [name for name, _ in steps] + ["2025 年造价"]
for name, values in (("底座", base), ("增加", up), ("减少", down)):
    data.add_series(name, values)
chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_STACKED, M, H * 0.15, W - 2 * M, H * 0.7, data).chart
chart.has_title = chart.has_legend = False
plot = chart.plots[0]
plot.gap_width = 60
hidden, rise, fall = plot.series
hidden.format.fill.background()                          # 底座不显示
for series, color in ((rise, "A6A6A6"), (fall, ACCENT)):
    series.format.fill.solid()
    series.format.fill.fore_color.rgb = RGBColor.from_string(color)
for i in (0, len(texts) - 1):                            # 起止两柱用深色
    rise.points[i].format.fill.solid()
    rise.points[i].format.fill.fore_color.rgb = RGBColor.from_string(INK)
for i, text in enumerate(texts):                         # 每根柱只标一个数
    label = (rise if up[i] else fall).points[i].data_label
    label.text_frame.text = text
    label.position = XL_LABEL_POSITION.INSIDE_END
    set_font(label.text_frame, size=12, color="FFFFFF")
chart.value_axis.minimum_scale = 2800
set_font(chart, size=12, color=BODY)
```
