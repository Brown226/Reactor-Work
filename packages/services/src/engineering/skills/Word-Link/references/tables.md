# 表格

表格按网格坐标定位，行列从 1 开始，与 view 中的表格网格一致；合并格占多个坐标，以左上角为准。python-docx 的 `table.cell()`、`row.cells` 从 0 开始，且合并格会重复出现，所以改用下面的函数取单元格。

## 辅助函数

### 取单元格

**`table_cells(table, rows=None, cols=None, *, expand=False)`** → `{(行, 列): 单元格}`

- 取与 `rows` 行、`cols` 列相交的单元格，按阅读顺序；`rows`、`cols` 为整数、range 或列表，省略为全部。
- 每个单元格只出现一次，键为它的左上角坐标，合并格的左上角可能在所选行列之外；`expand=True` 时，范围内被合并覆盖的每个坐标都映射到所属的单元格。
- 例：`table_cells(t, rows=1)` 为首行；`table_cells(t, rows=range(2, 10), cols=3)` 为第 3 列的第 2–9 行；任意坐标所在的单元格用 `table_cells(t, expand=True)[3, 1]` 或 `f.at("表2(3,1)")`。

**`table_grid(table)`** → `[{"row", "col", "rowspan", "colspan", "tc"}]`：各实际单元格的位置、跨度和 XML 元素，按阅读顺序。

### 新建

**`insert_table(anchor, data, *, merges=(), widths=None, diagonals=None, font_size=10.5, before=False)`** → Table

- `anchor`：段落或表格，新表插在其后，`before=True` 时插在其前；为 `f` 时追加到文末。与相邻表格之间自动留一个空段，免得两表连成一张。
- `data`：按行排列的文字，行列数即网格大小；数字自动转为文字。
- `merges`：合并区 `(上, 左, 下, 右)` 的列表，含两端；文字写在左上角，被覆盖处写 `""` 或 None。
- `diagonals`：斜线表头 `{(行, 列): (右上文字, 左下文字)}`，该格 data 留空。
- `widths`：各列宽（磅），省略时按文字估算并撑满版心。
- 新表为 0.5 磅全框线、文字居中、单倍行距、`font_size` 磅字，其余格式用下面的函数再改。

### 改结构

先改结构再填文字；结构改变后坐标随之变化，要重新取单元格。

- `insert_rows(table, after_row, count=1)` → 新行的行号 range：在第 `after_row` 行之后插入空行，0 为插在表首。新行照抄相邻行的行高、框线、底纹和字体，跨过插入位置的纵向合并随之延长。
- `delete_rows(table, first, last=None)` → None：删除第 `first` 至 `last` 行，含两端，省略 `last` 时只删一行。起于被删行、延续到下方的纵向合并保留下方部分，文字移过去。
- `insert_columns(table, after_col, count=1, *, width=None)` → 新列的列号 range：0 为插在最左。新格照抄相邻格的框线、底纹和字体，列宽取相邻列宽或 `width`（磅）；跨过插入位置的合并格一并扩展。表格随之变宽，再用 `fit_columns` 重排。
- `delete_columns(table, first, last=None)` → None：跨过这些列的合并格收窄。表格随之变窄，再用 `fit_columns` 重排。
- `merge_cells(table, top, left, bottom, right)` → 合并后的单元格：区域含两端，各格内容按阅读顺序并到左上角；区域不能切开已有的合并格。
- `split_cell(table, row, col)` → 拆出的全部单元格：拆开 `(row, col)` 所在的合并格，内容留在左上角格。

### 框线与底纹

**`set_borders(table, width=0.5, *, outer=None, inner=None, top=None, bottom=None, left=None, right=None, inside_h=None, inside_v=None, color="000000")`** → None

- 统一设置全表的线，清除单元格上单独设的线，斜线保留。
- 每条线给宽度（磅，0 为无线）或 `(宽度, 颜色)`；省略的线取 `outer`（四周边线）或 `inner`（内部横竖线），再省略取 `width` 和 `color`。

**`set_row_border(table, after_row, *, cols=None, width=0.5, color="000000")`** → None：在第 `after_row` 行之后画横线，0 为表顶、总行数为表底；`cols` 限定画线的列（整数、range 或列表），省略为整行；`width=0` 去掉此处的线。

**`set_col_border(table, after_col, *, rows=None, width=0.5, color="000000")`** → None：在第 `after_col` 列之后画竖线，0 为左边线、总列数为右边线；`rows` 限定画线的行；跨过此处的合并格不画。

**`set_three_line(table, header_rows, *, footer_rows=0, color="000000", outer=1.5, inner=0.5)`** → None：清除原有的全部表格线，画顶线、底线（`outer` 磅）和表头下的栏目线（`inner` 磅），多层表头中跨列栏目下画短线，无竖线；`footer_rows` 为末尾的表内注释行，底线画在它们上方。文字和尺寸不变。

**`set_fill(cells, color)`** → None：底纹，`color` 为 `"RRGGBB"`，None 为清除；`cells` 为单元格、表格，或它们的列表、字典（如 `table_cells` 的结果）；纵向合并格连同被覆盖的各格一起设置。

### 列宽与跨页

**`fit_columns(table, *, width=None, fill=True, padding=None, font_size=10.5)`** → 各列宽（磅）

- 按文字估算列宽后固定列宽，Word 与 WPS 显示一致；合并结构和文字不变。
- `width`：表格总宽（磅），省略时取版心宽度，嵌套表取所在单元格的宽度。`fill=True` 时内容少也撑满 `width`，`fill=False` 时按内容宽度、不超过 `width`。
- `padding`：单元格左右内边距（磅，每侧），省略时沿用；`font_size`：未设字号的文字按多大估算。
- 格内手动换行会限制列宽，先去掉；最长的词或数值也放不下时报错，不改表格。

- `set_column_widths(table, widths)` → None：按网格列设置列宽（磅的列表）并固定；合并格的宽度为所跨列之和。
- `set_header_rows(table, header_rows)` → None：前 `header_rows` 行跨页重复，并与首个数据行排在同一页；其他行取消重复。
- `keep_together(table, through_row=None)` → None：各行不跨页拆开，并让第 1 至 `through_row` 行各与下一行同页。省略时整表排在同一页，只用于不超过一页的表，更长的表会被整体推到下一页；0 时只保证各行不拆开。

## python-docx 直接写

```python
from docx.shared import Pt
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE
```

| 任务 | 写法 |
|---|---|
| 整表居中 | `t.alignment = WD_TABLE_ALIGNMENT.CENTER` |
| 格内上下居中 | `cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER`；左右对齐设在格内段落上 |
| 行高 | `t.rows[i].height = Pt(20)`，`t.rows[i].height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST` |
| 字体 | `set_font(t, size=9)`，也可传 `table_cells` 的结果 |
| 删除整表 | `t._tbl.getparent().remove(t._tbl)` |

## 示例

带合并表头的新表：

```python
t = insert_table(f.at("正文8"), [
    ["楼层", "构件", "配筋", "", "备注"],
    ["", "", "纵筋", "箍筋", ""],
    ["1", "KZ1", "12Φ25", "Φ10@100", ""],
], merges=[(1, 1, 2, 1), (1, 2, 2, 2), (1, 3, 1, 4), (1, 5, 2, 5)])
add_caption(t, "表", "框架柱配筋")
set_header_rows(t, 2)
```

框线和底纹：先用 `set_borders` 定全表，再用 `set_row_border`、`set_col_border` 加单独的线。

| 效果 | 写法 |
|---|---|
| 全部细线；无线 | `set_borders(t)`；`set_borders(t, 0)` |
| 外框 1.5 磅深蓝、内线 0.5 磅浅蓝 | `set_borders(t, outer=(1.5, "1F3864"), inner=(0.5, "9DC3E6"))` |
| 去掉竖线 | `set_borders(t, left=0, right=0, inside_v=0)` |
| 表头下加粗线 | `set_row_border(t, 1, width=1.5)` |
| 表头底纹 | `set_fill(table_cells(t, rows=1), "D9E2F3")` |

隔行底纹：按单元格左上角所在的行取色，每格只设一次。逐行调用 `set_fill(table_cells(t, rows=r), …)` 时，跨两行的合并格会被两行各设一次，后一行的颜色会覆盖前一行的。

```python
h = 2                                                     # 表头行数
for (r, c), cell in table_cells(t, rows=range(h + 1, len(t.rows) + 1)).items():
    set_fill(cell, "F2F2F2" if (r - h) % 2 == 0 else None)
```

把已有表格改为学术三线表（GB/T 7713 与 APA 均用三线表）。要求与写法：

| 要求 | 写法 |
|---|---|
| 顶线、底线粗，表头下的栏目线细，无竖线、无底纹 | `set_three_line(t, 表头行数)`，清除底纹 |
| 表注在底线下方，左对齐 | 表内注释行计入 `footer_rows`，注释段落左对齐 |
| 合计等汇总行与数据分开 | 其上加细线 `set_row_border(t, 汇总行 - 1)` |
| 表序和表题在表上方居中，按出现顺序编号 | `add_caption(t, "表", 表题)` |
| 表内字体同正文，字号可小一号 | `set_font(t, size=9)` |
| 表格居中，列宽随内容 | `t.alignment`；`fit_columns(t, fill=False)` |
| 表头跨页重复，行不拆开；短表不拆到两页 | `set_header_rows`；`keep_together(t)`，超过一页的表用 `keep_together(t, 0)` |

3 行表头、末行为表内注释的表格：

```python
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH

t = f.at("表3")
set_three_line(t, 3, footer_rows=1)
set_fill(t, None)
for el in t._tbl.xpath(".//w:pPr/w:shd | .//w:rPr/w:shd | .//w:rPr/w:highlight"):
    el.getparent().remove(el)                  # 段落和文字上的底纹、高亮
set_font(t, size=9)
for cell in table_cells(t, rows=len(t.rows)).values():
    for p in cell.paragraphs:
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
fit_columns(t, fill=False)
t.alignment = WD_TABLE_ALIGNMENT.CENTER
set_header_rows(t, 3)
keep_together(t)
add_caption(t, "表", "框架柱配筋")
```

## 注意

直接改表格 XML 时：

- 横向合并用 `w:tcPr/w:gridSpan`；纵向合并首格写 `<w:vMerge w:val="restart"/>`，下方各格写 `<w:vMerge/>`，这些格仍须保留一个空段落。
- 单元格最后一个子元素必须是段落，格内嵌套表之后也要有段落。
- 列宽在 `w:tblGrid/w:gridCol` 和各格 `w:tcW` 两处，要一致；python-docx 的 `cell.width` 只改后者。
- WPS 常在各行写 `w:tblPrEx`，其中的框线、边距会覆盖表级 `w:tblPr` 的设置；上面的函数会一并处理，直接改 `w:tblPr` 不生效时检查它。
