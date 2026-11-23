# 形状、图片与结构图

## 辅助函数

**`add_shape(slide, kind, left, top, width, height, *, fill=None, line=None, line_width=1, adjust=None)`** → 形状

- `kind`：shapes.md 中的形状名，如 `"rect"`、`"roundRect"`、`"ellipse"`、`"triangle"`、`"rightArrow"`、`"chevron"`；名称写错时报错并提示相近的名称。
- `adjust`：调整值列表，个数、含义和默认值见 shapes.md，省略时用默认值。如圆角矩形为 `[圆角半径 ÷ 短边 × 100000]`。
- `fill`：填充颜色 `"RRGGBB"`；`line`：边线颜色，`line_width` 为边线磅数；两者为 None 时无填充、无边线。
- 新形状没有阴影、渐变等主题效果。python-pptx 的 `add_shape` 会套用主题样式（主题色填充、深色边线、白字），不要用。

**`add_line(slide, *points, color="000000", width=1, dash=None, arrows=None)`** → 线条形状

- `points`：依次经过的点 `(x, y)`；两个点为直线，更多为折线（如结构图中的直角连线）。
- `color`、`width`（磅）、`dash`、`arrows` 同 `set_line`。

**`set_fill(target, value, *, alpha=None, angle=90, radial=False)`** → None

- `target`：形状、单元格、表格行、表格（全部单元格）、幻灯片（即页面背景），或它们的列表。
- `value`：颜色 `"RRGGBB"`，None 为无填充；列表为渐变，各项为颜色（均匀分布）、`(位置 0–1, 颜色)` 或 `(位置, 颜色, 不透明度)`，如 `[(0, "000000", 0), (1, "000000", 0.6)]` 为由透明到 60% 黑的遮罩，盖在照片上让文字清楚。
- `alpha`：不透明度 0–1，渐变时用于没有单独给出的色标；`angle`：线性渐变的方向，90 为从上到下，0 为从左到右；`radial=True`：从中心向外的径向渐变。

**`set_line(target, color, width=None, *, dash=None, alpha=None, arrows=None)`** → None

- `target`：形状、线条、图片或它们的列表；表格的线用 `set_borders` 等。
- `color`：`"RRGGBB"`，None 为无线；`width`：磅。
- `dash`：`"dash"`、`"sysDash"`、`"sysDot"`、`"lgDash"`、`"dashDot"` 等，省略为实线。
- `arrows`：`(起点, 终点)` 的箭头样式，各取 `"triangle"`、`"stealth"`、`"arrow"`、`"diamond"`、`"oval"` 或 None，如 `(None, "triangle")`。

**`add_picture(slide, path, left, top, width, height, *, fit="cover", clip=None, adjust=None)`** → 图片形状

- 图片按原比例放进给定的框，不变形。
- `fit`：`"cover"` 填满框、裁去多出的部分（照片）；`"contain"` 完整显示，缩小后在框内居中（图纸、分析图、截图，不能裁掉内容）；`"fill"` 拉伸，只用于本来就同比例的图。
- `clip`：裁剪外形，取 shapes.md 中的形状名，如 `"roundRect"`（圆角）、`"ellipse"`（圆形），`adjust` 为其调整值。

**`replace_picture(picture, path, *, fit="cover")`** → picture

- 换掉图片，位置、大小、裁剪外形和边框不变；`fit="contain"` 时在原框内缩小居中。
- `picture`：图片形状，或以图片填充的形状（模板中常见，只能 `"cover"`、`"fill"`）。

**`add_formula(slide, latex, left, top, *, size=24, color="000000")`** → 图片形状

- 把 LaTeX 公式渲染成透明底的图片，按字号 `size` 磅的实际大小放在 `(left, top)`。
- `latex` 不带 `$`，如 `r"\sigma = \frac{N}{A} + \frac{M}{W}"`；支持上下标、分式、根号、积分、求和、希腊字母和常用符号，不支持矩阵、多行对齐和中文。公式中的中文说明另用 `add_text` 写在旁边。

## python-pptx 直接写

| 任务 | 写法 |
|---|---|
| 形状中写字 | `set_text(shape, "…")`、`set_font(shape, …)`；内边距 `shape.text_frame.margin_left = Pt(6)` 等。排版为主的文字用 `add_text` 另建文本框，便于对齐 |
| 名称 | `shape.name = "封面照片"`，view 和 `check_slides` 中按名称显示 |
| 旋转、翻转 | `shape.rotation = 45`（顺时针，度）；水平翻转 `get_or_add(shape._element.spPr, "a:xfrm", flipH=1)` |
| 叠放次序 | 后加的在上层。移到最底层：`el = shape._element; tree = slide.shapes._spTree; tree.remove(el); tree.insert(2, el)`；移到最上层：`tree.append(el)` |
| 组合 | `slide.shapes.add_group_shape([a, b, c])`，组内的形状在 view 中为 `页N/K/J` |
| 删除 | `el = shape._element; el.getparent().remove(el)` |
| 去掉已有形状的阴影 | `shape.shadow.inherit = False` |
| 图片半透明 | `get_or_add(pic._element.blipFill, "a:blip/a:alphaModFix", amt=60000)`（不透明度 60%） |
| 图片的裁剪位置 | `add_picture` 的 cover 从中间裁；要保留上部时，`pic.crop_top = 0`，`pic.crop_bottom = 原 crop_top + 原 crop_bottom`（比例 0–1） |
| 图片边框 | `set_line(pic, "FFFFFF", 4)` |
| 点击跳转网址 | `shape.click_action.hyperlink.address = "https://…"` |

## 图片

- **来源**：用户给的图片；用户文件中的图：docx 的图在 `Document(路径).part.rels` 中（`"image" in rel.reltype` 的 `rel.target_part.blob`），pptx 的图为图片形状的 `shape.image.blob`，PDF 的图用 pypdf：`for img in PdfReader(路径).pages[i].images: img.image.save(…)`；分析图用 matplotlib 画。取出的图存到临时目录，用 view_image 看过再用。
- **清晰度**：图片的像素宽度宜不低于显示宽度（磅）的 2 倍，整页宽（960 磅）的图约 2000 像素；太小的图不要放大铺满，改为小图配文字，或向用户要原图。像素宽高用 `PIL.Image.open(路径).size` 查看。
- **效果**：压暗用 `set_fill` 的半透明遮罩盖在照片上，半透明用 `a:alphaModFix`（上表），裁成圆形、圆角用 `add_picture` 的 `clip`；灰度、双色调、网点、模糊用 PIL 处理后另存到临时目录，再插入，见下方示例。
- **缺图时留图框**：按设计的比例留框并写明内容，交付时列出。图框是形状，拿到图后删去图框，用 `add_picture` 放在原位置。

```python
from pptx.enum.text import PP_ALIGN

def picture_slot(slide, left, top, width, height, note):
    """待补图片的图框：浅灰底、虚线边，中间写明要放什么图。"""
    slot = add_shape(slide, "rect", left, top, width, height, fill="F2F2F2", line="BFBFBF", line_width=0.75)
    set_line(slot, "BFBFBF", 0.75, dash="dash")
    slot.name = "图片待补"
    set_text(slot, f"图片待补：{note}")
    set_font(slot, size=12, color="7F7F7F")
    slot.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
    return slot

picture_slot(s, M, H * 0.2, W * 0.45, W * 0.45 * 2 / 3, "项目区位的航拍照片（横向 3:2）")
```

照片的灰度、双色调、网点、模糊：

```python
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps
from pptx.util import Pt

photo = Image.open(r"C:\work\效果图1.jpg").convert("RGB")
tmp = Path(tempfile.mkdtemp())
gray = ImageOps.autocontrast(ImageOps.grayscale(photo), cutoff=1)             # 高对比灰度
gray.save(tmp / "灰度.jpg")
ImageOps.colorize(gray, black="#1B2A52", white="#F5F0E6").save(tmp / "双色调.jpg")  # 暗部藏青、亮部米白
photo.filter(ImageFilter.GaussianBlur(photo.width / 100)).save(tmp / "模糊.jpg")


def halftone(image, cell=12, ink="#1A1A1A", paper="#F7F5EF"):
    """网点：每 cell 像素一个圆点，越暗的地方点越大。"""
    small = ImageOps.grayscale(image).resize((image.width // cell, image.height // cell))
    out = Image.new("RGB", (small.width * cell, small.height * cell), paper)
    draw = ImageDraw.Draw(out)
    for y in range(small.height):
        for x in range(small.width):
            r = cell * 0.72 * (1 - small.getpixel((x, y)) / 255) ** 0.5
            cx, cy = (x + 0.5) * cell, (y + 0.5) * cell
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ink)
    return out


halftone(photo).save(tmp / "网点.png")
for i, name in enumerate(["灰度.jpg", "双色调.jpg", "网点.png", "模糊.jpg"]):
    add_picture(s, str(tmp / name), M + i * (W - 2 * M) / 4, H * 0.3, (W - 2 * M) / 4 - Pt(8), H * 0.4)
```

## 图标

没有图标库。线描图标用 Windows 自带的图标字体 Segoe MDL2 Assets：一个字符就是一个图标，随字号缩放、按文字颜色着色，编码见下表。

```python
from pptx.util import Pt

ICON_FONT = "Segoe MDL2 Assets"


def add_icon(slide, code, left, top, size, color):
    """图标：code 为下表中的编码，图标占 (left, top) 起边长 size 磅的正方形。
    字体的行高为字号的 1.2 倍，文本框相应加高、上移，免得检查时报文字超框。"""
    box = add_text(slide, left, top - Pt(size * 0.1), Pt(size), Pt(size * 1.2), chr(code), size=size, color=color,
                   align="center", anchor="middle")
    set_font(box, latin=ICON_FONT, east_asia=ICON_FONT)
    return box


facts = [(0xE825, "建设单位", "市城投集团"), (0xE716, "设计团队", "建筑、结构、机电 42 人"),
         (0xE787, "设计周期", "2026.03—2026.12"), (0xE707, "项目地点", "滨江新区 B-07 地块")]
col = (W - 2 * M) / len(facts)
for i, (code, name, value) in enumerate(facts):
    x = M + i * col
    add_icon(s, code, x, H * 0.3, 28, ACCENT)
    add_text(s, x + Pt(40), H * 0.3 - Pt(2), col - Pt(48), Pt(16), name, size=12, color=BODY)
    add_text(s, x + Pt(40), H * 0.3 + Pt(16), col - Pt(48), Pt(20), value, size=15, bold=True, color=INK)

well = Pt(56)                                                   # 圆形底上的反白图标
add_shape(s, "ellipse", M, H * 0.55, well, well, fill=ACCENT)
add_icon(s, 0xE82F, M + (well - Pt(28)) / 2, H * 0.55 + (well - Pt(28)) / 2, 28, "FFFFFF")
```

| 类别 | 图标与编码 |
|---|---|
| 人与机构 | 人 E77B、多人 E716、机构 E825、教育 E7BE、公文包 E821、证书 EB95 |
| 场所与交通 | 住宅 E80F、地点 E707、地球 E909、网络 E774、汽车 E804、轨道交通 E7C0、飞机 E709、云 E753 |
| 文件与数据 | 文件 E8A5、报表 E9F9、面积图 E9D2、列表 E8FD、文件夹 E8B7、图层 E81E、网格 E80A、图片 EB9F、日历 E787 |
| 状态 | 对 E73E、错 E711、警告 E7BA、信息 E946、疑问 E9CE、星 E734、心 EB51、旗 E7C1、标签 E8EC、盾牌 EA18、锁 E72E |
| 事务 | 设置 E713、邮件 E715、电话 E717、搜索 E721、筛选 E71C、链接 E71B、计时 E916、时钟 E823、历史 E81C、循环 E72C、箭头 E72A、下载 E896、上传 E898、想法 E82F、能源 E945、集成 EA86、维修 E90F、监测 E9D9、速度 EC4A、温度 E9CA、太阳 E706、月亮 E708 |
| 设备 | 显示器 E7F4、笔记本 E7F8、相机 E722、计算器 E1D0、信号塔 EC05 |

- 同一套演示文稿的图标风格一致：同一页的图标同色、同大小；需要实心图标时改用 Segoe UI Symbol 和标准 Unicode 编码，如人 0x1F464、齿轮 0x2699、房屋 0x1F3E0、图表 0x1F4CA、警告 0x26A0，两种不混用。
- 不要用 Segoe Fluent Icons（只有 Windows 11 有）和彩色 emoji。

## 结构图

流程、层级、时间轴、矩阵等结构图用形状、线条和文字画，SmartArt 做不了。

- **先定网格再画**：节点数、节点宽、间距写成变量，位置由循环算出，节点多少变了只改数据。
- **少用卡片**：用编号、细线、圆点、留白和字号、字重的对比区分节点和层级，不要给每个节点都套一个带边框或底色的圆角矩形（slides_categories.md 的禁止项）；需要色块时只给要强调的那一个。
- **连线**：`add_line` 两点为直线，多点为直角折线；有方向的用 `arrows=(None, "triangle")`。线从节点边缘出发，不要穿过文字。
- 画完用 `check_slides` 检查文字是否超框、被线压住。

1 横向流程：大号编号和细线串起各步，每步一句说明。

```python
from pptx.util import Pt

steps = [("现状调研", "踏勘场地，整理规划条件和用户需求"), ("概念方案", "比选三种布局，确定总体策略"),
         ("方案深化", "推敲体量、立面和主要空间"), ("报批报建", "完成方案文本，提交规划审查")]
add_text(s, M, H * 0.1, W * 0.8, Pt(36), "方案阶段分四步推进，约 16 周", size=24, bold=True, color=INK)
gap = Pt(24)
step_w = (W - 2 * M - gap * (len(steps) - 1)) / len(steps)
top = H * 0.4
for i, (name, note) in enumerate(steps):
    x = M + i * (step_w + gap)
    add_text(s, x, top, step_w, Pt(48), f"{i + 1:02d}", size=40, color=ACCENT)
    add_line(s, (x, top + Pt(60)), (x + step_w, top + Pt(60)), color=ACCENT if i == 0 else GRAY, width=2)
    add_text(s, x, top + Pt(76), step_w, Pt(24), name, size=18, bold=True, color=INK)
    add_text(s, x, top + Pt(106), step_w, Pt(44), note, size=13, color=BODY)
```

2 层级图：上级居中，下级等分排开，用一组直角折线相连；只给顶层节点底色。

```python
from pptx.enum.text import PP_ALIGN
from pptx.util import Pt

root, children = "项目总负责人", ["建筑专业", "结构专业", "机电专业", "造价咨询"]
box_w, box_h = W * 0.16, Pt(40)
top, level_gap = H * 0.2, Pt(70)
root_x = (W - box_w) / 2
head = add_shape(s, "rect", root_x, top, box_w, box_h, fill=INK)
set_text(head, root)
set_font(head, size=15, bold=True, color="FFFFFF")
head.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER

child_top = top + box_h + level_gap
span = (W - 2 * M) / len(children)
mid_y = top + box_h + level_gap / 2
centers = [M + span * (i + 0.5) for i in range(len(children))]
add_line(s, (W / 2, top + box_h), (W / 2, mid_y), color=GRAY, width=1)
add_line(s, (centers[0], mid_y), (centers[-1], mid_y), color=GRAY, width=1)
for cx, name in zip(centers, children):
    add_line(s, (cx, mid_y), (cx, child_top), color=GRAY, width=1)
    add_text(s, cx - box_w / 2, child_top, box_w, box_h, name, size=15, bold=True, color=INK, align="center", anchor="middle")
    add_line(s, (cx - box_w / 2, child_top + box_h), (cx + box_w / 2, child_top + box_h), color=INK, width=1.5)
```

3 时间轴：一条横线，各节点为圆点，当前时间用虚线标出。

```python
from pptx.util import Pt

events = [("2026.03", "方案批复"), ("2026.09", "施工图完成"), ("2027.03", "主体结构封顶"), ("2027.12", "竣工验收")]
now = 1.5                                          # 当前位于第 2、3 个节点之间
axis_y, x0, x1 = H * 0.55, M, W - M
step = (x1 - x0) / (len(events) - 1)
add_line(s, (x0, axis_y), (x1, axis_y), color=GRAY, width=1.5)
dot = Pt(12)
for i, (date, name) in enumerate(events):
    x = x0 + i * step
    done = i <= now
    add_shape(s, "ellipse", x - dot / 2, axis_y - dot / 2, dot, dot, fill=ACCENT if done else "FFFFFF",
              line=ACCENT if done else GRAY, line_width=1.5)
    align = "left" if i == 0 else "right" if i == len(events) - 1 else "center"
    tx = x if align == "left" else x - step * 0.8 if align == "right" else x - step * 0.4
    add_text(s, tx, axis_y - Pt(52), step * 0.8, Pt(22), date, size=16, bold=True, color=INK, align=align)
    add_text(s, tx, axis_y + Pt(18), step * 0.8, Pt(20), name, size=13, color=BODY, align=align)
nx = x0 + now * step
add_line(s, (nx, axis_y - Pt(80)), (nx, axis_y + Pt(60)), color=ACCENT, width=1, dash="dash")
add_text(s, nx + Pt(4), axis_y - Pt(80), Pt(60), Pt(16), "今日", size=11, color=ACCENT)
```

其他结构：

| 结构 | 画法 |
|---|---|
| 2×2 矩阵 | 两条带箭头的轴线 `add_line(…, arrows=(None, "triangle"))` 十字相交，轴端写维度名，四个象限写标签；要突出的象限加浅底色 |
| 循环 | 节点沿圆周均布（角度 `2π·i/n`），相邻节点间用 `"arc"` 形状或带箭头的线相连 |
| 对比（两栏） | 中间一条竖线分隔，两侧同样的字号层级，差异用强调色标出 |
| 金字塔、漏斗 | `"triangle"`、`"trapezoid"` 按层堆叠，或逐层变宽、变窄的矩形 |
| 总分（一个结论带几条支撑） | 左侧结论，右侧几条要点，中间用一条折线或花括号 `"rightBrace"` 连接 |
