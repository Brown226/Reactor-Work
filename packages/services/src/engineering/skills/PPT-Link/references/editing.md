# 编辑已有演示文稿

## 读懂原文件

1. `print(f.view())` 看每页有哪些形状、写了什么；页数多时分段 `f.view(slides=(1, 20))`，要改格式时加 `formats=True`。
2. 接管后用 `render_slides`、`contact_sheet` 出图，用 view_image 看版面：文字视图看不出排版、配色和图片内容。
3. 用 `f.find("文字")` 找到要改的段落和标签，用 `f.at(标签)` 取对象。用户说的“第 3 页”即 `页3`。

空占位符在 view 中写作“（空，版式提示：…）”，提示文字取自版式中的示例，说明这里该填什么，如“01”“一级标题填写处”。

## 改内容

| 任务 | 写法 |
|---|---|
| 改写一段或一个文本框，保留格式 | `set_text(f.at("页3/2"), "…")`，只改一段用 `f.at("页3/2¶2")` |
| 全篇替换名称、数据 | `replace_text(f, "旧", "新", expected=处数)` |
| 改表格中的数 | `set_text(f.at("页5/3(2,4)"), "3150")` |
| 改图表数据 | `chart.replace_data(data)`，见 tables-charts.md |
| 换图 | `replace_picture(f.at("页2/4"), 路径)` |
| 移动、改大小 | `shape.left`、`shape.top`、`shape.width`、`shape.height`，值为长度，如 `Cm(2)`；按比例算的要取整，如 `int(W * 0.3)` |
| 整体平移几个形状 | `for shp in [x for x in s.shapes if x.top > Cm(8)]: shp.top += Pt(20)`；按位置选时遍历 `s.shapes`（组合算一个），不要用 `f.walk()`：它还列出组合里的形状，组合会被移两次 |
| 删除形状 | `el = shape._element; el.getparent().remove(el)` |
| 改颜色、字体 | `set_fill`、`set_line`、`set_font` |

- 只改用户要求的地方；顺带发现的问题（错字、数据前后不一致）列出来问用户，不要自己改。
- 改完 `print(f.diff())`：文字的增删应只来自要求的修改，视图中没有计划外的变化。

## 页面操作

**`add_slide(target, layout=None, *, index=None)`** → 新页

- `target`：`f` 或 python-pptx 的 Presentation。
- `layout`：版式名（view 开头的版式列表）或 SlideLayout；省略时用空白版式（“Blank”“空白”，没有时取占位符最少的）。
- `index`：新页的页码，从 1 开始，省略时加在末尾。
- 新页带有版式中的占位符（日期、页脚、页码除外），用不上的删去。

**`duplicate_slide(target, slide, *, index=None)`** → 新页：新页在原页之后，或第 `index` 页。形状、背景、切换效果和超链接照搬；图表和嵌入对象连同数据另复制一份，改新页不影响原页；图片共用；备注不复制。

**`delete_slide(target, slide)`** → None：它的备注，以及只被它用到的图片、图表，在保存时一起删去。

**`move_slide(target, slide, index)`** → slide：移到第 `index` 页。

- 页码从 1 开始，`f.prs.slides[i]` 从 0 开始。删多页时先取出全部要删的页，再逐页删：`for s in [f.prs.slides[i - 1] for i in (3, 7, 9)]: delete_slide(f, s)`。
- 文件分了节时，上面的函数同步更新节中的页面列表；新页归入它前一页所在的节。
- 别的演示文稿中的页不能直接拷进来（母版、版式和主题不同）：在目标文件中用它的版式新建页面，再把原页的文字、图片放进去。

## 用模板做

先判断模板是哪一种：新建一份 `f = PptxFile.new(成果路径, template=模板路径)`，看 view 和出图。

### 模板只有版式

母版中设计好了封面、目录、章节页、内容页等版式，页面本身是空的或只有使用说明。

1. 删去模板中的说明页。
2. 每种版式各新建一页、出图看一遍，记下各版式的用途、占位符的用途（看“版式提示”），以及内容页中可以放内容的区域（标题下方、避开 Logo 和页码）。
3. 按页面清单逐页 `add_slide(f, 版式名)`，占位符用 `set_text` 填写，文字的字体、字号随版式；用不上的占位符删去。同一版式新建的页，形状顺序都与第 2 步看到的相同：view 中的 `页N/K` 即 `s.shapes[K - 1]`。
4. 内容页的正文、图、表用 `add_text`、`add_picture`、`insert_table` 放在记下的区域内，颜色取主题色，字体用主题字体（不设 `latin`、`east_asia`，或写 `"+mn-lt"`、`"+mn-ea"`）。

```python
from pptx.util import Cm

from PKPMAgent.software_link_kit.ppt import *

f = PptxFile.new(r"C:\work\2026 年三季度工作汇报.pptx", template=r"C:\work\公司模板.pptx")
for slide in list(f.prs.slides):                         # 模板中的示例页不要
    delete_slide(f, slide)

s = add_slide(f, "标题幻灯片")                            # 第 2 步的 view：页N/1 副标题，页N/2 标题，页N/3 公司名
subtitle, title, company = s.shapes
set_text(title, "2026 年三季度工作汇报")
set_text(subtitle, "技术中心\n2026.10.8")
set_text(company, "北京构力科技有限公司")

s = add_slide(f, "章节页")
number, heading = s.shapes                               # 版式提示分别为“01”“一级标题填写处”
set_text(number, "01")
set_text(heading, "重点项目进展")

s = add_slide(f, "仅标题（公司logo）")
set_text(s.shapes.title, "三个重点项目均按计划推进，滨江文化中心提前两周完成方案报批")
add_text(s, Cm(1.2), Cm(3.5), Cm(20), Cm(8), "……", size=16)
print(f.save())
```

`s.placeholders` 按占位符编号排序，与 view 的顺序不同，取占位符用 `s.shapes`。

### 模板带示例页

每页都已设计好，文字和图片是示例，照着示例页的样子做。

1. 给每页示例定用途（封面、目录、章节页、图文页、数据页……），把页面清单中的每页对应到一页示例；同类示例有多页时（如 01–05 各一页的章节页）依次对应，用完了再复制。
2. 同一示例要用多次时 `duplicate_slide` 复制，按清单顺序用 `move_slide` 排好，没用上的示例页 `delete_slide`。
3. 逐页改写：文字用 `set_text`、`replace_text`，保留原格式；图片用 `replace_picture`；示例中多出的条目（如四个要点只用三个）连同其图形一起删去，不要留空框，然后调整剩下元素的间距。
4. 文字比示例长很多时，精简文字或换一页版面更合适的示例，不要缩小到看不清。

```python
f = PptxFile.new(r"C:\work\滨江文化中心汇报.pptx", template=r"C:\work\上次汇报.pptx")
cover, section, content = f.prs.slides[0], f.prs.slides[1], f.prs.slides[2]   # 用作封面、章节页、内容页的示例
pages = [content, duplicate_slide(f, content), duplicate_slide(f, content)]
for slide in list(f.prs.slides):
    if slide not in (cover, section, *pages):
        delete_slide(f, slide)
print(f.view())                                          # 按新的页码和形状标签逐页改写
```

## 美化已有页面

用户要美化某几页或整篇时，内容不变，改版面。

1. 出图看原页，`f.view(slides=…, formats=True)` 看格式；先弄清每页要说明什么。
2. 列出问题：没对齐、字号层级乱、颜色太多、文字挤满页面、图片变形或模糊、装饰多余等。
3. 在原页上改：调整位置和尺寸使元素对齐，统一字号层级和颜色，删去多余的装饰；版面要大改时，在其后新建一页重排，确认无误后删去原页。
4. 保留母版中的 Logo、页码、页脚，以及用户的配色和字体，除非用户要求换掉。
5. `print(f.diff())` 核对文字守恒：美化不应增删文字；有意精简的，交付时列出。

## 统一字体和配色

- **字体**：`set_theme(f, heading=…, body=…)` 改主题字体，没有单独设字体的文字随之改变；单独设了字体的文字要再用 `set_font` 改，如全篇 `set_font(f, latin="Arial", east_asia="微软雅黑")`，或只改标题 `set_font([s.shapes.title for s in f.prs.slides if s.shapes.title], …)`。
- **颜色**：`set_theme(f, colors=…)` 改主题色，用主题色的元素随之改变；直接写了颜色值的，按值替换：

```python
old, new = "C00000", "1D78FA"
for part in f.prs.part.package.iter_parts():             # 页面、母版、版式、备注、图表
    if hasattr(part, "_element"):
        for color in part._element.xpath(f".//a:srgbClr[@val='{old}']"):
            color.set("val", new)
```

## 母版上的元素

Logo、页码、页脚、背景图等在母版或版式上，每页都显示；改一处，用该母版或版式的页面都变。

- 母版的形状 `f.prs.slide_master.shapes`，版式的形状 `layout.shapes`（版式用 `f.prs.slide_layouts` 遍历）；换 Logo 用 `replace_picture(形状, 路径)`。
- 母版、版式上的形状不在页面的标签中，view 也不列出；按名称或位置找：`for shape in layout.shapes: print(shape.shape_type, shape.name, shape.left, shape.top)`。
- 新页不带版式中的页码占位符。要显示自动编号的页码，把版式中的页码占位符复制到页面上：

```python
from copy import deepcopy
from pptx.enum.shapes import PP_PLACEHOLDER

for slide in list(f.prs.slides)[1:]:                     # 封面不加
    number = [ph for ph in slide.slide_layout.placeholders if ph.placeholder_format.type == PP_PLACEHOLDER.SLIDE_NUMBER]
    if number and not any(ph.placeholder_format.type == PP_PLACEHOLDER.SLIDE_NUMBER for ph in slide.placeholders):
        slide.shapes._spTree.append(deepcopy(number[0]._element))
```
