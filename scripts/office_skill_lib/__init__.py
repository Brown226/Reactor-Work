"""共享 skill 运行时库（由 prepare-office-engines-assets staging 进 site-packages）。

模块：
- ocr: 扫描件/图片文字识别（PP-OCR ONNX 最小管线）
- omml: LaTeX → OMML（借自 LeAgent，Apache-2.0）
- skill_fonts: CJK 字体解析与 ReportLab 注册（借自 LeAgent，Apache-2.0）
"""

from __future__ import annotations

__all__ = ["ocr", "omml", "skill_fonts"]
