# 新建文档

## 文档结构

正式文档（报告、计算书、说明书、方案）一般包含下列部分，按用户要求和内容取舍：

| 部分 | 写法 |
|---|---|
| 封面 | 文档标题（Title 样式）、工程名称、编制单位、日期，居中；与目录同在不显示页码的第一节 |
| 目录 | 章节较多时加，用 `insert_toc`，另起一页 |
| 正文 | 章节标题用标题 1–3 样式（`heading_style`），目录据此生成；章节号如“2.1”写在标题文字中。正文段落用 `use_chinese_defaults` 返回的样式 |
| 表格 | `insert_table`，0.5 磅细框线或三线表；表题在表上方，用 `add_caption` 自动编号 |
| 图片 | 单独一段、居中；图题在图下方，用 `add_caption` |
| 公式 | `add_equation`，需要编号时给 `number` |
| 页眉页脚 | 页眉写文档名，页脚放页码，正文从第 1 页编起 |

文字用黑色，强调用加粗；表头可加浅灰底纹。用户没有给出的信息（编制单位、日期、计算参数等）不要自己编：先问用户，或写成醒目的“【待补：编制单位】”，交付时逐项列出。

## 写的顺序

先设格式再写内容，写入的段落直接套用样式，不用事后逐段调整：

1. `f = DocxFile.new(路径)`，`body = use_chinese_defaults(f)`：纸张改为 A4，设好常用中文格式，得到正文样式。
2. 按阅读顺序把封面、目录、正文追加到文末：段落用 `f.doc.add_paragraph(文字, style=…)`，表格用 `insert_table(f, …)`，公式写进新加的空段。写到要分节的地方（如目录之后）就分节。
3. 设页眉页脚和页码。
4. `print(f.save())`，再按 SKILL.md 新建流程的第 5、6 步更新域、看页面、交付。

## 常见错误

| 错误 | 正确写法 |
|---|---|
| 不设纸张：python-docx 自带模板是 Letter 纸 | `use_chinese_defaults` 会改为 A4；不用它时设 `s.page_width, s.page_height = Mm(210), Mm(297)` |
| 在文字中用 `\n` 分段 | `\n` 是段内换行，每段单独写一个段落 |
| 手打“•”“1.”做列表 | 用 `set_list`，见 text.md |
| 用空段、空格拉开间距或排位置 | 段间距用 `space_before`、`space_after`；另起一页用段前分页；同一行分开的几项用制表位（见示例中的签字栏） |
| 用表格或一串下划线画横线 | 用段落框线：`get_or_add(p, "w:pPr/w:pBdr/w:bottom", val="single", sz=6, space=1, color="auto")` |
| 标题用加粗放大的普通段落 | 用 `style=heading_style(f, 级别)`，否则进不了目录和导航窗格 |
| 用 `f.doc.add_table` 新建表格 | 它建的表没有框线、列宽不固定，用 `insert_table` |
| 目录、表图编号写成普通文字 | 用 `insert_toc`、`add_caption`，保存后更新域 |

## 示例：结构计算书

```python
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

from PKPMAgent.software_link_kit.office import *

f = DocxFile.new(r"C:\work\1号楼结构计算书.docx")
body = use_chinese_defaults(f)                          # 正文样式：宋体小四、1.5 倍行距、首行缩进 2 字
doc = f.doc
h1, h2 = heading_style(f, 1), heading_style(f, 2)

# 封面
title = doc.add_paragraph("1号楼结构计算书", style="Title")
title.paragraph_format.space_before = Pt(200)           # 标题下移到页面中部
for text in ["工程名称：某小区 1号楼", "编制单位：【待补：编制单位】", "2026 年 9 月"]:
    doc.add_paragraph(text).alignment = WD_ALIGN_PARAGRAPH.CENTER
sign = doc.add_paragraph("计算：\t校对：\t审核：")        # 同一行分开的几项用制表位对齐
sign.paragraph_format.space_before = Pt(60)
for pos in (Cm(6), Cm(12)):
    sign.paragraph_format.tab_stops.add_tab_stop(pos)

# 目录另起一页；目录后分节：封面和目录一节不显示页码，正文另起一节
toc_title = doc.add_paragraph("目录")
toc_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
toc_title.paragraph_format.page_break_before = True
set_font(toc_title, east_asia="黑体", size=16)
toc = insert_toc(toc_title, title=None)
front, main = split_section(insert_paragraph(toc))      # 目录后的空段承载分节符

# 正文
doc.add_paragraph("1 工程概况", style=h1)
doc.add_paragraph("本工程为地上 5 层钢筋混凝土框架结构，……", style=body)

doc.add_paragraph("2 荷载", style=h1)
doc.add_paragraph("2.1 楼面荷载", style=h2)
doc.add_paragraph("楼面荷载标准值按下表取用。", style=body)
t = insert_table(f, [
    ["部位", "恒载（kN/m²）", "活载（kN/m²）"],
    ["办公室", 5.0, 2.5],
    ["走廊", 5.0, 3.5],
])
set_three_line(t, 1)
add_caption(t, "表", "楼面荷载标准值")

doc.add_paragraph("3 构件验算", style=h1)
doc.add_paragraph("矩形截面梁正截面受弯承载力按下式计算：", style=body)
add_equation(doc.add_paragraph(), r"M \le \alpha_1 f_{\mathrm{c}} b x \left(h_0 - \frac{x}{2}\right)", number="(3-1)")

# 页眉页脚：正文节从第 1 页编页码，页眉写文档名
get_or_add(main, "w:pgNumType", start=1)
add_page_number(main.footer, "{PAGE}")
main.header.is_linked_to_previous = False
header = main.header.paragraphs[0]
set_text(header, "1号楼结构计算书")
header.alignment = WD_ALIGN_PARAGRAPH.CENTER

print(f.save())
```
