# 页面、分节与页眉页脚

`s = f.doc.sections[i]` 为第 i+1 节，即 view 中第 i+1 个“分节符”以上的内容，最后一节到文末。view 的分节符行列出这一节的纸张、方向等设置。

## 辅助函数

**`split_section(paragraph, *, start="new_page")`** → `(前一节, 后一节)`

- 在正文段落 `paragraph` 之后分节，两节初始设置相同，再分别修改；后一节的页眉页脚改为链接前一节，显示不变。
- `paragraph` 不能在表格或文本框中，也不能已是一节的末尾。
- `start`：后一节的起始方式，`"new_page"`（下一页）、`"continuous"`（连续）、`"odd_page"`（奇数页）、`"even_page"`（偶数页）。

**`landscape_pages(first, last)`** → 横向的节：让 `first` 到 `last`（段落或表格，含两端）单独成节并改为横向，前后内容保持原方向；首尾是表格时，自动在表前后补空段承载分节符。

**`add_page_number(part, template="{PAGE}", *, align="center")`** → 页码段落

- 在页眉或页脚 `part`（如 `s.footer`、`s.even_page_footer`、`s.header`）加入页码：首段为空时写在首段，否则另加一段。
- `template`：花括号中写域代码，如 `"第 {PAGE} 页 共 {NUMPAGES} 页"`；`align`：`"left"`、`"center"`、`"right"`。
- 该页眉页脚改为不链接前一节。

## python-docx 直接写

```python
from docx.shared import Mm, Cm
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_BREAK
```

| 任务 | 写法 |
|---|---|
| 纸张 | `s.page_width, s.page_height = Mm(210), Mm(297)`；A4 为 210×297 毫米，A3 297×420，B5 176×250（JIS B5 182×257），Letter 215.9×279.4 |
| 方向 | `s.orientation = WD_ORIENT.LANDSCAPE`，同时交换宽高：改方向不会换纸 |
| 边距、装订线 | `s.top_margin = s.bottom_margin = Cm(2.54)`，`s.left_margin`、`s.right_margin`；`s.gutter` |
| 分栏 | `get_or_add(s, "w:cols", num=2, space=425)`（栏距 425 缇）；恢复单栏 `num=1` |
| 页眉页脚距边界 | `s.header_distance`、`s.footer_distance` |
| 分页 | 段前分页 `p.paragraph_format.page_break_before = True`；段中分页 `run.add_break(WD_BREAK.PAGE)` |
| 页眉页脚 | `s.header`、`s.footer` 为奇数页的（未设奇偶页不同时为每页）；`s.first_page_header`、`s.even_page_footer` 等为首页、偶数页的；段落在 `.paragraphs` 中，也可用 `f.at("页眉N")` 取 |
| 改页眉文字 | `s.header.is_linked_to_previous = False`，再 `set_text(s.header.paragraphs[0], "文字")` |
| 页码格式、起始值 | `get_or_add(s, "w:pgNumType", fmt="upperRoman", start=1)`；`fmt` 常用 `decimal`、`upperRoman`、`lowerRoman`、`chineseCounting`（一、二）；接续前一节时 `start=None` |
| 首页不同 | `s.different_first_page_header_footer = True`，再改 `s.first_page_header`、`s.first_page_footer` |
| 奇偶页不同 | `f.doc.settings.odd_and_even_pages_header_footer = True`（整篇生效），再改 `s.even_page_header`、`s.even_page_footer`；原有页码只留在奇数页，偶数页另加 `add_page_number(s.even_page_footer)` |
| 页眉横线 | 页眉段落加下框线 `get_or_add(p, "w:pPr/w:pBdr/w:bottom", val="single", sz=6, space=1, color="auto")`；去掉样式自带的横线用 `val="nil"` |

## 示例

封面、目录不显示页码，正文从 1 开始：

```python
s1, s2 = split_section(f.at("正文12"))            # 正文12 为目录后的段落
get_or_add(s2, "w:pgNumType", start=1)
add_page_number(s2.footer, "{PAGE}")
for r in s1.footer._element.xpath(".//w:r"):     # 前一节保留着原页脚，删去其中的页码等内容
    r.getparent().remove(r)
```

宽表所在的页改为横向：

```python
t = f.at("表5")
landscape_pages(t, t)
fit_columns(t)                                   # 按横向版心重排列宽
```

## 注意

- 本节页眉页脚链接前一节时，python-docx 取到的是前一节的页眉页脚，改它会改到前一节；改之前先设 `is_linked_to_previous = False`（`add_page_number` 会自动设）。
- 分节后，之前取到的节对象只代表分节处之后的部分；改设置前按序号从 `f.doc.sections` 重新取。
- 段前分页与前面的空段或分页符叠加会多出空白页，加之前先看 view 中有没有 `{分页}`。
- 设了奇偶页不同，而新节页码从 1 开始时，WPS 会补一张空白页，让这一节从奇数页开始。
