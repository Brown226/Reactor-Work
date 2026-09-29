"""office_skill_lib.skill_fonts — CJK 字体解析与 ReportLab/docx 注册。

Source: LeAgent `docgen/fonts.py` + `utils/cjk_font_discovery.py` (Apache-2.0).
Slimmed: 无 structlog / 无 LEAGENT_* 配置；env 对齐 office-engines 契约：

  ZCODE_SKILL_ENGINE_ROOT/fonts/   受管字体目录（安装器/IT 预置）
  ZCODE_FONT_DIR                   显式受管目录
  ZCODE_CJK_FONT / ZCODE_CJK_FONT_BOLD  显式文件
  SKILL_FONT_AUTO_DOWNLOAD         默认 off（内网禁运行时联网）

解析顺序：显式 env > 受管目录 > 系统扫描 > （可选下载）> 失败 warning。
CFF/PostScript outlines（PingFang、Noto CJK OTF 等）不得注册进 ReportLab。
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# ReportLab 内部注册名
PDF_FONT_REGULAR = "SkillDocSans"
PDF_FONT_BOLD = "SkillDocSansBold"
PDF_FONT_FAMILY = "SkillDocFamily"

# CFF/PostScript outlines：ReportLab TTFont 拒绝；封面等路径必须跳过。
# 注意：gstatic 的 NotoSansSC-*.ttf 是 TrueType，可嵌；notofonts 的 NotoSansCJK*.otf/ttc 是 CFF。
CFF_NAME_HINTS = (
    "pingfang",
    "hiragino",
    "sourcehansans",
    "sourcehanserif",
    "notosanscjk",
    "notoserifcjk",
)

_DISCOVERY_CACHE: dict[bool, str | None] = {}
_CACHE_LOCK = threading.Lock()


# ── 系统扫描 ──────────────────────────────────────────────────────────────────
def cjk_font_search_roots() -> list[str]:
    home = str(Path.home())
    roots: list[str | None] = [
        os.environ.get("ZCODE_FONT_DIR", "").strip() or None,
    ]
    root_env = os.environ.get("ZCODE_SKILL_ENGINE_ROOT", "").strip()
    if root_env:
        roots.append(str(Path(root_env) / "fonts"))
    roots.extend(
        [
            f"{home}/.local/share/fonts",
            f"{home}/.fonts",
            "/usr/local/share/fonts",
            "/usr/share/fonts",
        ]
    )
    if sys.platform == "darwin":
        roots.extend(
            [
                f"{home}/Library/Fonts",
                "/Library/Fonts",
                "/System/Library/Fonts/Supplemental",
                "/System/Library/Fonts",
            ]
        )
    windir = (os.environ.get("WINDIR") or os.environ.get("SystemRoot") or "").strip()
    if windir:
        win_fonts = str(Path(windir) / "Fonts")
        if Path(win_fonts).is_dir():
            roots.append(win_fonts)
    out: list[str] = []
    seen: set[str] = set()
    for raw in roots:
        if not raw:
            continue
        path = str(Path(raw).expanduser())
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out


def _candidate_names(*, is_bold: bool) -> tuple[str, ...]:
    # TrueType 优先（ReportLab 可嵌）；OTF 列在后仅作文档显示字体，PDF 注册时会过 CFF 黑名单
    if is_bold:
        return (
            "msyhbd.ttc",
            "simhei.ttf",
            "NotoSansSC-Bold.ttf",
            "SourceHanSansSC-Bold.otf",
            "NotoSansCJKsc-Bold.otf",
            "wqy-microhei.ttc",
            "wqy-zenhei.ttc",
            "PingFang.ttc",
        )
    return (
        "msyh.ttc",
        "msyh.ttf",
        "simhei.ttf",
        "simsun.ttc",
        "Microsoft YaHei.ttf",
        "NotoSansSC-Regular.ttf",
        "SourceHanSansSC-Regular.otf",
        "NotoSansCJKsc-Regular.otf",
        "wqy-microhei.ttc",
        "wqy-zenhei.ttc",
        "PingFang.ttc",
    )


def discover_cjk_font_file(*, is_bold: bool) -> str | None:
    with _CACHE_LOCK:
        if is_bold in _DISCOVERY_CACHE:
            return _DISCOVERY_CACHE[is_bold]
    names = _candidate_names(is_bold=is_bold)
    found: str | None = None
    for base in cjk_font_search_roots():
        root = Path(base)
        if not root.is_dir():
            continue
        # 只查直挂文件名：Windows/Fonts 等大树 rglob 会拖死启动
        for n in names:
            direct = root / n
            if direct.is_file():
                found = str(direct)
                break
        if found:
            break
    with _CACHE_LOCK:
        _DISCOVERY_CACHE[is_bold] = found
    return found


def clear_cjk_font_discovery_cache() -> None:
    with _CACHE_LOCK:
        _DISCOVERY_CACHE.clear()


def looks_cff(path: str | Path) -> bool:
    """按文件名启发式判定 CFF/PostScript outlines（ReportLab 不可嵌）。

    OTF 一律视为 CFF；PingFang/Hiragino 等虽是 TTC，内部仍是 CFF。
    """
    name = Path(path).name.lower()
    if name.endswith(".otf"):
        return True
    return any(hint in name for hint in CFF_NAME_HINTS)


# ── 解析结果 ──────────────────────────────────────────────────────────────────
@dataclass
class ResolvedFonts:
    regular_path: str | None = None
    bold_path: str | None = None
    source: str = "none"  # env | managed | system | none
    warnings: list[str] = field(default_factory=list)

    def available(self) -> bool:
        return bool(self.regular_path)


class FontManager:
    """进程内单例风格：resolve 结果缓存；register_pdf_fonts 幂等。"""

    def __init__(self, fonts_dir: Path | str | None = None):
        self._fonts_dir = Path(fonts_dir) if fonts_dir else None
        # 可重入：register_pdf_fonts 持锁时会调 resolve()
        self._lock = threading.RLock()
        self._resolved: ResolvedFonts | None = None
        self._pdf_registered: dict[str, str] = {}

    @property
    def fonts_dir(self) -> Path:
        if self._fonts_dir:
            return self._fonts_dir
        root = os.environ.get("ZCODE_SKILL_ENGINE_ROOT", "").strip()
        if root:
            return Path(root) / "fonts"
        env = os.environ.get("ZCODE_FONT_DIR", "").strip()
        if env:
            return Path(env)
        return Path.home() / ".local" / "share" / "fonts"

    def resolve(self, *, allow_download: bool = False, refresh: bool = False) -> ResolvedFonts:
        with self._lock:
            if self._resolved is not None and not refresh and (
                self._resolved.available() or not allow_download
            ):
                return self._resolved
            self._resolved = self._resolve_locked(allow_download=allow_download)
            return self._resolved

    def _resolve_locked(self, *, allow_download: bool) -> ResolvedFonts:
        out = ResolvedFonts()
        # 1) 显式 env
        env_r = os.environ.get("ZCODE_CJK_FONT", "").strip()
        env_b = os.environ.get("ZCODE_CJK_FONT_BOLD", "").strip()
        if env_r and Path(env_r).is_file():
            out.regular_path = env_r
            out.bold_path = env_b if env_b and Path(env_b).is_file() else None
            out.source = "env"
            return out
        if env_r:
            out.warnings.append(f"ZCODE_CJK_FONT 指向不存在的文件: {env_r}")

        # 2) 受管目录（office-engines/fonts 或 ZCODE_FONT_DIR）
        managed = self._first_in_dir(self.fonts_dir, is_bold=False)
        if managed:
            out.regular_path = managed
            out.bold_path = self._first_in_dir(self.fonts_dir, is_bold=True)
            out.source = "managed"
            return out

        # 3) 系统扫描
        system_r = discover_cjk_font_file(is_bold=False)
        if system_r:
            out.regular_path = system_r
            out.bold_path = discover_cjk_font_file(is_bold=True)
            out.source = "system"
            return out

        # 4) 内网默认不下载
        if not allow_download:
            out.warnings.append(
                "未找到 CJK 字体。请设置 ZCODE_FONT_DIR / ZCODE_CJK_FONT，或由 IT 预置 office-engines/fonts。"
            )
        else:
            out.warnings.append("allow_download=True 但本瘦身版未实现自动下载；请预置字体。")
        return out

    @staticmethod
    def _first_in_dir(directory: Path, *, is_bold: bool) -> str | None:
        if not directory.is_dir():
            return None
        for name in _candidate_names(is_bold=is_bold):
            p = directory / name
            if p.is_file():
                return str(p)
        # 目录内任意 ttf/ttc 兜底（排除 CFF）
        try:
            for p in sorted(directory.iterdir()):
                if p.suffix.lower() in (".ttf", ".ttc") and p.is_file() and not looks_cff(p):
                    return str(p)
        except OSError:
            return None
        return None

    def register_pdf_fonts(self, *, allow_download: bool = False) -> dict[str, str]:
        """注册到 ReportLab；返回 {role: reportlabName}。CFF 一律跳过。"""
        with self._lock:
            if self._pdf_registered:
                return dict(self._pdf_registered)
            resolved = self.resolve(allow_download=allow_download)
            result: dict[str, str] = {}
            warnings: list[str] = []
            if not resolved.regular_path:
                warnings.append(
                    "PDF 无可用嵌入 CJK 字体。请设置 ZCODE_CJK_FONT 为 TrueType 路径（.ttf/.ttc）。"
                )
                self._pdf_registered = result
                return result
            try:
                from reportlab.pdfbase import pdfmetrics
                from reportlab.pdfbase.ttfonts import TTFont
            except ImportError as e:
                warnings.append(f"reportlab 不可用: {e}")
                logger.warning("skill_fonts_reportlab_missing: %s", e)
                return result

            def _try_register(name: str, path: str | None, *, is_bold: bool) -> str | None:
                if not path:
                    return None
                if looks_cff(path):
                    warnings.append(f"跳过 CFF/PostScript 字体（ReportLab 不可嵌）: {path}")
                    return None
                # TTC 整册解析在 Windows 上可能极慢/卡死（msyh.ttc 实测）；
                # PDF 嵌入只走 .ttf（受管 NotoSansSC 或系统 simhei/msyh.ttf）。
                if path.lower().endswith(".ttc"):
                    warnings.append(
                        f"跳过 TTC（ReportLab 嵌入不走整册，见 office-engines/fonts 预置 .ttf）: {path}"
                    )
                    return None
                try:
                    pdfmetrics.registerFont(TTFont(name, path))
                    return name
                except Exception as e:  # noqa: BLE001
                    warnings.append(f"注册失败 {path}: {e}")
                    return None

            reg = _try_register(PDF_FONT_REGULAR, resolved.regular_path, is_bold=False)
            bold = _try_register(PDF_FONT_BOLD, resolved.bold_path, is_bold=True)
            if reg:
                result["regular"] = reg
                try:
                    pdfmetrics.registerFontFamily(
                        PDF_FONT_FAMILY,
                        normal=reg,
                        bold=bold or reg,
                        italic=reg,
                        boldItalic=bold or reg,
                    )
                    result["family"] = PDF_FONT_FAMILY
                except Exception as e:  # noqa: BLE001
                    warnings.append(f"registerFontFamily 失败: {e}")
            if bold:
                result["bold"] = bold
            if not result:
                warnings.append(
                    "PDF 无可用嵌入 CJK 字体。请设置 ZCODE_CJK_FONT 为 TrueType 路径（.ttf/.ttc），"
                    "不要用 PingFang / Noto CJK OTF。"
                )
            if warnings:
                logger.warning("skill_fonts_pdf_register_warnings: %s", warnings)
            self._pdf_registered = result
            return dict(result)

    @staticmethod
    def _ttc_subfont_index(path: str, *, is_bold: bool) -> int | None:
        """TTC 探测：尝试索引 0；失败由调用方捕获。simsun.ttc 常用 0。"""
        if not path.lower().endswith(".ttc"):
            return None
        return 0

    @staticmethod
    def office_east_asia_font() -> str:
        """python-docx / python-pptx 的 eastAsia 字体名（不一定是文件路径）。"""
        resolved = get_font_manager().resolve(allow_download=False)
        if not resolved.regular_path:
            return "SimHei"
        name = Path(resolved.regular_path).name.lower()
        if "msyh" in name or "yahei" in name:
            return "Microsoft YaHei"
        if "simhei" in name:
            return "SimHei"
        if "simsun" in name:
            return "SimSun"
        if "notosanssc" in name or "notosanscjk" in name:
            return "Noto Sans SC"
        if "wqy" in name:
            return "WenQuanYi Micro Hei"
        return "SimHei"


_manager: FontManager | None = None
_manager_lock = threading.Lock()


def get_font_manager() -> FontManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = FontManager()
        return _manager


def reset_font_manager() -> None:
    global _manager
    with _manager_lock:
        _manager = None
    clear_cjk_font_discovery_cache()
