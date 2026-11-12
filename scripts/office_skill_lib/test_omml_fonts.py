"""office_skill_lib 单测：omml / skill_fonts / ocr。

在 office-engines Python 或已装依赖的解释器上跑：
  python -m unittest discover -s scripts/office_skill_lib -p "test_*.py"
或：
  python scripts/office_skill_lib/test_omml_fonts.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from office_skill_lib import omml, skill_fonts  # noqa: E402


class TestOmml(unittest.TestCase):
    def test_import_and_public_api(self):
        self.assertTrue(callable(omml.latex_to_omml_xml))
        self.assertTrue(callable(omml.latex_to_omml_element))
        self.assertTrue(callable(omml.omml_pptx_alternate))

    def test_latex_to_omml_fraction(self):
        try:
            import latex2mathml  # noqa: F401
        except ImportError:
            self.skipTest("latex2mathml 未安装（生产由 office-engines 闭包提供）")
        xml = omml.latex_to_omml_xml(r"\frac{a}{b}")
        self.assertIsNotNone(xml)
        self.assertIn("m:oMath", xml)
        self.assertIn("m:f", xml)  # fraction

    def test_bad_latex_returns_none_not_raise(self):
        # 任意异常路径都不得抛出
        result = omml.latex_to_omml_xml("\\notarealcommand{")
        # 要么 None，要么可解析字符串；绝不抛
        self.assertTrue(result is None or isinstance(result, str))


class TestSkillFonts(unittest.TestCase):
    def setUp(self):
        skill_fonts.reset_font_manager()
        self._env_backup = {
            k: os.environ.get(k)
            for k in (
                "ZCODE_CJK_FONT",
                "ZCODE_CJK_FONT_BOLD",
                "ZCODE_FONT_DIR",
                "ZCODE_SKILL_ENGINE_ROOT",
            )
        }

    def tearDown(self):
        skill_fonts.reset_font_manager()
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_env_override_wins(self):
        with tempfile.TemporaryDirectory() as td:
            font = Path(td) / "fake.ttf"
            font.write_bytes(b"\0" * 16)
            os.environ["ZCODE_CJK_FONT"] = str(font)
            os.environ.pop("ZCODE_CJK_FONT_BOLD", None)
            resolved = skill_fonts.get_font_manager().resolve(allow_download=False)
            self.assertEqual(resolved.regular_path, str(font))
            self.assertEqual(resolved.source, "env")
            self.assertTrue(resolved.available())

    def test_missing_env_warning(self):
        os.environ["ZCODE_CJK_FONT"] = "Z:/no/such/font.ttf"
        resolved = skill_fonts.get_font_manager().resolve(allow_download=False)
        self.assertTrue(any("ZCODE_CJK_FONT" in w for w in resolved.warnings))
        # 仍可回落到受管/系统字体；无字体时 available 为 False

    def test_looks_cff(self):
        self.assertTrue(skill_fonts.looks_cff("NotoSansCJKsc-Regular.otf"))
        self.assertTrue(skill_fonts.looks_cff("PingFang.ttc"))
        self.assertTrue(skill_fonts.looks_cff("NotoSansSC-Regular.otf"))
        self.assertFalse(skill_fonts.looks_cff("NotoSansSC-Regular.ttf"))
        self.assertFalse(skill_fonts.looks_cff("msyh.ttc"))
        self.assertFalse(skill_fonts.looks_cff("simhei.ttf"))

    def test_office_east_asia_font_fallback(self):
        # 无字体时也有稳定返回
        name = skill_fonts.FontManager.office_east_asia_font()
        self.assertIsInstance(name, str)
        self.assertGreater(len(name), 0)

    def test_register_pdf_fonts_without_reportlab_is_safe(self):
        # reportlab 缺失时返回空 dict / 有 warning，不抛
        result = skill_fonts.get_font_manager().register_pdf_fonts(allow_download=False)
        self.assertIsInstance(result, dict)


class TestOcrModuleShape(unittest.TestCase):
    def test_ocr_public_api_exists(self):
        from office_skill_lib import ocr

        self.assertTrue(callable(ocr.engine_status))
        self.assertTrue(callable(ocr.recognize_image))
        self.assertTrue(callable(ocr.recognize_pdf))
        self.assertTrue(callable(ocr.OcrEngineUnavailable))


if __name__ == "__main__":
    unittest.main()
