---
name: pdf-link
description: 处理 PDF 文件的核心 Python 工具集。任何涉及 PDF 的任务都应当主动调用此 skill —— 包括读取/抽取 PDF 文本与表格、合并/拆分/旋转/截取页、添加水印、加密解密、提取图像、从零生成新 PDF（如计算结果报告、汇总文档）、以及**填写 PDF 表单**（无论是带交互字段的 AcroForm 还是图形版表格）。即使用户没有明说"用 PDF 工具"，只要任务的输入或产物是 .pdf（例如"把这几份报告合到一起"、"把这部分页码抽出来"、"生成一份带图的说明书"、"读一下这份施工图说明"、"在这份审批表里把信息填进去"），都要使用此 skill。本 skill 仅覆盖纯 Python 方案；扫描件 OCR 不在此范围内。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# PDF-Link

用纯 Python 处理 PDF：读、改、生成、填表。本 skill 的所有依赖都可以由 agent 在运行时通过 `shell_executor` 安装；不要预先全部安装，按当前任务现用现装即可。

## 填 PDF 表单 → 读 FORMS.md

如果当前任务是**把数据写进一份 PDF 表单**（不论 PDF 是否带可填字段），不要自己摸索坐标。读 [`FORMS.md`](FORMS.md) 并用本目录下 `scripts/` 里的脚本工作流。它已经处理好了 fillable / non-fillable 两种情况、坐标系换算、bbox 冲突校验这些容易翻车的部分。

`scripts/` 提供的工具：

| 脚本 | 作用 |
|------|------|
| `check_fillable_fields.py` | 判断 PDF 是否带 AcroForm |
| `extract_form_field_info.py` | 导出 AcroForm 字段清单（含类型、坐标、可选值） |
| `extract_form_structure.py` | 从无字段 PDF 抽出文字标签、横线、复选框 |
| `convert_pdf_to_images.py` | PDF → PNG（基于 pypdfium2，无系统依赖） |
| `check_bounding_boxes.py` | 校验 fields.json 里的 bbox 是否相交 / 容得下字号 |
| `create_validation_image.py` | 把 bbox 画到页面图上肉眼校对 |
| `fill_fillable_fields.py` | 写回 AcroForm 字段值 |
| `fill_pdf_form_with_annotations.py` | 在 non-fillable PDF 上叠加 FreeText |

下面的内容是 PDF 的其他通用操作。

## 库分工

| 任务 | 推荐库 | 作用 |
|------|--------|------|
| 元数据 / 合并 / 拆分 / 旋转 / 加密 / 提图 | `pypdf` | 轻量、纯 Python、对页对象的底层操作 |
| 抽取文本（保留版式 / 多栏） | `pdfplumber` | 按坐标重建文字流，处理复杂排版 |
| 抽取表格 | `pdfplumber` | 内置表格识别 |
| 从零生成 PDF | `reportlab` | canvas 按坐标画；platypus 按文档流排版 |

经验法则：
- 读简单 PDF → 先试 `pypdf.extract_text()`，不行再换 `pdfplumber`
- 写简单单页 → `reportlab.canvas`；写多页报告 → `reportlab.platypus`
- 操作页（合并、拆、旋转、水印、加密）→ 一律 `pypdf`

## 运行时安装

通过 shell 工具**按需安装**，切忌任务开始时候就装一大堆。常见组合：

```
pip install pypdf            # 合并/拆分/旋转/加密/元数据/提图/写 AcroForm
pip install pdfplumber       # 文本与表格抽取、表单结构识别
pip install reportlab        # 从零生成 PDF
pip install pypdfium2        # PDF → 图像（无系统依赖，FORMS 工作流用）
pip install Pillow           # 配合 pypdfium2 处理图像，裁剪验证
pip install pycryptodome     # 仅当遇到加密 PDF 时
pip install pandas openpyxl  # 仅当要把表格落到 Excel 时
```

一次任务里要用多个时合并装：`pip install pypdf pdfplumber reportlab`。表单填写工作流通常需要 `pypdf pdfplumber pypdfium2 Pillow`。

---

## 读取

### 元数据 / 页数

```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
print(f"页数: {len(reader.pages)}")

meta = reader.metadata
print(meta.title, meta.author, meta.subject, meta.creator, meta.creation_date)
```

### 抽取全文

简单 PDF（数字版、单栏）用 pypdf 就够：

```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
text = "\n".join((p.extract_text() or "") for p in reader.pages)
```

复杂排版（多栏、含图框、PKPM 计算书这类）用 pdfplumber：

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages, 1):
        print(f"--- 第 {i} 页 ---")
        print(page.extract_text())
```

### 抽取指定页 / 区域

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[2]                  # 第 3 页（0-indexed）
    # 裁掉页眉页脚再抽，减少噪声
    crop = page.crop((0, 80, page.width, page.height - 60))
    print(crop.extract_text())
```

### 抽取表格

```python
import pdfplumber
import pandas as pd

dfs = []
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        for table in page.extract_tables():
            if table and len(table) > 1:
                dfs.append(pd.DataFrame(table[1:], columns=table[0]))

if dfs:
    pd.concat(dfs, ignore_index=True).to_excel("tables.xlsx", index=False)
```

表格抽取容易在合并单元格、跨页表头、错位列上翻车。抽完后**先打印前几行肉眼核对一次**再交给下游使用。如果默认策略不行，调整 `table_settings`：

```python
page.extract_tables(table_settings={
    "vertical_strategy": "text",     # "lines" / "text" / "explicit"
    "horizontal_strategy": "lines",
})
```

### 提取图像

```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
for i, page in enumerate(reader.pages, 1):
    for j, image in enumerate(page.images, 1):
        with open(f"p{i}_img{j}_{image.name}", "wb") as f:
            f.write(image.data)
```

---

## 改造

### 合并

```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ["a.pdf", "b.pdf", "c.pdf"]:
    for page in PdfReader(path).pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as f:
    writer.write(f)
```

### 拆分（每页一个文件）

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

### 截取页码范围

```python
reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages[4:10]:          # 第 5–10 页（左闭右开，对应 1-indexed 的 5–10）
    writer.add_page(page)
with open("p5-10.pdf", "wb") as f:
    writer.write(f)
```

### 旋转

```python
reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages:
    page.rotate(90)                      # 顺时针 90°；可用 -90 / 180
    writer.add_page(page)
with open("rotated.pdf", "wb") as f:
    writer.write(f)
```

### 加水印

水印本身是一份单页 PDF（可以用 reportlab 现场生成）。将其叠加到目标的每一页：

```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader("watermark.pdf").pages[0]
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as f:
    writer.write(f)
```

### 加密 / 解密

```python
# 加密
writer = PdfWriter()
for page in PdfReader("plain.pdf").pages:
    writer.add_page(page)
writer.encrypt(user_password="user_pw", owner_password="owner_pw")
with open("encrypted.pdf", "wb") as f:
    writer.write(f)

# 读取加密文件
reader = PdfReader("encrypted.pdf")
if reader.is_encrypted:
    reader.decrypt("user_pw")
text = reader.pages[0].extract_text()
```

读加密 PDF 时若报 `PyCryptodome is required`，先 `pip install pycryptodome`。

---

## 生成

reportlab 有两种风格：
- **canvas**：自己按坐标画。适合单页图表、标签、封面。
- **platypus**：声明文档流（标题、段落、表格、分页符），自动排版。适合多页报告、计算书。

### 单页（canvas）

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=A4)
width, height = A4

c.setFont("Helvetica", 16)
c.drawString(100, height - 100, "Hello PKPM")
c.line(100, height - 120, 400, height - 120)
c.save()
```

坐标系原点在左下角，y 向上为正。

### 多页排版（platypus）

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

doc = SimpleDocTemplate("report.pdf", pagesize=A4)
styles = getSampleStyleSheet()
story = [
    Paragraph("结构计算结果汇总", styles["Title"]),
    Spacer(1, 12),
    Paragraph("以下是各楼层最大位移角与剪重比……", styles["Normal"]),
    PageBreak(),
    Paragraph("附录 A：构件配筋", styles["Heading1"]),
]
doc.build(story)
```

### 中文支持（重要）

reportlab 默认的 Helvetica/Times 等内置字体**不含中文字形**，直接写中文会渲染成方块。必须先注册中文字体。Windows 上一般可用 `C:\Windows\Fonts` 下的系统字体：

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("SimHei", r"C:\Windows\Fonts\simhei.ttf"))
# 备选：msyh.ttc（微软雅黑）、simsun.ttc（宋体）、simkai.ttf（楷体）

# canvas 用法
c.setFont("SimHei", 14)
c.drawString(100, 700, "你好，世界")

# platypus 用法：基于内置样式派生一个中文样式
from reportlab.lib.styles import ParagraphStyle
zh_normal = ParagraphStyle("zh_normal", fontName="SimHei", fontSize=12, leading=18)
zh_title  = ParagraphStyle("zh_title",  fontName="SimHei", fontSize=20, leading=26, alignment=1)
story = [
    Paragraph("结构计算结果汇总", zh_title),
    Spacer(1, 12),
    Paragraph("以下是各楼层最大位移角与剪重比……", zh_normal),
]
```

注意 `.ttc` 是字体集合，若 reportlab 报 `TTFError`，改用对应 `.ttf` 或带 subfontIndex：`TTFont("MSYH", r"C:\Windows\Fonts\msyh.ttc", subfontIndex=0)`。

### 上下标

reportlab 内置字体没有 Unicode 上下标字形（`₀₁²³` 这些会变成黑块）。**永远不要**直接在文本里用这些字符。在 Paragraph 中用 XML 标签代替：

```python
Paragraph("H<sub>2</sub>O 的反应速率 ∝ T<super>2</super>", styles["Normal"])
```

canvas 里没有标签，只能自己 `setFont` 调小字号并偏移 y 坐标手画。

### 插图与表格

```python
from reportlab.platypus import Image, Table, TableStyle
from reportlab.lib import colors

story.append(Image("plot.png", width=400, height=300))

data = [["楼层", "位移角", "剪重比"],
        ["F1", "1/850", "5.2%"],
        ["F2", "1/780", "4.8%"]]
tbl = Table(data)
tbl.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, -1), "SimHei", 10),
    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
]))
story.append(tbl)
```

---

## 排错

- **`extract_text()` 返回空字符串** —— 这份 PDF 多半是扫描件（只有图像、没有文字层）。本 skill 不覆盖扫描件识别，需要走别的链路。先用 `page.images` 看看是不是真的没有文字层。
- **`PyCryptodome is required`** —— PDF 被加密。`pip install pycryptodome` 后再读。
- **中文方块 / 乱码** —— reportlab 没注册中文字体，按上面"中文支持"一节处理。
- **表格列错位** —— 切换 `table_settings` 的策略；或先 `page.crop(...)` 把页眉页脚和无关区域裁掉再抽。
- **生成的 PDF 文件突然变得很大** —— `PdfWriter` 默认不压缩流。写入前调用 `writer.compress_identical_objects()` 和 `for page in writer.pages: page.compress_content_streams()` 可以显著减小体积。

---

## 速查

| 任务 | 一行代码 |
|------|---------|
| 页数 | `len(PdfReader(p).pages)` |
| 文本 | `PdfReader(p).pages[i].extract_text()` |
| 表格 | `pdfplumber.open(p).pages[i].extract_tables()` |
| 合并 | `for page in PdfReader(x).pages: writer.add_page(page)` |
| 拆分 | 每页一个 `PdfWriter` |
| 旋转 | `page.rotate(90)` |
| 加密 | `writer.encrypt("pw")` |
| 提图 | `page.images` |
| 新建单页 | `canvas.Canvas("o.pdf").drawString(...); c.save()` |
| 新建报告 | `SimpleDocTemplate("o.pdf").build(story)` |
