#!/usr/bin/env bash
# Lightweight environment check for XLSX skill.
# Exit 0 = all OK, exit 1 = missing dependencies.
# Also resolves and exports XLSX_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING: $desc"; FAIL=1; fi; }
# soffice 解析顺序（内网 fork 版）：系统 PATH → 内置/垫片引擎 env（见下方 Bundled engines 块）
# → 才报缺失。本 fork 面向内外网隔离部署：办公环境预装 Office/WPS，缺 soffice 时由 IT 经
# 内网镜像/基镜像提供，不去公网下载；渲染保真度由 visual-judge 逐页验收兜底（产品约定，
# 见 docs/已完成/已完成-内网办公四件套-fork-spec.md）。
required_on_demand() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "on-demand OK: $desc"; else $QUIET || echo "on-demand MISSING: $desc — 内网部署不连公网。处理顺序：1) 先查 soffice 是否已装但不在 PATH（/opt/libreoffice*/program/soffice、/Applications/LibreOffice.app/Contents/MacOS/soffice、C:\\\\Program Files\\\\LibreOffice\\\\program\\\\soffice.exe），在则注册后复验 soffice --version；2) 由 IT 经内网镜像/基镜像提供 LibreOffice，或配置 ZCODE_LIBREOFFICE_PATH / ZCODE_SKILL_ENGINE_ROOT 指向受管引擎；3) 不得静默跳过重算/xlsx→PDF 检查——渲染产出必须经 spreadsheets:visual-judge 验收才算交付；缺引擎时向用户说明并联系 IT，不得假装转换成功。"; fi; }

# ── Resolve XLSX_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
XLSX_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export XLSX_SKILL_DIR

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

check "python3"     command -v python3
check "openpyxl"    python3 -c "import openpyxl"
check "xlsxwriter"  python3 -c "import xlsxwriter"

# Font check
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|wenquanyi" || { $QUIET || echo "MISSING: CJK fonts"; FAIL=1; }
fi

# ── ON-DEMAND but NOT substitutable: recalc / .xlsx→PDF / .csv→.xlsx (LibreOffice/soffice) ──
required_on_demand "libreoffice (soffice)" command -v soffice

$QUIET || echo "XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
