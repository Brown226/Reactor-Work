#!/usr/bin/env python3
"""docx 公式插入：LaTeX → OMML（原生可编辑公式），失败降级纯文本。

用法：
  python insert_math.py input.docx output.docx --latex "\\frac{a}{b}"
  python insert_math.py input.docx output.docx --latex-file f.tex --display
  python insert_math.py input.docx output.docx --append --latex "E=mc^2"

依赖：office_skill_lib.omml（latex2mathml + lxml）、python-docx。
输出公式为 m:oMath / m:oMathPara；转换失败时插入 [公式: <latex>] 文本并记 warning。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _import_omml():
    try:
        from office_skill_lib import omml
        return omml
    except ImportError:
        # 开发态：scripts/ 直挂
        sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
        try:
            from office_skill_lib import omml
            return omml
        except ImportError as e:
            raise SystemExit(f"office_skill_lib.omml 不可用: {e}") from e


def insert_math(
    docx_path: str,
    output_path: str,
    latex: str,
    *,
    display: bool = True,
    append: bool = False,
    paragraph_index: int | None = None,
) -> dict:
    omml = _import_omml()
    try:
        from docx import Document
        from docx.oxml import parse_xml
        from docx.oxml.ns import qn, nsmap
    except ImportError as e:
        raise SystemExit(f"python-docx 不可用: {e}") from e

    xml = omml.latex_to_omml_xml(latex, display=display)
    doc = Document(docx_path)

    if xml is None:
        # 降级：纯文本公式
        text = f"[公式: {latex}]"
        if append:
            doc.add_paragraph(text)
        else:
            paras = doc.paragraphs
            if not paras:
                doc.add_paragraph(text)
            else:
                idx = paragraph_index if paragraph_index is not None else 0
                idx = max(0, min(idx, len(paras) - 1))
                paras[idx].add_run(text)
        doc.save(output_path)
        return {
            "status": "degraded",
            "latex": latex,
            "mode": "text-fallback",
            "warning": "OMML 转换失败，已插入纯文本占位",
        }

    # OMML 命名空间：m
    # python-docx parse_xml 需要完整 ns 声明；omml.latex_to_omml_xml 已带 xmlns:m
    wrapped = xml
    if display and not wrapped.lstrip().startswith("<m:oMathPara"):
        wrapped = (
            '<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            + xml
            + "</m:oMathPara>"
        )

    omath_el = parse_xml(wrapped)

    if append:
        p = doc.add_paragraph()
        p._p.append(omath_el)
    else:
        paras = doc.paragraphs
        if not paras:
            p = doc.add_paragraph()
            p._p.append(omath_el)
        else:
            idx = paragraph_index if paragraph_index is not None else 0
            idx = max(0, min(idx, len(paras) - 1))
            paras[idx]._p.append(omath_el)

    doc.save(output_path)
    return {
        "status": "success",
        "latex": latex,
        "mode": "omml-display" if display else "omml-inline",
        "output": output_path,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Insert LaTeX formula as native OMML into docx")
    parser.add_argument("input_docx")
    parser.add_argument("output_docx")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--latex", help="LaTeX source string")
    group.add_argument("--latex-file", help="Path to file containing LaTeX")
    parser.add_argument("--display", action="store_true", default=True, help="Display equation (oMathPara)")
    parser.add_argument("--inline", action="store_true", help="Inline equation (oMath)")
    parser.add_argument("--append", action="store_true", help="Append new paragraph instead of targeting index")
    parser.add_argument("--paragraph-index", type=int, default=0)
    args = parser.parse_args(argv)

    if args.latex_file:
        latex = Path(args.latex_file).read_text(encoding="utf-8").strip()
    else:
        latex = args.latex

    result = insert_math(
        args.input_docx,
        args.output_docx,
        latex,
        display=not args.inline,
        append=args.append,
        paragraph_index=args.paragraph_index,
    )
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if result["status"] in ("success", "degraded") else 1


if __name__ == "__main__":
    raise SystemExit(main())
