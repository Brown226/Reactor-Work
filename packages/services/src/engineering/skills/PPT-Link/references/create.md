# 新建演示文稿

## 规划

写代码前先列出页面清单，每页写明：读者看完要明白或决定什么、标题（写结论）、版式（图文、指标、图表、表格、章节页等）、用到的图片和数据。只读标题应能连成完整的叙述；页面之间有节奏，有的一眼看完，有的值得停下细读。场景和风格的具体要求见 slides_categories.md、场景文档和所选的 design.md。

## 把设计规范写成代码

设计系统和场景文档用文字给出规格，先把它们翻译成常量和函数，各页共用，风格才一致：

| 规格 | 写法 |
|---|---|
| 配色 | 每种用途一个常量，如 `INK, BODY, ACCENT = "002A12", "99AAA0", "1ECF77"`；强调色和图表系列色同时写进主题：`set_theme(f, colors=[强调色, 系列色…])`，图表默认按 accent1–6 取色 |
| 字体 | 照 design.md 写进主题（自主设计时从 fonts.md 中选）：`set_theme(f, heading=(西文, 中文), body=(西文, 中文))`，之后新建的文字默认用正文字体 |
| 字号 | 文档多以正文为 1x 给出倍数（如标题 2.3–2.6x、大数字 4–7x）：先定正文字号，再乘出各级，写成常量 |
| 版面网格 | 边距、分栏比例、标题位置写成 `W`、`H` 的比例，如 `M = W * 0.02`、标题上沿 `H * 0.2`、图文分栏 38:62 |
| 重复元素 | 页眉、页码、章节标记等写成函数，每页调用 |

`set_theme` 的颜色名和主题字体的用法见其说明：

**`set_theme(target, *, colors=None, heading=None, body=None)`** → None

- `target`：`f` 或 python-pptx 的 Presentation；各母版的主题都改。
- `colors`：`{名称: "RRGGBB"}`，名称为 `dk1`（深色文字）、`lt1`（浅色背景）、`dk2`、`lt2`、`accent1`–`accent6`（强调色，图表各系列依次取用）、`hlink`（超链接）、`folHlink`（访问过的超链接）；给 6 个颜色的列表时依次作为 accent1–accent6。
- `heading`、`body`：标题、正文的主题字体，一个字体名（中西文同用）或 `(西文, 中文)`。没有单独设字体的文字都用主题字体；`set_font` 中写 `"+mj-lt"`、`"+mj-ea"`（标题字体）或 `"+mn-lt"`、`"+mn-ea"`（正文字体）即引用主题字体。

## 写的顺序

1. `f = PptxFile.new(路径)`；用户给了只有版式、没有内容的模板时 `PptxFile.new(路径, template=模板)`。
2. `set_theme`，定义常量和重复元素的函数。
3. 逐页：`s = add_slide(f)`（空白版式），从下层到上层加元素：背景和色块，图片，线条，文字。文本框设好字号、行距后用 `fit_height` 定高，接在它下方的元素按 `框.top + 框.height` 定位。同一次调用多写几页。
4. `print(f.save())`，再按 SKILL.md 流程第 4、5 步检查、交付。

## 复刻

用 view_image 看原图，按 960 × 540 磅的页面估计每个元素的位置、尺寸和字号，写成常量后按上面的顺序还原；细节看不清时用 PIL 裁出局部放大再看。照片、头像、复杂插图用 PIL 从原图裁下来另存，再 `add_picture` 放到原位置；能用形状、线条画的就画出来，不要把整页截图当背景。

## 常见错误

| 错误 | 正确写法 |
|---|---|
| 用带占位符的版式排版 | 用空白版式 `add_slide(f)`，文字用 `add_text` 定位；占位符的格式来自母版，位置和字号不好控制。用模板时除外 |
| 用 `add_textbox`、`text_frame.text` 写字 | `add_text` 新建，`set_text` 改写 |
| 手打“•”“1.”做列表 | `set_list`，见 text.md |
| 手算框高 | 设好字号、行距后 `fit_height(框)` |
| 用空格、空行调位置和间距 | 直接给位置尺寸；段距用 `p.space_before`、`p.space_after` |
| 每块内容套一个圆角矩形卡片 | 用细线、留白、字号和字重的对比分层（slides_categories.md 的禁止项） |
| 改图片的宽高使其变形 | `add_picture` 给出框，`fit` 决定裁剪还是缩小 |
| 数字和单位一样大、单位另起一个文本框 | 同一段中另加一个 run，单位约为数字的 0.55–0.7 倍，见示例第 3 页 |
| 缺材料时编造数据、案例 | 写“【待补：内容】”，交付时列出 |

## 示例：方案汇报（设计系统 moon-white-imagery）

```python
import tempfile
from pathlib import Path

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Cm, Emu, Pt

from PKPMAgent.software_link_kit.ppt import *

PHOTO1, PHOTO2 = r"C:\work\效果图1.jpg", r"C:\work\效果图2.jpg"     # 用户提供的效果图

# 设计规格写成常量，各页共用
INK, BODY, ACCENT, NUMBER = "002A12", "99AAA0", "1ECF77", "474F58"   # 标题、说明文字、强调、大数字
PALE, WARM = "F2F4EF", "FDF8E0"                                       # 指标区的浅绿、暖白
SERIES = ["3D5D48", "7D9385", "A2B2A7", "B9C8BE"]                     # 图表系列
SANS = ("Segoe UI", "微软雅黑")                                        # 西文、中文字体

f = PptxFile.new(r"C:\work\滨江文化中心方案汇报.pptx")
set_theme(f, colors=[ACCENT, *SERIES, NUMBER], heading=SANS, body=SANS)
W, H = f.prs.slide_width, f.prs.slide_height                           # 960 × 540 磅
M, R = W * 0.02, W * 0.012                                             # 外边距 2%；照片圆角半径约 1.2% 页宽


def rounded(width, height):
    """圆角矩形的调整值：圆角半径 R ÷ 短边 × 100000。"""
    return [round(R / min(width, height) * 100000)]


def header(slide, section, number):
    """内容页页眉：左为文档名，约 15% 页宽处为本节名，右端为页码；不加横线。"""
    add_text(slide, M, H * 0.035, W * 0.12, Pt(14), "文化中心方案汇报", size=10, color=BODY)
    add_text(slide, W * 0.15, H * 0.035, W * 0.3, Pt(14), section, size=10, color=INK)
    add_text(slide, W - M - W * 0.1, H * 0.035, W * 0.1, Pt(14), f"{number:02d}", size=10, color=BODY, align="right")


# 1 封面：留 2% 白边的圆角整幅照片，底部由透明渐暗，标题在左下，序号在右下
s = add_slide(f)
box = (M, M, W - 2 * M, H - 2 * M)
add_picture(s, PHOTO1, *box, clip="roundRect", adjust=rounded(*box[2:]))
shade = add_shape(s, "roundRect", *box, adjust=rounded(*box[2:]))
set_fill(shade, [(0.45, "000000", 0), (1, "000000", 0.6)])            # 由透明到 60% 黑，压暗照片下部
add_text(s, M * 3, H * 0.66, W * 0.6, H * 0.14, "滨江文化中心建筑方案", size=40, color="FFFFFF", anchor="bottom")
add_text(s, M * 3, H * 0.81, W * 0.6, Pt(20), "方案设计阶段汇报｜2026 年 9 月", size=14, color="D6DDD9")
add_text(s, W - M * 3 - W * 0.1, H * 0.81, W * 0.1, Pt(20), "01", size=14, color="FFFFFF", align="right")

# 2 图文页：左 38% 为结论和说明，右 62% 为贴边照片
s = add_slide(f)
header(s, "总体布局", 2)
add_text(s, M, H * 0.2, W * 0.34, H * 0.2, "三个体量沿江错落，\v把滨水步道引入场地", size=28, color=INK)
body = add_text(s, M, H * 0.5, W * 0.32, H * 0.3,
                "剧场、展厅与图书馆分置三个体量，之间的缝隙对准江面视廊。\n"
                "首层架空 6 米，市民步道从城市一侧穿过场地直达江边。", size=14, color=BODY)
for p in body.text_frame.paragraphs:
    p.line_spacing, p.space_after = 1.4, Pt(8)
fit_height(body)
x = W * 0.4
add_picture(s, PHOTO2, x, M * 2.5, W - x, H - M * 5, clip="roundRect", adjust=rounded(W - x, H - M * 5))

# 3 结论与指标：上部为判断，下方一条指标带，三格用浅绿、暖白、深绿区分层级
s = add_slide(f)
header(s, "技术经济指标", 3)
add_text(s, M, H * 0.2, W * 0.5, H * 0.18, "容积率控制在 1.8，\v绿地率高于规划要求 5 个百分点", size=28, color=INK)
metrics = [("4.2", "万㎡", "总建筑面积", PALE, NUMBER), ("1.8", "", "容积率（规划上限 2.0）", WARM, NUMBER),
           ("40", "%", "绿地率（规划要求 35%）", INK, "FFFFFF")]
gap = Pt(12)
cell_w, top = (W - 2 * M - 2 * gap) / 3, H * 0.56
for i, (value, unit, label, fill, color) in enumerate(metrics):
    left = M + i * (cell_w + gap)
    add_shape(s, "rect", left, top, cell_w, H * 0.36, fill=fill)
    number = add_text(s, left + Pt(20), top + Pt(24), cell_w - Pt(40), Pt(64), value, size=54, color=color)
    run = number.text_frame.paragraphs[0].add_run()                  # 单位与数字同一段、同一基线，字号约 0.55 倍
    run.text = unit
    set_font(run, size=30, color=color)
    add_text(s, left + Pt(20), top + H * 0.36 - Pt(40), cell_w - Pt(40), Pt(20), label, size=12,
             color="D6DDD9" if fill == INK else NUMBER)

print(f.save())
target = PptSession(f.path)
with target.open() as pres:
    print(check_slides(pres))
    pages = render_slides(pres, tempfile.mkdtemp())
print(contact_sheet(pages, str(Path(pages[0]).with_name("总览.png")), columns=2))   # 用 view_image 查看
target.finish()
```
