# 文字与格式

改文字、字体、段落格式、样式、标题和列表，以及整篇翻译。改格式前先用 `f.view(formats=True)` 看各段的样式和格式。

## 辅助函数

### 改文字

**`set_text(paragraph, text, *, font=None)`** → 传入的对象

- 整段改为 `text`，沿用首个文字 run 的格式，段内图片、书签保留；`text` 中的 `\n` 为段内换行。
- `paragraph`：段落；或单元格，文字写入首段，其余段落删除。
- `font`：西文字体名，同时设到写入的文字上。
- 段落含超链接、域、公式、内容控件或修订时报错，改用 `replace_text`。

**`replace_text(scope, old, new, *, expected=None, font=None)`** → 替换处数

- `scope`：`f`（全文，含表格、页眉页脚、脚注、批注和文本框）、段落、单元格、表格，或它们的列表。
- 可跨 run 匹配，替换结果沿用匹配处首个 run 的格式；不改域，匹配不跨超链接、域的边界。
- `expected`：预期处数，不符时报错且不改；零命中也报错。
- 多组替换先换长词，并确认新写入的文字不会被后面的词再次命中。

**`insert_paragraph(anchor, text="", *, before=False, style=None, like=None)`** → 新段落

- 在段落或表格 `anchor` 之后插入，`before=True` 时插在之前。
- `style`：样式名或样式对象；`like`：参照段落，沿用它的段落格式和首个 run 的字体，如新表题参照已有表题。都不给时新段只带样式格式，不沿用相邻段落的格式。

**`isolate(paragraph, text)`** → `[Run]`：把段中恰好出现一次的 `text` 拆成单独的 run，用于单独设格式或加批注；`text` 可跨 run，不能跨超链接、域的边界。

### 字体

**`set_font(target, *, latin=None, east_asia=None, size=None, bold=None, italic=None, color=None)`** → None

- `target`：run、段落、单元格、表格、样式、`f`（全文），或它们的列表、字典（取值）。设段落时连同段落标记一起设，空段之后写入的文字也生效。
- `latin` 西文字体，`east_asia` 中文字体，都会清除对应的主题字体；`size` 为磅；`color` 为 `"RRGGBB"`；`bold`、`italic` 为 True 或 False。
- 设西文字体时，不含中文的文字同时去掉东亚提示，Φ、× 等才按西文字体显示。

### 样式与列表

**`heading_style(f, level)`** → 样式：标题 `level` 级（1–9）的段落样式，即“标题 N”。文档中没有时新建（加粗、与下段同页、带大纲级别，目录能识别，字体沿用正文）。WPS 新建的文档只保存用到的样式，直接写 `style="Heading 1"` 会报找不到样式，所以用它取。

**`set_list(f, paragraphs, kind="bullet", *, level=0, start=1)`** → 编号定义 ID

- 把段落列表设为列表：`kind` 为 `"bullet"`（项目符号）、`"decimal"`（1. 2.）、`"chinese"`（一、二、）、`"paren"`（(1) (2)）。
- `level`：缩进级别，从 0 开始；`start`：起始编号。同一次调用的段落编号连续，再次调用另起新列表。

**`use_chinese_defaults(f, *, body="宋体", latin="Times New Roman", size=12, heading="黑体", heading_sizes=(16, 14, 12), line_spacing=1.5, first_line_chars=2, apply=True)`** → 正文段落样式

- “正文”样式设为 `body`/`latin` 字体、`size` 磅、单倍行距、无缩进，表格和页眉页脚沿用它。另建“正文首行缩进”样式：在正文基础上 `line_spacing` 倍行距、首行缩进 `first_line_chars` 字，即返回的样式，正文段落用它。
- 标题 1–3 为 `heading` 字体、`heading_sizes` 磅、黑色加粗；文档标题（Title 样式）黑体二号居中。页面改为 A4（横向的节仍为横向），上下边距 2.54 厘米、左右 3.17 厘米。
- `apply=True` 时，把正文中未设样式、有文字、未居中、不带编号的段落改用返回的样式；目录占位段和用制表符隔开几项的行（如签字栏）不动。

## python-docx 直接写

```python
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
```

| 任务 | 写法 |
|---|---|
| 追加段落 | `f.doc.add_paragraph("文字", style=样式)` 加到文末；插在中间用 `insert_paragraph`。刚建的空段可以直接写文字，已有文字的段落用 `set_text` |
| 对齐 | `p.alignment = WD_ALIGN_PARAGRAPH.CENTER`；`LEFT`、`RIGHT`、`JUSTIFY`（两端对齐） |
| 段前段后 | `p.paragraph_format.space_before = Pt(6)`、`space_after` |
| 行距 | 倍数 `p.paragraph_format.line_spacing = 1.5`；固定值 `line_spacing = Pt(20)`，再 `line_spacing_rule = WD_LINE_SPACING.EXACTLY` |
| 首行缩进 | `get_or_add(p, "w:pPr/w:ind", firstLineChars=200, firstLine=None)`（2 字）；取消 `firstLineChars=0, firstLine=0` |
| 分页控制 | `p.paragraph_format.keep_with_next = True`（与下段同页）、`keep_together`（段中不分页）、`page_break_before`（段前分页） |
| 加粗、斜体、下划线、颜色 | `r.bold = True`、`r.italic`、`r.underline`、`r.font.color.rgb = RGBColor(0xC0, 0, 0)`；整段或多处用 `set_font` |
| 上下标、着重号 | `r.font.superscript = True`、`r.font.subscript`；`get_or_add(r, "w:rPr/w:em", val="dot")` |
| 改样式定义 | `st = f.doc.styles["Normal"]`（标题用 `heading_style`），再 `set_font(st, …)`、`st.paragraph_format.… = …`；用该样式的段落都随之改变 |
| 删除段落 | `p._p.getparent().remove(p._p)` |

- **字体**：`font.name` 只设西文字体，中文字体在 `w:rFonts` 的 `w:eastAsia`；`asciiTheme`、`eastAsiaTheme` 等主题字体优先于字体名，存在时改名无效。WPS 写入的文字常带东亚提示，Φ、×、“” 会按中文字体显示成全角。这些都用 `set_font` 处理。
- **缩进与段距**：`firstLine`（缇）与 `firstLineChars`（1/100 字）是两套值，有 Chars 时以它为准，中文文档多用它，所以只设 python-docx 的 `first_line_indent` 可能不生效，两个要一起写。`left/leftChars`、`hanging/hangingChars`、`before/beforeLines`、`after/afterLines` 同理。
- **行距**：`w:spacing` 的 `w:line` 在 `lineRule="auto"` 时为 1/240 行（360 为 1.5 倍），固定值或最小值时为缇。节设了文档网格（`w:docGrid` 的 `type="lines"`）时行高按网格取整，调小行距无效，要在段落上加 `get_or_add(p, "w:pPr/w:snapToGrid", val=0)`。
- **开关属性**：加粗、斜体、与下段同页等，python-docx 中 `True` 开、`False` 关（覆盖样式）、`None` 沿用样式；XML 中 `<w:b/>` 开、`<w:b w:val="0"/>` 关，没有该元素为沿用。
- **样式**：段落和 run 上的直接格式优先于样式，改了样式不生效时，查看段落和 run 上有没有直接设的格式。python-docx 按显示名取样式（`styles["Heading 1"]`），XML 中 `w:pStyle` 的值是样式 ID。
- **自动编号**：“第1章”“1.2”“（1）”这类自动编号不在段落文字中，`view(formats=True)` 中显示为“编号N/级别”；要改就改编号定义或样式，不要在文字里再写一遍。去掉段落的编号（含样式带来的）：`get_or_add(p, "w:pPr/w:numPr/w:numId", val=0)`。

## 示例

按模板填写：模板中写着 `{{项目名称}}` 这类占位文字，表 2 为只留了一行空行的构件表。

```python
target = WordSession(r"C:\work\计算书模板.docx", save_as=r"C:\work\1号楼计算书.docx")
f = DocxFile(target.path)
for key, value in {"{{项目名称}}": "1号楼", "{{结构形式}}": "钢筋混凝土框架结构"}.items():
    replace_text(f, key, value)                       # 没找到时报错，能发现写错的占位文字

rows = [["KZ1", "C30", "12Φ25"], ["KZ2", "C30", "12Φ22"]]
t = f.at("表2")
insert_rows(t, 2, len(rows) - 1)                      # 照抄第 2 行的格式补足行数
cells = table_cells(t, expand=True)
for r, row in enumerate(rows, start=2):
    for c, text in enumerate(row, start=1):
        set_text(cells[r, c], text)
print(f.save())
```

统一全文格式：正文宋体小四、1.5 倍行距、首行缩进 2 字，标题黑体。先改样式定义，再清掉正文段落上覆盖样式的直接格式。

```python
body = use_chinese_defaults(f)                        # 改样式定义，未设样式的正文段落改用正文样式
for p in f.doc.paragraphs:
    if p.style.name == body.name:
        for el in p._p.xpath("./w:pPr/w:ind | ./w:pPr/w:spacing"):
            el.getparent().remove(el)                 # 段落上直接设的缩进、段距、行距
        set_font(p, latin="Times New Roman", east_asia="宋体", size=12)   # run 上直接设的字体、字号
    elif p.style.name.startswith("Heading"):
        set_font(p, latin="Times New Roman", east_asia="黑体")
print(f.save())                                       # 摘要第一行应为“文字：未变”
```

单独标出一段文字：

```python
for r in isolate(p, "严禁"):
    r.bold = True
    get_or_add(r, "w:rPr/w:em", val="dot")            # 着重号
```

## 翻译

**`f.translate(mapping, *, font=None)`** → 对账结果，`print` 查看

- `mapping`：`{原文或标签: 译文}`。键为 view 中的段落标签（如“正文12”“表1(2,3)”）时只改该段；否则与每段全文比较，相同的都改。比较时空格、全角空格、制表符、换行都算一个空格，首尾空白忽略。
- 整段改写，方式同 `set_text`；含超链接、域、公式的段落不改，列入 `special`。`font` 为译文的西文字体。
- 结果的属性：`remaining` 为仍含中文的段落 `{标签: 原文}`；`special` 为没有改的段落 `[(标签, 原因, 原文)]`；`missing` 为没有命中的原文。

译文另存为新文件：`target = WordSession(原路径, save_as=译文路径)`，然后：

1. `todo = f.translate({}).remaining` 取得全部待译段落（不改文档），按标签逐段写译文，如 `{"正文3": "General", "表1(2,1)": "Beam"}`；多处相同的短语可用原文作键，一次改全部。
2. `print(f.translate(映射, font="Times New Roman"))`。
3. `special` 中的段落用 `replace_text` 分片改；`remaining` 中剩下的逐条补齐或说明原因。
4. 图片、图表、SmartArt 中的文字不在段落里：用 `pictures(f)` 列出图片，导出原图查看，含中文的换成译后的图片或向用户说明；图表、SmartArt 在页面图中核对。
5. 译文变长的表格用 `fit_columns` 重排列宽。

## 中文字号

| 初号 | 小初 | 一号 | 小一 | 二号 | 小二 | 三号 | 小三 | 四号 | 小四 | 五号 | 小五 | 六号 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 42 | 36 | 26 | 24 | 22 | 18 | 16 | 15 | 14 | 12 | 10.5 | 9 | 7.5 |
