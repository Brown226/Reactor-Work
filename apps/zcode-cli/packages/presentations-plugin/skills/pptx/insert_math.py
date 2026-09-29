#!/usr/bin/env python3
"""PPTX 公式插入：LaTeX → OMML（mc:AlternateContent，PowerPoint 原生公式 + 可读回退）。

用法：
  python insert_math.py input.pptx output.pptx --latex "E=mc^2" --slide 0
  python insert_math.py input.pptx output.pptx --latex-file f.tex --slide 1 --display

依赖：office_skill_lib.omml、python-pptx。失败时插入纯文本 [公式: …]。
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
        sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
        from office_skill_lib import omml
        return omml


def insert_math_pptx(
    pptx_path: str,
    output_path: str,
    latex: str,
    *,
    slide_index: int = 0,
    display: bool = True,
    fallback_text: str | None = None,
) -> dict:
    omml = _import_omml()
    try:
        from pptx import Presentation
        from pptx.util import Inches
        from pptx.oxml import parse_xml
    except ImportError as e:
        raise SystemExit(f"python-pptx 不可用: {e}") from e

    fallback = fallback_text if fallback_text is not None else latex
    element = omml.omml_pptx_alternate(latex, fallback, display=display)

    prs = Presentation(pptx_path)
    if slide_index < 0 or slide_index >= len(prs.slides):
        return {
            "status": "failed",
            "error": f"slide_index {slide_index} 越界（共 {len(prs.slides)} 页）",
        }

    slide = prs.slides[slide_index]
    box = slide.shapes.add_textbox(Inches(1), Inches(4), Inches(6), Inches(1.5))
    tf = box.text_frame
    tf.text = ""  # clear
    para = tf.paragraphs[0]._p  # a:p

    if element is None:
        run = tf.paragraphs[0].add_run()
        run.text = f"[公式: {latex}]"
        prs.save(output_path)
        return {
            "status": "degraded",
            "latex": latex,
            "mode": "text-fallback",
            "warning": "OMML 转换失败，已插入纯文本占位",
        }

    para.append(element)
    prs.save(output_path)
    return {
        "status": "success",
        "latex": latex,
        "mode": "omml-pptx-alternate",
        "slide": slide_index,
        "output": output_path,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Insert LaTeX as OMML AlternateContent into pptx")
    parser.add_argument("input_pptx")
    parser.add_argument("output_pptx")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--latex")
    group.add_argument("--latex-file")
    parser.add_argument("--slide", type=int, default=0)
    parser.add_argument("--display", action="store_true", default=True)
    parser.add_argument("--inline", action="store_true")
    parser.add_argument("--fallback-text")
    args = parser.parse_args(argv)

    latex = (
        Path(args.latex_file).read_text(encoding="utf-8").strip()
        if args.latex_file
        else args.latex
    )
    result = insert_math_pptx(
        args.input_pptx,
        args.output_pptx,
        latex,
        slide_index=args.slide,
        display=not args.inline,
        fallback_text=args.fallback_text,
    )
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if result.get("status") in ("success", "degraded") else 1


if __name__ == "__main__":
    raise SystemExit(main())
