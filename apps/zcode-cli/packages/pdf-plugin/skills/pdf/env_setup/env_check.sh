#!/usr/bin/env bash
# Lightweight environment check for PDF skill.
# Exit 0 = all CORE deps OK, exit 1 = missing CORE dependency.
# Playwright/Chromium (Creative/HTML pipeline) and Tectonic (Academic/LaTeX) are
# OPTIONAL — reported as INFO, never cause a non-zero exit. Install them on demand
# (with the user's confirmation) only when a route actually needs them.
# Also resolves and exports PDF_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING (core): $desc"; FAIL=1; fi; }
optional() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "optional OK: $desc"; else $QUIET || echo "optional MISSING: $desc (install on demand)"; fi; }
# soffice 解析顺序（内网 fork 版）：系统 PATH → 内置/垫片引擎 env（见下方 Bundled engines 块）
# → 才报缺失。本 fork 面向内外网隔离部署：办公环境预装 Office/WPS，缺 soffice 时由 IT 经
# 内网镜像/基镜像提供，不去公网下载；渲染保真度由 visual-judge 逐页验收兜底（产品约定，
# 见 docs/已完成/已完成-内网办公四件套-fork-spec.md）。
required_on_demand() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "on-demand OK: $desc"; else $QUIET || echo "on-demand MISSING: $desc — 内网部署不连公网。处理顺序：1) 先查 soffice 是否已装但不在 PATH（/opt/libreoffice*/program/soffice、/Applications/LibreOffice.app/Contents/MacOS/soffice、C:\\\\Program Files\\\\LibreOffice\\\\program\\\\soffice.exe），在则注册后复验 soffice --version；2) 由 IT 经内网镜像/基镜像提供 LibreOffice，或配置 ZCODE_LIBREOFFICE_PATH / ZCODE_SKILL_ENGINE_ROOT 指向受管引擎；3) 不得静默跳过 Office→PDF 导出/视觉检查——渲染产出必须经 pdf:visual-judge 验收才算交付；缺引擎时向用户说明并联系 IT，不得假装转换成功。"; fi; }

# ── Resolve PDF_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PDF_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export PDF_SKILL_DIR

if [ "$(uname -s)" = "Darwin" ]; then
    FONT_DIR="${HOME}/Library/Fonts"
else
    FONT_DIR="/usr/share/fonts"
fi
export FONT_DIR

# ── Bundled engines（内网受管安装）──
# 解析顺序：ZCODE_LIBREOFFICE_PATH / ZCODE_PYTHON_PATH 直接指定 > ZCODE_SKILL_ENGINE_ROOT
# 默认布局（libreoffice/program/、python/bin/）> 系统 PATH。命中后把可执行目录前置到 PATH，
# 下游 soffice / python3 调用零改动；内网安装不再要求用户去公网镜像下载（安装器负责预置，
# 并保证 python3 可解析：Windows 受管 python 目录需同时提供 python3.exe）。
_zcode_prepend_path() { case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; }
if [ -n "${ZCODE_LIBREOFFICE_PATH:-}" ]; then
    case "$ZCODE_LIBREOFFICE_PATH" in
        */|*/program|*/bin) _zcode_prepend_path "${ZCODE_LIBREOFFICE_PATH%/}" ;;
        *) [ -e "$ZCODE_LIBREOFFICE_PATH" ] && _zcode_prepend_path "$(cd "$(dirname "$ZCODE_LIBREOFFICE_PATH")" && pwd)" ;;
    esac
elif [ -n "${ZCODE_SKILL_ENGINE_ROOT:-}" ]; then
    for _c in "$ZCODE_SKILL_ENGINE_ROOT/libreoffice/program/soffice.exe" "$ZCODE_SKILL_ENGINE_ROOT/libreoffice/program/soffice"; do
        [ -x "$_c" ] && { _zcode_prepend_path "$(cd "$(dirname "$_c")" && pwd)"; break; }
    done
fi
if [ -n "${ZCODE_PYTHON_PATH:-}" ]; then
    case "$ZCODE_PYTHON_PATH" in
        */|*/bin) _zcode_prepend_path "${ZCODE_PYTHON_PATH%/}" ;;
        *) [ -e "$ZCODE_PYTHON_PATH" ] && _zcode_prepend_path "$(cd "$(dirname "$ZCODE_PYTHON_PATH")" && pwd)" ;;
    esac
elif [ -n "${ZCODE_SKILL_ENGINE_ROOT:-}" ]; then
    for _c in "$ZCODE_SKILL_ENGINE_ROOT/python/bin/python3.exe" "$ZCODE_SKILL_ENGINE_ROOT/python/bin/python3" "$ZCODE_SKILL_ENGINE_ROOT/python/python3.exe" "$ZCODE_SKILL_ENGINE_ROOT/python/python3" "$ZCODE_SKILL_ENGINE_ROOT/python/python.exe"; do
        [ -x "$_c" ] && { _zcode_prepend_path "$(cd "$(dirname "$_c")" && pwd)"; break; }
    done
fi
export PATH
# 受管字体目录（安装器预置 CJK 字体时设置）；未设置则维持系统字体目录语义不变。
if [ -n "${ZCODE_FONT_DIR:-}" ] && [ -d "${ZCODE_FONT_DIR}" ]; then
    FONT_DIR="${ZCODE_FONT_DIR}"
    export FONT_DIR
fi

# ── CORE (required): Python + ReportLab/pypdf toolchain + CJK font ──
check "python3"    command -v python3
check "pikepdf"    python3 -c "import pikepdf"
check "pdfplumber" python3 -c "import pdfplumber"
check "pypdf"      python3 -c "import pypdf"
check "reportlab"  python3 -c "import reportlab"
check "PyMuPDF"    python3 -c "import fitz"

# Font check: verify an embeddable CJK font is available (SimHei/Noto/WenQuanYi/Songti…)
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|simsun\|songti\|heiti\|wenquanyi\|yahei\|kai" \
        || { $QUIET || echo "MISSING (core): CJK font"; FAIL=1; }
fi

# ── OPTIONAL: Creative/HTML pipeline (Node + Playwright + Chromium) ──
optional "node"       command -v node
optional "playwright (npm)" node -e "require('playwright')"

# ── OPTIONAL: Academic/LaTeX pipeline (Tectonic) ──
if [ -x "$PDF_SKILL_DIR/scripts/tectonic" ] || command -v tectonic &>/dev/null; then
    $QUIET || echo "optional OK: tectonic"
else
    $QUIET || echo "optional MISSING: tectonic (LaTeX/Academic; install on demand)"
fi

# ── ON-DEMAND but NOT substitutable: Office→PDF (LibreOffice/soffice) ──
required_on_demand "libreoffice (soffice)" command -v soffice

$QUIET || echo "PDF_SKILL_DIR=$PDF_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
