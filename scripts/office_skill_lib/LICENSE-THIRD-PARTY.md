# Third-party notices — office_skill_lib

## LeAgent (Apache-2.0)

- Source: https://github.com/（LeAgent 1.2.7，本地参考树 `开源项目/LeAgent-1.2.7`）
- Files derived:
  - `omml.py` — from `leagent/docgen/omml.py`
  - `skill_fonts.py` — from `leagent/docgen/fonts.py` + `leagent/utils/cjk_font_discovery.py`
- Modifications: removed `structlog` / `LEAGENT_*` config / auto-download; env names aligned
  to `ZCODE_SKILL_ENGINE_ROOT` / `ZCODE_FONT_DIR` / `ZCODE_CJK_FONT`; CFF blacklist retained.
- License text: see LeAgent repository `LICENSE` (Apache License 2.0).

## PP-OCRv5 mobile ONNX models (Apache-2.0)

- Source: https://huggingface.co/x3zvawq/paddleocr-js-onnx
- Used by `ocr.py`; staged via `scripts/prepare-office-engines-assets.mjs` (`ocr-models/`).

## onnxruntime / numpy / lxml / latex2mathml / reportlab

- Distributed as wheels in office-engines Python; licenses follow their respective PyPI packages.
