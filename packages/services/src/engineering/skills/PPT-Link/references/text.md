# 文字

新建文本框、改写和替换文字、字体、段落格式、列表，以及整篇翻译。改格式前先用 `f.view(formats=True)` 看各段的格式。

文字的写法与 python-pptx 相同：写入形状、文本框架或单元格时，`"\n"` 分段，`"\v"` 为段内换行；写入单个段落时 `"\n"` 为段内换行。

## 辅助函数

**`add_text(slide, left, top, width, height, text="", *, align=None, anchor=None, **font)`** → 文本框形状

- 自动换行，内边距为 0（文字与框边对齐，便于和线条、图片对齐），框的大小固定，不随文字缩放或撑大。python-pptx 的 `add_textbox` 默认不换行、随文字撑大，长文字会跑出页面。
- `align`：`"left"`、`"center"`、`"right"`、`"justify"`（两端对齐）、`"distributed"`（分散对齐）。
- `anchor`：文字在框内的竖向位置，`"top"`、`"middle"`、`"bottom"`。
- `font`：`set_font` 的参数，如 `size=14, color="474F58", bold=True, east_asia="微软雅黑"`。
- 文字多于框高时溢出框外。框高不要手算：先随便给一个（如 `Pt(20)`），设好字号、行距后用 `fit_height` 定。

**`fit_height(shape)`** → 传入的形状

- 按其中的文字把文本框或形状的高度设为正好容下：按本机字体的字宽和 WPS 的规则折行（汉字逐字折行，西文按词折行，行末的逗号、句号可伸出框外），计入字号、粗体、字距、行距、段前段后、列表缩进和内边距，结果与 WPS 的排版一致。
- 行高：单倍行距时为该行最大字号的 1.2 倍，设了行距倍数再乘上它；首段的段前、末段的段后和末尾的空段不占高度。
- 竖向对齐为居中、底端时，分别保持中线、下沿不动。
- 在文字、字号、行距都设好之后调用，改了这些再调用一次。接在下方的元素用它定位：`top = box.top + box.height + Pt(12)`。
- 文字上没写明的字体、字号按主题正文字体和 18 磅计，所以不用于占位符（格式来自版式）。

```python
body = add_text(s, M, H * 0.5, W * 0.32, Pt(20), "剧场、展厅与图书馆分置三个体量……", size=14, color=BODY)
for p in body.text_frame.paragraphs:
    p.line_spacing, p.space_after = 1.4, Pt(8)
fit_height(body)
note = add_text(s, M, body.top + body.height + Pt(16), W * 0.32, Pt(20), "注：面积为方案阶段估算。", size=11, color=BODY)
fit_height(note)
```

**`set_text(target, text, *, font=None)`** → 传入的对象

- `target` 为形状、文本框架或单元格时按 `"\n"` 分段：第 i 段沿用原第 i 段的格式（项目符号、缩进、字体），多出的段落沿用原最后一段，原有多余的段落删去。
- `target` 为段落时整段改为 `text`，沿用首个 run 的格式；段落含域（页码、日期）、超链接或公式时报错，改用 `replace_text`。
- `font`：西文字体名，同时设到写入的文字上。

**`replace_text(scope, old, new, *, expected=None, font=None)`** → 替换处数

- `scope`：`f`（全部页面，含表格和备注）、幻灯片、形状、表格、单元格、段落，或它们的列表。
- 可跨同一段中相邻的多个 run 匹配，替换结果沿用匹配处首个 run 的格式；匹配不跨段内换行和域。
- `expected`：预期处数，不符时报错且不改；零命中也报错。
- 多组替换先换长词，并确认新写入的文字不会被后面的词再次命中。

**`set_font(target, *, latin=None, east_asia=None, size=None, bold=None, italic=None, color=None, spacing=None)`** → None

- `target`：run、段落、形状、文本框架、单元格、表格、幻灯片、`f`（全部），python-pptx 的 Font，图表（整体，或 `chart.legend.font`、`axis.tick_labels.font` 等），或它们的列表。设段落时连同段末标记一起设，空段和之后输入的文字也生效。
- `latin` 西文字体，`east_asia` 中文字体，名称见 fonts.md；写 `"+mn-lt"`、`"+mn-ea"`、`"+mj-lt"`、`"+mj-ea"` 为引用主题字体。
- `size` 为磅；`color` 为 `"RRGGBB"`；`bold`、`italic` 为 True 或 False；`spacing` 为字距（磅，负数为收紧）。

**`set_list(target, kind="bullet", *, char="•", style="arabicPeriod", indent=18, level=None, color=None)`** → None

- `target`：段落、形状、文本框架，或它们的列表；形状取其全部段落。
- `kind`：`"bullet"` 项目符号（符号为 `char`），`"number"` 自动编号，`None` 取消列表。
- `style`：编号样式，`"arabicPeriod"`（1.）、`"arabicParenR"`（1)）、`"circleNumDbPlain"`（①）、`"ea1ChsPeriod"`（一、）、`"romanUcPeriod"`（I.）、`"alphaUcPeriod"`（A.）等。
- `indent`：每级缩进（磅），符号悬挂在缩进内；`level`：级别，从 0 开始，省略时保留原级别；`color`：符号颜色，省略时同文字。

## python-pptx 直接写

```python
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Pt
```

| 任务 | 写法 |
|---|---|
| 一段中不同格式 | `run = p.add_run()`，`run.text = "万㎡"`，再 `set_font(run, size=…, color=…)` |
| 对齐 | `p.alignment = PP_ALIGN.CENTER`；竖向 `frame.vertical_anchor = MSO_ANCHOR.MIDDLE` |
| 行距 | 倍数 `p.line_spacing = 1.4`；固定值 `p.line_spacing = Pt(24)` |
| 段前段后 | `p.space_before = Pt(6)`、`p.space_after` |
| 内边距 | `frame.margin_left = Pt(8)`，`margin_right`、`margin_top`、`margin_bottom` 同理 |
| 超链接 | `run.hyperlink.address = "https://…"` |
| 上标、下标 | `get_or_add(run, "a:rPr", baseline=30000)`（上标）、`baseline=-25000`（下标） |
| 竖排 | `get_or_add(shape.text_frame._txBody, "a:bodyPr", vert="eaVert")` |
| 删除段落 | `p._p.getparent().remove(p._p)`，形状中至少留一段 |
| 备注 | `slide.notes_slide.notes_text_frame.text = "…"`，只在用户要求时加 |

- **字体**：`font.name` 只设西文字体，中文字体在 `a:ea`，用 `set_font(…, east_asia=…)`。没有写明字体的文字用主题字体（`set_theme`）。
- **继承**：段落和 run 上没写的格式取自文本框的列表样式、版式和母版中的占位符，所以占位符里的文字即使没设字号也有字号；`view(formats=True)` 只列出写明的格式。
- **字号自己定，框高用 `fit_height` 定**，再用 `check_slides` 核对。不要靠“文字缩放以适应”（`frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE`）：缩放比例要由应用在编辑时计算，文件里只写这个设置，WPS 打开后仍按原字号显示、照样溢出。`frame.fit_text` 只按一个西文字体文件估算，中文估不准。

## 翻译

**`f.translate(mapping, *, font=None)`** → 对账结果，打印即可查看

- 按 `{原文或标签: 译文}` 整段改写：键为 view 中的段落标签（如 `"页3/2¶1"`）时只改该段；否则按原文与段落全文比较（忽略空白差异），同一原文的每处都改写。
- 含域、超链接、公式的段落不改写，列入“需单独处理”，用 `replace_text` 分片改写。
- `font`：译文的西文字体。
- 结果的 `remaining` 为仍含中文的段落 `{标签: 原文}`；`f.translate({})` 不改任何段落，可由此得到待译段落的底稿。

步骤：

1. 接管时另存：`target = PptSession(路径, save_as=译文路径)`，`f = PptxFile(target.path)`。
2. `todo = f.translate({}).remaining`，据此写出 `mapping`（整段翻译，保持原意和术语一致）。
3. `print(f.translate(mapping, font="Arial"))`，处理“需单独处理”和“未命中”的条目，直到 `remaining` 为空。
4. 英文通常比中文长，`save()` 后用 `check_slides` 找出溢出的文本框，缩小字号或加宽文本框，不要删译文。
