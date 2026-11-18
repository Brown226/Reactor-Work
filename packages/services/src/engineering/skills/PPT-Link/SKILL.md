---
name: ppt-link
description: 创建、修改、美化和翻译 PowerPoint/WPS 演示文稿（.pptx、.ppt、.dps）。用户要做汇报、方案介绍、答辩、课件、宣传材料等幻灯片，要按模板或参考图做 PPT，要在已有演示文稿中改文字和数据、调整排版、美化页面、增删页面，或整篇翻译时，都使用本技能，即使用户没有提到 PPT。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# PowerPoint / WPS 演示文稿操作

代码在 python_executor 中执行。演示文稿的内容和格式直接改 pptx 文件（python-pptx + lxml），PowerPoint 与 WPS 打开的结果一致；接管用户打开着的文件、检查文字溢出、导出页面图，由 WPS/PowerPoint 在后台完成。版面设计依据 references 中的场景指南和设计系统，它们用英文写成，其中的尺寸、字体和做法都已按本技能写好，照做即可。

## 任务路由

| 任务 | 流程 | 先读 |
|---|---|---|
| 新建：给了主题、文档或逐页大纲 | 新建 | create.md、slides_categories.md 及对应的场景文档；用设计系统时再读 styles.md 和所选的 design.md |
| 用用户给的模板做 | 新建（用模板） | create.md、editing.md |
| 照图片、PDF 复刻，或仿照参考的风格 | 新建（复刻、仿照风格） | create.md |
| 改文字、数据，增删、调换页面 | 编辑 | editing.md、text.md |
| 美化某几页、统一版式和字体 | 编辑 | editing.md、slides_categories.md 的通用要求 |
| 形状、图标、结构图、图片、公式 | — | graphics.md |
| 表格、图表 | — | tables-charts.md |
| 整篇翻译 | 编辑，另存为新文件 | text.md 的“翻译” |
| 阅读、总结、提取内容 | 只读 | 不用读参考 |

- 参考文件用 `use_skill(skill="ppt-link", file="references/文件名")` 读取，如 `file="references/design_system/work/moon-white-imagery/design.md"`；写代码前读完相关的几篇。字体另见 fonts.md，形状名见 shapes.md。
- 用户给了模板或原文件时，在原文件或它的副本上改，不要读出内容再新建：新建的文件会丢掉原来的母版、版式、主题和配色。

## 核心概念

### 改文件与用应用

| | 改文件 | 用应用 |
|---|---|---|
| 工具 | python-pptx + lxml | WPS 演示/PowerPoint，在不显示窗口的后台实例中 |
| 对象 | `f = PptxFile(路径)`，`f.prs` 为 python-pptx 的 Presentation | `target = PptSession(路径)`；`with target.open() as pres:` 中的 `pres` 为应用的 Presentation 对象，与 VBA 的 `ActivePresentation` 相同，整个对象模型都能用 |
| 负责 | 内容和格式的修改：页面、文字、形状、图片、表格、图表、主题 | 接管和交还用户的文件，.ppt、.dps 转 .pptx，检查文字溢出和遮挡，导出页面图和 PDF；以及改文件做不到或很繁琐、而应用一两句就能做好的事 |

这样分工，是因为直接改文件时 PowerPoint 与 WPS 结果一致、速度快，保存前还能按规范校验、列出改动；而文字折成几行、实际占多高，要应用排版后才知道。用应用改时每读写一个属性都要跨进程，几毫秒一次，没有校验和改动对比，WPS 与 PowerPoint 的行为也可能不同，所以只在它明显更合适时才用，如放映方式这类改文件要手写大段 XML 的设置。

- 同一时刻只能有一方写文件：在 `with target.open()` 中文件被应用占用，`f.save()` 会失败，退出 with 后再保存。
- 检查和出图不改文件，之前读入的 `f` 可以接着改；用应用改过文件后（with 正常结束即保存），`f` 已过时，要重新 `f = PptxFile(target.path)`。这时用旧的 `f` 保存会报“读入后被改过”，不会覆盖应用做的修改。
- 后台实例没有窗口，`ActiveWindow`、`Selection`、`.Select()` 会报错，按 `pres.Slides(n).Shapes(k)` 取对象；常量写数值，如 `msoTrue` 为 -1。

### PptSession：接管目标演示文稿

用户常在 WPS/PowerPoint 中开着要改的演示文稿，这时文件被占用、写不进去，用户未保存的修改也只在应用里。所以 PptSession 在开始时把它保存并关闭，交给文件修改，结束时再打开给用户看；中间要用应用的操作都在后台实例中完成，不弹出窗口，也不碰用户开着的其他文件。

- `target = PptSession(path, *, save_as=None)`：`path` 为绝对路径。文件正打开着时先保存再关闭，有未保存的修改时先备份磁盘上的旧版本。.ppt、.dps 等转为同目录同名的 .pptx，之后改它，原文件不动。
- `save_as`：另存的 .pptx 绝对路径。给出时复制一份来改，原文件不动、保持打开；该路径已有文件时报错。
- `target.path`：要改的 .pptx 路径；`target.backup`：旧版本的备份路径，没有备份时为 None。
- `with target.open() as pres:`：在后台打开 `target.path`；with 正常结束时保存，出错时不保存，都会关闭。第一次打开时要启动后台实例，约需 10 秒；之后各次复用它，直到 `target.finish()`，所以检查、修改几轮后再 finish。
- `target.finish(*, show=True, slide=None)`：任务结束时调用。退出后台实例，打开成果文件给用户看：原来在用户的应用中开着的，在原应用中打开并回到用户当时所在的页（`slide` 给页码时跳到该页），否则用默认程序打开。`show=False` 时只重新打开接管时关闭的文件，用于批量处理和只读任务。
- `PptSession.bind(pres, *, save_as=None)`：接管在应用中取得的演示文稿对象，用于用户打开、从未保存过的演示文稿，此时须给 `save_as`。`get_office_app("PPT")` 连接用户正在用的 WPS/PowerPoint，失败时返回错误文字而不是报错；从它的 `Presentations` 中核对名称和内容找到 `pres`。

### PptxFile：编辑 pptx 文件

python-pptx 能读写演示文稿，但看不出每页有什么、在哪里，也不检查写出的 XML（元素顺序错或重复时 PowerPoint 会提示修复，WPS 可能显示异常）。PptxFile 在它外面加了带位置标签的全文视图、按标签或文字定位、保存前校验，以及与读入时的比对。

- `f = PptxFile(path)`：读入 .pptx，`f.prs` 为 python-pptx 的 Presentation。
- `PptxFile.new(path, *, template=None, overwrite=False)` → 新文件：`save()` 前不写盘；`path` 已存在时报错，免得覆盖用户的文件，从头重做本任务新建的文件时给 `overwrite=True`。省略 `template` 时为 16:9（33.867 × 19.05 厘米）的空白演示文稿，主题字体的中文为微软雅黑；`template` 为 .pptx 或 .potx 模板路径，新文件含模板的全部页面、母版和版式。
- `f.view(*, formats=False, slides=None)` → 文字：开头是页面尺寸、主题颜色和字体、用到的字体（本机没装的另列）、版式名称；之后逐页列出背景和各形状的类型、名称、位置尺寸、文字，表格网格，图表数据和备注。`formats=True` 同时列出填充、线条、段落和文字格式；页数多时用 `slides=(起, 止)` 分段看。
- `f.at(label)` → 标签对应的对象：页为 Slide，形状为 python-pptx 的形状，“(r,c)”为单元格，“¶n”为段落，“页N/备注”为备注的文本框架。
- `f.find(text, *, exact=False)` → `[(标签, 段落)]`：含 `text` 的段落，比较时不计空格和换行；`exact=True` 要求整段相等；没有时为空列表。标签带“¶n”时为第 n 段，去掉它即所在的形状或单元格：`f.at(标签.split("¶")[0])`。
- `f.walk()` → 全部形状 `(标签, 形状)`；`f.paragraph_items()` → 全部段落 `[(标签, 段落)]`，含表格和备注中的。
- `f.save(path=None)` → 摘要文字：整理元素顺序、按规范校验后写盘，`path` 省略时覆盖读入的文件。
- `f.diff(*, max_lines=60)` → 与读入时相比的变化：文字是否守恒，以及格式视图的逐行差异；修改途中可随时打印。
- `f.translate(mapping, *, font=None)`：整篇翻译，见 text.md。

### 位置标签

| 标签 | 位置 |
|---|---|
| 页N | 第 N 页 |
| 页N/K | 第 N 页的第 K 个形状，按叠放次序，最底层为 1 |
| 页N/K/J | 组合 页N/K 中的第 J 个形状 |
| 页N/K(r,c) | 表格第 r 行第 c 列的单元格，从 1 开始 |
| 页N/备注 | 该页的备注 |
| 标签¶n | 有多段文字时的第 n 段 |

插入、删除页面或形状后，其后的标签会变：先把要改的对象都取好再改，或从后往前改。

### 尺寸、单位与颜色

- 16:9 的页面为 960 × 540 磅，参考文档中的尺寸都按它给出：磅值写成 `Pt(数值)`，按比例给的写成 `W * 0.02`，其中 `W, H = f.prs.slide_width, f.prs.slide_height`。
- 位置和尺寸用 python-pptx 的 `Cm()`、`Pt()`、`Emu()`，或由它们算出的数值；本技能的函数遇到 2.5 这类很小的纯数字会报错，以免把厘米误当成长度单位 EMU（1 厘米 = 360000 EMU）。
- `W * 0.3` 这类算出的小数可以直接传给本技能的函数；赋给 python-pptx 的属性（`shape.left`、`shape.width`、`t.columns[0].width` 等）时要取整，如 `shape.width = int(W * 0.3)`，否则报“must be an integral type”。
- 字号、线宽为磅；颜色为 `"RRGGBB"`。python-pptx 自己的颜色属性要写 `RGBColor.from_string("1F4E79")`。

### 辅助函数

`from PKPMAgent.software_link_kit.ppt import *` 只导入下列函数和类，python-pptx 的单位和枚举要另外导入：常用的见“流程”开头，图表等其他枚举用到时导入。

python-pptx 能直接做的就用它；它没有的属性用 `get_or_add` 改 XML；下表的函数处理手写容易出错或 python-pptx 做不到的操作，参数、返回值和示例见对应的参考文件。

| 类别 | 函数 | 参考 |
|---|---|---|
| 页面与主题 | `add_slide` 新建页；`duplicate_slide` 复制页；`delete_slide` 删除页；`move_slide` 移动页；`set_theme` 设主题颜色和字体 | editing.md、create.md |
| 文字 | `add_text` 新建文本框；`fit_height` 按文字定框高；`set_text` 改写文字并保留格式；`replace_text` 替换文字；`set_font` 设中西文字体、字号、颜色、字距；`set_list` 设项目符号或编号 | text.md |
| 形状与图片 | `add_shape` 按名称新建形状；`add_line` 画直线、折线；`set_fill` 设纯色、渐变、半透明填充；`set_line` 设线条、虚线、箭头；`add_picture` 插入图片；`replace_picture` 换图；`add_formula` 插入公式 | graphics.md |
| 表格与图表 | `insert_table` 新建表格；`set_borders`、`set_row_border`、`set_col_border` 设框线；`set_three_line` 设三线表；`set_series_type` 把部分系列改为折线等，做组合图 | tables-charts.md |
| 应用 | `check_slides` 检查溢出和遮挡；`render_slides` 导出页面图；`contact_sheet` 拼总览图 | 本文“检查与交付” |

**`get_or_add(parent, path, **attrs)`** → 路径末端的 XML 元素

- `parent`：形状、段落、run、单元格，或 XML 元素。
- `path`：如 `"a:pPr/a:lnSpc/a:spcPct"`；已有的元素直接取，缺的逐级按规范位置新建。
- `attrs`：要设的属性，值为 None 时删除该属性。

```python
get_or_add(pic._element.blipFill, "a:blip/a:alphaModFix", amt=60000)   # 图片不透明度 60%
get_or_add(shape.text_frame._txBody, "a:bodyPr", vert="eaVert")         # 文字竖排
```

python-pptx 对象的 XML 元素：形状 `shape._element`、段落 `p._p`、run `r._r`、单元格 `c._tc`、表格 `t._tbl`、文本框架 `frame._txBody`，都支持带 `a:`、`p:` 前缀的 `xpath()`。

## 流程

第一段代码先写好导入，之后各段不必重复：每步可以分开执行，导入的名字和 `target`、`f` 等变量在后续调用中保留。

```python
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Cm, Emu, Pt

from PKPMAgent.software_link_kit.ppt import *
```

代码中途报错时，报错前的改动已在 `f` 中（只在内存里，`save()` 前不写盘），不要在半截的结果上接着补：新建时 `delete_slide(f, s)` 删掉出错的那页再重跑这一页，或从 `PptxFile.new` 整段重跑（已保存过时加 `overwrite=True`）；改已有文件时 `f = PptxFile(target.path)` 重新读入，丢掉上次保存后的改动再重做。

### 1. 读懂材料

读完用户提供的全部材料：上传的文件、提到的网址和对话中的要求。Word、PDF、Excel 中的内容和图片都可能用上。

### 2. 明确需求

依次确定：

1. **请求类型**：新建（从零开始或用模板）、编辑（局部修改、单页美化等）、复刻（把图片、PDF 做成 pptx）。
2. **设计方法**：自主设计（没有要求或只有简单的风格要求）、设计系统（用户点名了 styles.md 中的风格，或给了完整的配色、字体、版式规范）、用模板（给了必须使用的模板）、仿照风格（给了图片、网页等风格参考）。
3. **输入类型**：只有主题；完整文档（论文、报告、新闻稿等）；逐页大纲或讲稿。只有大纲或讲稿时，内容往往撑不起整套演示文稿，用户没说不许扩展时补充相关的背景和案例，事实和数据要有来源。
4. **页数**：用户定了就按用户的；给了逐页大纲、讲稿时与它一致；给了完整文档时，向用户确认每页承载多少内容，并给出估计的总页数；只有主题时建议一个页数，请用户确认。

以下情况先问用户，不要自己猜：要求含糊，文件或网址打不开；要求互相矛盾，如选了设计系统又要求相反的风格，或“做 10 页”又要“30 页以上的内容”；用途、设计方向、页数自己定不下来。

### 3. 制作

按设计方法：

- **自主设计**：读 slides_categories.md，判断场景，再读该场景的文档，据此设计。
- **设计系统**：读 slides_categories.md 的通用要求和场景文档作为基础，再读所选的 design.md 作为风格，只用这一种风格，不混入别的。
- **用模板**：见 editing.md 的“用模板做”。
- **仿照风格**：先分析参考的配色、字体、元素特点、版式、内容密度和可复用的组件（插图、形状、结构图、正文版式），以及元素的处理方式（留白、细线还是色块分隔，直角还是圆角），据此设计；可以沿用参考中的插图、字体和字号层级。
- **复刻**：看图估计各元素的位置、字体和字号，尽量一比一还原，看不清的部分放大局部看。能用形状画的用形状画；照片、头像等画不出来的，从原图裁下来作为图片插入。

新建、复刻的写法见 create.md，编辑见 editing.md。

**图片**：图片让页面有说服力。除封面、章节页外，内容页也要用图来说明、举证或交代场景；涉及产品、人物、地点、建筑、事件、案例、界面、实验对象或空间环境时，优先用对应的真实照片或截图。本环境不能生成图片。图片来自用户提供的图片、用户文件（Word、PDF、原演示文稿）中的图、能画出来的图（matplotlib 画的分析图、形状画的示意图）；开了联网搜索时（系统提示里有「联网搜索」一节），公开的地点、建筑、产品、事件等也可以按那一节的方法在网上找图。所选风格依赖大量照片而用户没给时，先向用户要（效果图、现场照片等），或换一种不依赖照片的风格；实在缺的，留出按比例的图框并写明“图片待补：内容”，交付时列出。先确定要用哪些图，再按图片比例设计版面；不为凑数放无关的图。

**文字**：说具体的事，标题直接写结论，如“容积率控制在 1.8，绿地率高于要求 5 个百分点”，而不是“技术经济指标分析”。少用比喻、口号和空泛的词（赋能、抓手、闭环、打通、底层逻辑、一图看懂），也不用“不是……而是……”“……的本质是……”“核心洞察”“N 大战场”这类套话，读者要的是能核对的信息。不编造数据、引文、案例和来源；缺的材料写成“【待补：内容】”，交付时列出。外部事实和数据注明来源、时间和口径。

### 4. 检查

1. `print(f.save())`，按下文核对摘要。
2. 在一次 `with target.open() as pres:` 中 `print(check_slides(pres))`，用 `render_slides` 导出页面图，`contact_sheet` 拼成总览图，用 view_image 查看；拿不准的页再看单页。新建时先用 `target = PptSession(路径)` 接管刚保存的文件。
3. 按结果修改后重复 1、2，直到没有问题；复查时只查、只导出改过的页，如 `check_slides(pres, [3, 5])`、`render_slides(pres, 目录, [3, 5])`，页数多时全篇检查要几秒到十几秒。`check_slides` 按应用的实际排版计算，报文字超框就是真超了；出血的图片、有意的叠放按设计判断。

### 5. 交付

`target.finish()`，成果文件随即打开给用户看；按“交付清单”汇报。

### 只读：阅读、提取

`f = PptxFile(路径)` 直接读，用 `f.view()`，不接管、不保存。文件在应用中开着时也能读，读到的是磁盘上已保存的内容；用户说刚改过还没保存时，请用户先保存。要看页面效果时才接管，最后 `target.finish(show=False)`。

## 通用规则

| 事项 | 规则 |
|---|---|
| 改文字 | `shape.text = …`、`text_frame.text = …` 会清掉字体、颜色等格式；改已有文字用 `set_text`、`replace_text` |
| 新建文本框、形状、表格 | 用 `add_text`、`add_shape`、`insert_table`：python-pptx 新建的文本框不换行、随文字撑大，形状和表格带主题样式（蓝色填充、阴影、深色表头） |
| 字体 | python-pptx 的 `font.name` 只设西文字体，中文用 `set_font(…, east_asia=…)`。只用 fonts.md 中 Windows 自带的字体，名称完全一致；电脑上没有的字体会被换掉，西文甚至显示成乱码 |
| 占位符 | 用不上的占位符删去，否则编辑时显示“单击此处添加…”：`el = shape._element; el.getparent().remove(el)` |
| 叠放 | 后加的在上层，背景和色块先加；移到最底层：`tree = slide.shapes._spTree; tree.remove(el); tree.insert(2, el)` |
| 手写 XML | 改已有设置用 `get_or_add`，它取已有元素而不新建；`save()` 会按规范排列子元素并校验 |
| 动画、备注 | 不加动画，用户要求时告诉用户在 PowerPoint/WPS 中添加；备注只在用户要求时加（text.md） |
| 页面 | 新建页用 `add_slide`：python-pptx 的 `slides.add_slide` 按页数给新页取部件名，删过页后与留下的页重名，保存时其中一页丢失。删页用 `delete_slide`，复制页用 `duplicate_slide`：只动页面列表会留下失效的关系，PowerPoint 打开时提示修复 |

## 检查与交付

### save() 的摘要

`f.save()` 先按 XSD 校验（原文件已有的问题不计），通过后写盘，返回保存路径和与读入时相比的变化：文字增删了多少字、视图有哪些行变了。逐条核对：计划外的变化是误改，计划内的没出现说明没改上；视图开头的字体行出现“未安装”时，按 fonts.md 换成 Windows 自带的字体。出错时：

- 报“校验发现新问题”：没有写盘。每条列出部件、位置标签和问题，改正后重新保存。
- 报“读入后被改过”：文件读入后被应用改过；重新 `f = PptxFile(target.path)`，再做未完成的修改。
- 报“无法写入”：文件又在 WPS/PowerPoint 中打开了，或仍在 `with target.open()` 中；改动还在内存里，关闭后重新 `f.save()`。

### 应用中的检查

以下函数的 `pres` 都是 `with target.open() as pres:` 中的演示文稿：

- `check_slides(pres, slides=None)` → 问题清单文字：每行为“标签 “形状名” 问题”，检查文字超出文本框（给出多出的磅数）、形状或文字超出页面、文字被上层的图片、色块、线条压住或与其他文字重叠、空占位符。`slides` 为页码列表，省略时查全部。
- `render_slides(pres, out_dir, slides=None, *, width=1600)` → PNG 路径列表：`out_dir` 为输出目录的绝对路径，用临时目录（如 `tempfile.mkdtemp()`），不要放进用户的文件夹；`width` 为图宽像素。
- `contact_sheet(paths, out_path, *, columns=4, width=360)` → 图片路径：把多页图拼成一张总览图。
- 导出 PDF：`pres.SaveAs(PDF 绝对路径, 32)`。

看图时检查：文字是否超框、被遮挡；同类元素是否对齐（左边线、顶端、间距）；配色、字体是否符合所选风格；图片是否变形、模糊；有没有大片空白或拥挤的页面。

### 交付清单

- 成果在要求的位置，新建文件按内容命名（不用“output.pptx”“新建演示文稿”这类名称）；`save()` 无新增问题，视图的字体行没有“未安装”。
- `check_slides` 没有问题，或逐条确认是有意的设计；看过全部页面的总览图。
- 没有空占位符和占位文字；待补的内容、图片逐项列出；数据和事实都有来源，没有编造。
- 已 `target.finish()`；接管前用户有未保存的修改时，旧版本在 `target.backup`，交付时告知。
- 拿不准的地方（模板说明与实际不符、材料缺失等）先做有把握的部分，交付时说明按什么理解处理、哪些没动。
