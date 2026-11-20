---
name: word-link
description: 创建、修改、排版、翻译和审阅 Word/WPS 文档（.docx、.doc、.wps）。用户要写报告、计算书、说明书、方案并保存为 Word，要在已有文档中改文字、填写工程数据、调整格式（字体、段落、页面、页眉页脚、页码、目录、表格、公式、图片），要整篇翻译，或添加批注、修订时，都使用本技能，即使用户没有提到 Word。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# Word / WPS 文档操作

代码在 python_executor 中执行。文档的内容和格式直接改 docx 文件（python-docx + lxml），Word 与 WPS 打开的结果一致；接管用户打开着的文档、更新目录和页码、导出页面图、修订这几件事，由 WPS/Word 在后台完成。

## 任务路由

| 任务 | 流程 | 先读 |
|---|---|---|
| 新建报告、计算书、说明书等 | 新建 | create.md，再按内容读下列专题 |
| 改文字、数据；按模板填写 | 编辑 | text.md；填表格再读 tables.md |
| 统一字体、段落、标题格式 | 编辑 | text.md |
| 纸张、方向、分节、页眉页脚、页码 | 编辑 | layout.md |
| 表格：新建、增删行列、合并、框线、三线表、列宽 | 编辑 | tables.md |
| 目录、题注、交叉引用、脚注、超链接 | 编辑 | fields.md |
| 公式 | 编辑 | math.md |
| 图片：插入、替换、改大小 | 编辑 | images.md |
| 批注、修订 | 编辑 | review.md |
| 整篇翻译 | 编辑，另存为新文件 | text.md 的“翻译” |
| 阅读、总结、提取内容、检查格式 | 只读 | 不用读参考 |

- 参考文件用 `use_skill(skill="word-link", file="references/文件名")` 读取，写代码前读完相关的几篇；create.md 只在新建时读。
- 用户给了模板或原文件时，在原文件或它的另存副本上改，不要读出内容再新建一份：新建的文件会丢掉原来的样式、编号、页眉页脚和页面设置。

## 核心概念

### 改文件与用应用

| | 改文件 | 用应用 |
|---|---|---|
| 工具 | python-docx + lxml | WPS/Word，在不显示窗口的后台实例中 |
| 对象 | `f = DocxFile(路径)`，`f.doc` 为 python-docx 的 Document | `target = WordSession(路径)`；`with target.open() as doc:` 中的 `doc` 为应用的 Document 对象，与 VBA 的 `ActiveDocument` 相同，整个对象模型都能用 |
| 负责 | 内容和格式的修改：文字、样式、段落、表格、分节、页眉页脚、域代码、公式、图片 | 接管和交还用户的文档，.doc 转 .docx，更新域（目录页码、题注编号、交叉引用），导出页面图和 PDF，修订；以及改文件做不到或很繁琐、而应用一两句就能做好的事 |

这样分工，是因为直接改文件时 Word 与 WPS 结果一致、速度快，保存前还能按规范校验、列出改动；而页码、分页和域的结果要由应用排版后才知道，修订标记也只能由应用记录。用应用改时每读写一个属性都要跨进程，几毫秒一次，没有校验和改动对比，WPS 与 Word 的行为也可能不同，所以只在它明显更合适时才用。

两者交替使用时：

- 同一时刻只能有一方写文件：在 `with target.open()` 中文件被应用占用，`f.save()` 会失败，退出 with 后再保存。
- 应用改过文件后（with 正常结束即保存，如更新域、修订），之前读入的 `f` 已过时，要重新 `f = DocxFile(target.path)`；这时用旧的 `f` 保存会报“读入后被改过”，不会覆盖应用做的修改。
- 常量写数值，如 `msoTrue` 为 -1。
- 在同一次 `target.open()` 中更新域后接着出图，WPS 的页面图常缺页眉页脚，所以更新域和出图分两次打开。

### WordSession：接管目标文档

用户常在 WPS/Word 中开着要改的文档，这时文件被占用、写不进去；用户未保存的修改也只在应用里，直接改文件会和它互相覆盖。所以 WordSession 在开始时把文档保存并关闭，交给文件修改，结束时再打开给用户看；中间要用应用的操作都在后台实例中完成，不弹出窗口，也不碰用户开着的其他文档。

- `target = WordSession(path, *, save_as=None)`：`path` 为绝对路径。文档正打开着时先保存再关闭，有未保存的修改时先备份磁盘上的旧版本。.doc、.wps 等转为同目录同名的 .docx，之后改它，原文件不动。
- `save_as`：另存的 .docx 绝对路径。给出时复制一份来改，原文档不动、保持打开；该路径已有文件时报错。
- `target.path`：要改的 .docx 路径；`target.backup`：旧版本的备份路径，没有备份时为 None。
- `with target.open() as doc:`：在后台打开 `target.path`；with 正常结束时保存，出错时不保存，都会关闭。第一次打开时要启动后台实例，约需 10 秒；之后各次复用它，直到 `target.finish()`，所以检查、修改几轮后再 finish。
- `target.finish(*, show=True)`：任务结束时调用。退出后台实例，打开成果文件给用户看：原来在用户的应用中开着的，在原应用中打开，否则用默认程序打开。`show=False` 时只重新打开接管时关闭的文档，用于批量处理多份文档和只读任务。
- `WordSession.bind(doc, *, save_as=None)`：接管在应用中取得的文档对象，用于用户打开、从未保存过的文档，此时须给 `save_as`。`get_office_app("Word")` 连接用户正在用的 WPS/Word，失败时返回错误文字而不是报错；从它的 `Documents` 中核对名称和内容找到 `doc`。

### DocxFile：编辑 docx 文件

python-docx 能读写文档，但不会告诉你文档里有什么、在哪里，也不检查写出的 XML 是否合规（元素顺序错或重复时，Word 可能打不开，WPS 可能显示异常）。DocxFile 在它外面加了带位置标签的全文视图、按标签或文字定位、保存前校验，以及与读入时的比对。

- `f = DocxFile(path)`：读入 .docx，`f.doc` 为 python-docx 的 Document。
- `DocxFile.new(path, *, template=None, overwrite=False)` → 新文件：`save()` 前不写盘；`path` 已存在时报错，免得覆盖用户的文件，从头重做本任务新建的文件时给 `overwrite=True`；`template` 为 .docx 或 .dotx 模板路径，新文件从模板复制，含模板中的全部内容。
- `f.view(*, formats=False, blocks=None)` → 文字：正文、表格网格、页眉页脚、脚注、批注、文本框，每项前是位置标签，开头说明所用记号。`formats=True` 同时列出样式和格式；长文档用 `blocks=(起, 止)` 分段看正文块。
- `f.at(label)` → 表格标签（如“表1”）得到 Table，“表1(2,3)”得到该坐标所在的单元格，其余得到 Paragraph。
- `f.find(text, *, exact=False)` → `[(标签, 段落)]`：含 `text` 的段落，比较时不计空格和换行；`exact=True` 要求整段相等；没有时为空列表；`f.find("#段落ID")` 按 view 中的段落 ID 查。
- `f.paragraph_items()` → 全部段落 `[(标签, 段落)]`，含表格、文本框、页眉页脚、脚注、批注中的；`f.tables()` → 正文顶层表格，按“表K”的顺序；`f.walk()` → 按阅读顺序给出 `(标签, XML 元素, 部件)`，元素为段落或表格。
- `f.save(path=None)` → 摘要文字：整理元素顺序、按规范校验后写盘，`path` 省略时覆盖读入的文件。
- `f.diff(*, max_lines=60)` → 与读入时相比的变化：文字是否守恒，以及格式视图的逐行差异；修改途中可随时打印。
- `f.translate(mapping, *, font=None)`：整篇翻译，见 text.md。

### 位置标签

view 中每个段落、表格前的标签，`f.at` 和 `f.find` 都用它：

| 标签 | 位置 |
|---|---|
| 正文N | 正文第 N 块，段落和表格一起计数 |
| 表K、表K(r,c) | 正文第 K 张表；该表网格第 r 行第 c 列所在的单元格，行列从 1 开始 |
| 页眉N、页脚N、脚注N、尾注N、批注N | 对应部分 |
| 标签¶n | 该处有多段时的第 n 段 |
| 标签/文本框N、标签/表J | 段落中的文本框、单元格中的嵌套表 |

### 辅助函数

`from PKPMAgent.software_link_kit.office import *` 只导入下列函数和类；python-docx 的单位和枚举（`Pt`、`Cm`、`WD_ALIGN_PARAGRAPH` 等）不在其中，用到时从 docx 导入。参数中的段落、run、表格、单元格、节都是 python-docx 对象，用 `f.at`、`f.find` 或 python-docx 取得。

python-docx 能直接做的就用它；它没有的属性用 `get_or_add` 改 XML；下表的函数处理手写容易出错或 python-docx 做不到的操作，参数、返回值和示例见对应的参考文件。

| 类别 | 函数 | 参考 |
|---|---|---|
| 文字与格式 | `set_text` 整段改写；`replace_text` 替换文字；`insert_paragraph` 插入段落；`isolate` 把一段文字拆成单独的 run；`set_font` 设中西文字体、字号；`heading_style` 取标题样式；`set_list` 设为列表；`use_chinese_defaults` 设常用中文格式 | text.md |
| 页面 | `split_section` 分节；`landscape_pages` 让部分页面横向；`add_page_number` 加页码 | layout.md |
| 表格 | `insert_table` 新建；`table_cells`、`table_grid` 按网格坐标取单元格；`insert_rows`、`delete_rows`、`insert_columns`、`delete_columns` 增删行列；`merge_cells`、`split_cell` 合并拆分；`set_borders`、`set_row_border`、`set_col_border`、`set_three_line` 设框线；`set_fill` 设底纹；`fit_columns`、`set_column_widths` 设列宽；`set_header_rows`、`keep_together` 控制跨页 | tables.md |
| 域与引用 | `insert_toc` 目录；`add_caption` 题注；`add_field` 域；`add_bookmark` 书签；`add_hyperlink` 超链接；`add_footnote` 脚注 | fields.md |
| 公式 | `add_equation` 把 LaTeX 转为 Word 公式 | math.md |
| 图片 | `pictures` 列出图片；`replace_picture` 替换图片 | images.md |
| 批注与修订 | 批注用 python-docx 的 `add_comment`，修订在应用中做 | review.md |
| 应用 | `refresh_fields` 更新域；`find_pages` 查文字所在页；`render_pages` 导出页面图；`contact_sheet` 拼总览图 | 本文“校验与交付” |

**`get_or_add(parent, path, **attrs)`** → 路径末端的 XML 元素

- `parent`：段落、run、单元格、表格、节、样式，或 XML 元素。
- `path`：如 `"w:pPr/w:ind"`；已有的元素直接取，缺的逐级按规范位置新建。
- `attrs`：要设的属性，键不带前缀时为 `w:` 属性，值为 None 时删除该属性。

```python
get_or_add(p, "w:pPr/w:ind", firstLineChars=200, firstLine=None)   # 首行缩进 2 字
get_or_add(r, "w:rPr/w:em", val="dot")                              # 着重号
```

python-docx 对象的 XML 元素：段落 `p._p`、run `r._r`、单元格 `c._tc`、表格 `t._tbl`、节 `s._sectPr`、样式 `st.element`，都支持带 `w:` 前缀的 `xpath()`。

## 流程

第一段代码先导入本技能的函数：`from PKPMAgent.software_link_kit.office import *`。每步可以分开执行，导入的函数和 `target`、`f` 等变量在后续调用中保留。

### 编辑已有文档

1. **接管**：`target = WordSession(路径)`；要保留原件时加 `save_as=新路径`。
2. **读懂**：`f = DocxFile(target.path)`，`print(f.view())`；格式类任务用 `f.view(formats=True)`。据此列出要改的位置和改法。
3. **修改**：用 `f.at`、`f.find` 取对象，按参考文件的写法修改。插入或删除段落、表格后，其后的标签会变：先把要改的对象都取好再改，或从后往前改。
4. **保存**：`print(f.save())`，按“校验与交付”核对摘要。
5. **看效果**：文档有目录、题注、页码或交叉引用时，先在一次 `with target.open() as doc:` 中 `refresh_fields(doc)`；再另开一次，用 `render_pages(doc, 输出目录, find_pages(doc, "改动处的文字"))` 导出改动所在的页，用 view_image 查看。有问题时重新读入（回到第 2 步）修改。
6. **交付**：`target.finish()`，成果文件随即打开给用户看；按“交付清单”汇报。

### 新建文档

1. **规划**：读 create.md，按文档类型定好结构和各部分内容。
2. **建文件**：`f = DocxFile.new(路径)`，中文文档接着 `body = use_chinese_defaults(f)`；用户给了只含样式、没有内容的模板时，用 `DocxFile.new(路径, template=模板路径)`。
3. **写内容**：按 create.md 的顺序写。
4. **保存**：`print(f.save())`。
5. **看效果**：`target = WordSession(路径)`，在一次 `target.open()` 中 `refresh_fields(doc)`；另开一次用 `render_pages` 导出全部页面，用 `contact_sheet` 拼成总览图查看，有问题的页再看单页。
6. **交付**：`target.finish()`。

### 只读：阅读、提取、检查

- `f = DocxFile(路径)` 直接读，用 `f.view()` 或 `f.view(formats=True)`，不接管、不保存。文档在 WPS/Word 中开着时也能读，读到的是磁盘上已保存的内容；用户说刚改过还没保存时，请用户先保存。
- 要看页面效果时才接管：`target = WordSession(路径)`，在 `target.open()` 中出图，最后 `target.finish(show=False)`。

## 通用规则

| 事项 | 规则 |
|---|---|
| 改文字 | `p.text = …`、`cell.text = …` 会清空整段再写，段内图片、域、脚注引用、书签和格式全部丢失；已有的文字用 `set_text`、`replace_text` 改 |
| 删除 | 单元格至少留一个段落；两张表之间的段落删掉后两表会连成一张；带 `w:sectPr` 的段落是分节符，删掉后两节合并 |
| 域和编号 | 目录、题注编号、页码、交叉引用的显示结果由应用计算，直接改结果文字会在更新域时被覆盖；改域代码或来源（标题、书签），再 `refresh_fields`。“第1章”“1.2”这类自动编号不在段落文字中，改编号定义或样式 |
| 字体 | python-docx 的 `font.name` 只设西文字体，中文字体用 `set_font(…, east_asia=…)` 设 |
| 单位 | python-docx 用 `Pt()`、`Cm()`、`Mm()`；XML 中长度多为缇（1 磅 = 20 缇），字号 `w:sz` 为半磅，框线 `w:sz` 为 1/8 磅，`…Chars` 为 1/100 字 |
| 手写 XML | 改已有设置用 `get_or_add`，它取已有元素而不新建；只有规范允许重复的元素（如制表位 `w:tab`、不等宽分栏的 `w:col`）才用 python-docx 的 `OxmlElement` 新建后加入。`save()` 会按规范排列子元素，但不合并重复的元素，重复时报“重复”。首尾有空格的 `w:t` 要加 `xml:space="preserve"`；lxml 元素没有子元素时布尔值为假，判断用 `is None` |
| 只改格式 | 排版类任务不改任何文字（含空格、标点、全半角），`save()` 摘要第一行应为“文字：未变” |

## 校验与交付

### save() 的摘要

`f.save()` 先按 XSD 校验（原文件已有的问题不计），通过后写盘，返回保存路径和与读入时相比的变化：文字增删了多少字、格式视图有哪些行变了。逐条核对：计划外的变化是误改，计划内的没出现说明没改上。出错时：

- 报“校验发现新问题”：没有写盘。每条列出部件、位置标签和问题，改正后重新保存。
- 报“读入后被改过”：文件读入后在 `target.open()` 中被改过；重新 `f = DocxFile(target.path)`，再做未完成的修改。
- 报“无法写入”：文件又在 WPS/Word 中打开了，或仍在 `with target.open()` 中；改动还在内存里，关闭后重新 `f.save()`。

### 应用中的检查

以下函数的 `doc` 都是 `with target.open() as doc:` 中的文档：

- `refresh_fields(doc)` → `(目录数, 域数)`：更新目录和全部域，含页眉页脚、脚注中的。
- `find_pages(doc, text)` → 页码列表：正文中 `text`（不超过 255 字）各处所在的页，从 1 开始；找不到时报错，页眉页脚和文本框中的文字不在查找范围内。
- `render_pages(doc, out_dir, pages=None, *, dpi=200)` → PNG 路径列表：`out_dir` 为输出目录的绝对路径，用临时目录（如 `tempfile.mkdtemp()`），不要放进用户的文件夹；`pages` 为页码列表，省略时导出全部页。页面图用于检查版面，dpi 调低时字距会失真、出现假的断词，文字以 view 为准。
- `contact_sheet(paths, out_path, *, columns=4, width=360)` → 图片路径：把多页图拼成一张总览图。
- 导出 PDF：`doc.ExportAsFixedFormat(PDF 绝对路径, 17)`。

看图时检查：表格线与合并、文字是否被裁切、跨页的表头与题注、空白页、页眉页脚与页码、目录页码。

### 交付清单

- 成果在要求的位置，新建文件按内容命名（不用“output.docx”“新建文档”这类名称）；`save()` 无新增问题，变化与计划一致。
- 域已更新，目录、编号、页码不是占位文字；新建文档中除了交付时列出的待补项，没有占位文字。
- 看过受影响页面的图片；新建文档看过全部页面的总览图。
- 翻译后 `remaining` 为空，或逐条说明了原因；修订任务中每处改动都显示在 view 的 `{增}`、`{删}` 中。
- 已 `target.finish()`；接管前用户有未保存的修改时，旧版本在 `target.backup`，交付时告知。
- 拿不准的地方（手写编号与自动编号混用、模板说明与实际格式不符等）先做有把握的部分，交付时说明发现的问题、按什么理解处理、哪些没动。
