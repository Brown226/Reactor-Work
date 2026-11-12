import sys
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn

src = r"E:\工作\Reactor-Work\docs\审查板块原始数据\标准库测试文档\HX1CI084200B25A43GNACFC (15251CI-JPS502).docx"
doc = Document(src)

body = doc.element.body
lines = []

def para_text(p):
    return "".join(n.text or "" for n in p._p.iter(qn('w:t')))

for child in body.iterchildren():
    if child.tag == qn('w:p'):
        t = para_text(Paragraph(child, doc))
        lines.append(t)
    elif child.tag == qn('w:tbl'):
        tbl = Table(child, doc)
        lines.append("[TABLE]")
        for row in tbl.rows:
            cells = []
            for c in row.cells:
                cells.append(" ".join(para_text(p) for p in c.paragraphs).strip())
            lines.append(" | ".join(cells))
        lines.append("[/TABLE]")

out = "\n".join(lines)
outpath = r"E:\工作\Reactor-Work\docs\审查板块原始数据\标准库测试文档\_HX1CI084200B25A43GNACFC_extracted.txt"
with open(outpath, "w", encoding="utf-8") as f:
    f.write(out)

print("chars:", len(out))
print("lines:", len(lines))
print("outpath:", outpath)
