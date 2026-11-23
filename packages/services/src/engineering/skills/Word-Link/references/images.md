# 图片

view 中图片显示为 `{图片N 宽×高磅 “替代文字”}`，浮动图片前加“浮动”。

## 辅助函数

**`pictures(f)`** → `[Picture]`：全部图片，编号与 view 中的 `{图片N}` 一致，`pictures(f)[N - 1]` 为图片 N。每项的属性：

- `index`：编号，从 1 开始；`where`：所在段落的位置标签；`floating`：是否浮动；
- `width`、`height`：显示尺寸（磅），旧式 VML 图片为 None；
- `alt`：替代文字，可直接赋值修改；
- `rid`、`part`：图片数据为 `pic.part.related_parts[pic.rid]`；`element`：XML 元素（`w:drawing` 或 `w:pict`）；
- `pic.resize(width=None, height=None)` → 新的 `(宽, 高)`（磅）：只给一项时另一项按原比例。

**`replace_picture(f, index, path, *, keep="width", alt=None)`** → 新的 `(宽, 高)`（磅）

- 用 `path` 的图片替换图片 `index`，位置和环绕方式不变。
- `keep="width"` 保持原宽度、高度按新图比例；`"height"` 保持高度；`"size"` 保持原宽高（会拉伸变形，一般不用）。
- `alt`：新的替代文字，省略时保留原文字。

## python-docx 直接写

| 任务 | 写法 |
|---|---|
| 插入 | `p.add_run().add_picture(图片路径, width=Cm(14))`；只给宽度时高度按比例 |
| 导出原图 | `img = pic.part.related_parts[pic.rid]`，`Path(r"C:\temp\图N" + img.partname.ext).write_bytes(img.blob)`，再用 view_image 查看 |
| 删除 | 删除图片所在的 run：`r = pic.element.getparent()`，`r.getparent().remove(r)`；图片独占的段落连同题注一起删 |

## 示例

在正文15之后插入图片并加图题：

```python
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm

p = insert_paragraph(f.at("正文15"))
p.add_run().add_picture(r"C:\work\平面图.png", width=Cm(14))
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
get_or_add(p, "w:pPr/w:ind", firstLineChars=0, firstLine=0)   # 去掉首行缩进，图片才真正居中
add_caption(p, "图", "结构平面布置", before=False)
```

替换多张图片：先按 view 把编号与新图逐一对应好，再逐个替换，替换后导出页面图核对。

```python
for index, path in {3: r"C:\work\新图3.png", 5: r"C:\work\新图5.png"}.items():
    replace_picture(f, index, path)
```

浮动与文字环绕要在应用中设置：

```python
with target.open() as doc:
    shape = doc.InlineShapes(1).ConvertToShape()
    shape.WrapFormat.Type = 0                    # 0 四周型，1 紧密型，3 浮于文字上方，4 上下型，5 衬于文字下方
    shape.Left, shape.Top = 100, 50              # 位置（磅），改后看页面图核对
```

## 注意

- 应用中的 `InlineShapes` 只计正文中的内联图片，编号从 1 开始，与 `pictures` 的编号不一定对应，先按页面图核对。
