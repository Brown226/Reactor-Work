# -*- coding: utf-8 -*-
"""
MaterialRecognitionDispatcher.py
================================
报告书 -> 材料 JSON 统一调度入口（按报告类型自动选择解析器生成材料 json）。

路由规则（硬性规则，勿改动）：
  1. 报告书文件为 .rtf
        -> MaterialRecognitionPBECA.py（PKPM 报告解析，Word COM 读取）
  2. 报告书内容含 PKPM 特征（PKPM / PBECA / 规定性指标计算报告书 /
     公共建筑节能计算分析报告书 等）
        -> MaterialRecognitionPBECA.py
  3. 报告书内容含 BECS / 斯维尔 特征（BECS / TH-BECS / 斯维尔 / Swell /
     建筑节能设计报告书 等）
        -> MaterialRecognitionBEC.py（若输入为 .doc，先经 Word 转临时 .docx 再解析）
  4. 报告书内容含天正特征（天正 / 公共建筑节能计算报告书 / 围护结构基本组成 /
     T-Ec / TArch）【2026-09-21 新增】
        -> MaterialRecognitionBEC.py（复用 BECS 解析核心，gen_mat2.py 已兼容天正模板）
  5. 内容无法识别
        -> 默认按 BECS 解析（纯 Python，无 Word 依赖），并打印告警

可用 --force-pbeca / --force-bec 强制指定解析器，跳过内容识别。

新增：
  * --batch 批量模式：report 传目录时遍历其中全部报告书，输出到 <目录>\\_test_out\\，
    已存在的产物自动跳过（--force 重做），批量模式固定不写 Galp。
  * 自动解释器：当前 python 缺 win32com 且输入含 .doc/.rtf 时，自动改用
    PKPM venv python（D:\\Program Files\\PKPM Agent\\resources\\backend\\.venv）重启自身，
    无需用户手动指定解释器。

提速改造（T1 / T3）
------------------------------
PKPM(pbeca) 路径的文档读取已从「Word COM 逐单元格遍历」改为「纯 Python 解析 .docx」：
  * .docx 输入          -> 全程零 Word（嗅探 + 解析都走纯 Python）
  * .doc / .rtf 输入    -> 只启动一次 Word、只 Open 一次，在同一会话内完成
                           「类型嗅探 + SaveAs2 转 .docx」，再交给纯 Python 后端
  * 转换结果与嗅探结论按 (绝对路径, mtime, size) 缓存到
    %LOCALAPPDATA%\\Galp\\docx_cache\\，命中缓存时**完全不启动 Word**；
    源文件被修改后键自动变化，不会读到脏缓存。--no-docx-cache 可关闭。
  * 纯 Python 后端若意外失败，自动回退 Word COM 后端直读原始文件。
实测（27.4MB .doc / 28 表 / 2792 段）：文档读取 10.5s -> 0.03s；
整条链路（含 Word 转换）首次 ~7s、缓存命中 ~1s，此前为 ~20s。
产物 JSON 与改造前逐字节一致（已回归验证）。

已知类型时建议加 --force-pbeca / --force-bec，可再省掉一次嗅探。

用法（PowerShell，路径含空格用双引号）：
  python "<skill>/scripts/MaterialRecognitionDispatcher.py" "<报告书路径>" [--out "<输出json>"] [--work-dir "<BECS工作目录>"] [--force-pbeca|--force-bec] [-q] [--no-galp]

函数式入口：
  from MaterialRecognitionDispatcher import dispatch
  dispatch(report="...", out_txt_path="...", work_dir="...")   # 返回 0 成功 / 1 失败

[Galp 输出]（默认开启，2026-09-15 新增）：
  生成成功后自动把材料 JSON 复制到当前用户 %LOCALAPPDATA%\\Galp\\MaterialHandle.json
  （目录不存在会自动创建，拷贝过去的文件固定重命名为 MaterialHandle.json）。
  命令行加 --no-galp，或函数入口传 galp=False，可关闭此同步。
"""
from __future__ import annotations

import argparse
import hashlib
import json as _json
import os
import re
import shutil
import sys
import tempfile
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)                     # materialhandle-tools
DEFAULT_WORK_DIR = os.path.join(SKILL_DIR, "references")    # 存放 gen_mat2.py / docx_parse.py

SUPPORTED_EXTS = (".doc", ".docx", ".rtf")

# ============================================================
# [Galp 输出] 能力（2026-09-15 新增）
#   生成成功后，把主产物材料 JSON 复制到当前用户 Local AppData 的
#   Galp 目录，并固定重命名为 MaterialHandle.json；目录不存在会自动创建。
#   命令行加 --no-galp 或函数入口 dispatch(..., galp=False) 可关闭。
# ============================================================
GALP_DIR_NAME = "Galp"                  # %LOCALAPPDATA% 下的目标目录
GALP_OUT_NAME = "MaterialHandle.json"   # 拷贝过去的固定文件名

# ---------------------------------------------------------------------------
# 内容特征（用于嗅探报告书是 PKPM 还是 BECS/斯维尔；匹配时忽略空白与大小写）
# ---------------------------------------------------------------------------
# 逐条先匹配 PKPM 特征，再匹配 BEC/斯维尔 特征。
# ASCII 词条用 (?<![a-z0-9]) / (?![a-z0-9]) 断言做词边界——\b 会把相邻中文也当单词字符，
# 导致 "由Swell软件" 这类 中文+英文 混排识别失败。
PBECA_MARKERS = [
    (r"(?<![a-z0-9])pkpm(?![a-z0-9])",       "PKPM"),
    (r"(?<![a-z0-9])pbeca(?![a-z0-9])",      "PBECA"),
    ("规定性指标计算报告书",    "PKPM 规定性指标计算报告书"),
    ("公共建筑节能计算分析报告书", "PKPM 公共建筑节能计算分析报告书"),
    ("节能计算分析报告书",       "PKPM 节能计算分析报告书"),
]

BEC_MARKERS = [
    (r"(?<![a-z0-9])becs(?![a-z0-9])",       "BECS"),
    (r"(?<![a-z0-9])th-becs(?![a-z0-9])",    "TH-BECS"),
    ("斯维尔",                  "斯维尔"),
    (r"(?<![a-z0-9])swell(?![a-z0-9])",      "Swell"),
    ("建筑节能设计报告书",       "BECS 建筑节能设计报告书"),
    ("节能设计报告书",           "节能设计报告书"),
    (r"(?<![a-z0-9])bec(?![a-z0-9])",        "BEC"),
]

# 2026-09-21：天正（TArch / T-Ec）《公共建筑节能计算报告书》特征。
# 解析复用 BECS 路径（gen_mat2.py 已兼容天正模板），此处仅用于显式识别与可观测性。
TEC_MARKERS = [
    ("天正",                      "天正"),
    ("公共建筑节能计算报告书",      "天正 公共建筑节能计算报告书"),
    ("围护结构基本组成",           "天正 围护结构基本组成"),
    (r"(?<![a-z0-9])t-ec(?![a-z0-9])", "T-Ec"),
    (r"(?<![a-z0-9])tarch(?![a-z0-9])", "TArch"),
]

RTF_LABEL = "文件扩展名为 .rtf"

# ============================================================
# 提速改造（T1/T3）：.doc / .rtf -> .docx 转换缓存
#   纯 Python docx 后端比 Word COM 快约 400 倍，但 .doc/.rtf 必须先转 .docx。
#   转换结果按 (绝对路径, mtime, size) 做键缓存到 %LOCALAPPDATA%\Galp\docx_cache，
#   并把「类型嗅探结论」一起缓存 —— 命中缓存时**完全不启动 Word**。
#   源文件被修改后 mtime/size 变化 -> 键变化 -> 自动重新转换，不会读到脏缓存。
# ============================================================
DOCX_CACHE_DIRNAME = "docx_cache"        # 位于 %LOCALAPPDATA%\Galp 下
SNIFF_HEAD_LIMIT = 60000                 # 嗅探先读文档开头字符数（读不到特征再退回全文）


def _squash(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def detect_report_type(text: str, ext: str):
    """返回 (type, reason)；type 为 'pbeca' / 'bec' / None（无法识别）。"""
    if ext == ".rtf":
        return "pbeca", RTF_LABEL
    raw = text or ""
    sq = _squash(raw).lower()
    for pat, label in PBECA_MARKERS:
        if pat.startswith("(?<!"):
            if re.search(pat, raw, re.IGNORECASE):
                return "pbeca", "内容含 %s 特征" % label
        elif pat in sq:
            return "pbeca", "内容含 %s 特征" % label
    for pat, label in TEC_MARKERS:
        if pat.startswith("(?<!"):
            if re.search(pat, raw, re.IGNORECASE):
                return "bec", "内容含 %s 特征（天正）" % label
        elif pat in sq:
            return "bec", "内容含 %s 特征（天正）" % label
    for pat, label in BEC_MARKERS:
        if pat.startswith("(?<!"):
            if re.search(pat, raw, re.IGNORECASE):
                return "bec", "内容含 %s 特征" % label
        elif pat in sq:
            return "bec", "内容含 %s 特征" % label
    return None, "未识别到 PKPM / BECS(斯维尔) 特征"


# ---------------------------------------------------------------------------
# Word COM（嗅探 .doc 内容、.doc -> .docx 转换）
# ---------------------------------------------------------------------------
def get_word_app():
    """返回 (app, need_quit)。优先 PKPMAgent.get_office_app，脱离 Agent 环境回退 win32com。"""
    try:
        from PKPMAgent.utils.link_office import get_office_app
        app = get_office_app("Word")
        if isinstance(app, str):
            raise RuntimeError(app)
        return app, False
    except Exception as exc:
        sys.stderr.write("[warn] get_office_app 不可用(%s)，回退 win32com\n" % exc)
        import pythoncom
        pythoncom.CoInitialize()
        import win32com.client
        return win32com.client.DispatchEx("Word.Application"), True


def _read_doc_text(path: str, app) -> str:
    """打开 Word 文档（只读）返回全文文本，用于内容嗅探。"""
    try:
        app.DisplayAlerts = 0
    except Exception:
        pass
    doc = app.Documents.Open(os.path.abspath(path), False, True, False)
    try:
        return doc.Content.Text or ""
    finally:
        doc.Close(False)


def _read_doc_head(doc, limit: int = SNIFF_HEAD_LIMIT) -> str:
    """提速改造 T1：在**已打开**的文档上做类型嗅探，先只读开头 limit 个字符。

    注意 Range 的上界必须 <= doc.Content.End，否则 Word 抛「数值超出范围」
    （COM 错误 -2146823680）。开头读不到特征时再退回全文，保证识别率不降。
    """
    try:
        end = doc.Content.End
        head = doc.Range(0, min(limit, end)).Text or ""
    except Exception:
        head = ""
    rtype, _ = detect_report_type(head, "")
    if rtype is not None:
        return head
    try:
        return doc.Content.Text or ""
    except Exception:
        return head


def docx_cache_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(base, GALP_DIR_NAME, DOCX_CACHE_DIRNAME)


def _cache_key(path: str) -> str:
    st = os.stat(path)
    raw = "%s|%d|%d" % (os.path.abspath(path), int(st.st_mtime), st.st_size)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def docx_cache_paths(src: str):
    """返回 (缓存 .docx 路径, 嗅探结论 sidecar 路径)。"""
    stem = os.path.splitext(os.path.basename(src))[0]
    key = _cache_key(src)
    d = docx_cache_dir()
    return os.path.join(d, "%s_%s.docx" % (key, stem)), os.path.join(d, "%s_%s.json" % (key, stem))


def _read_meta(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return _json.load(f)
    except Exception:
        return None


def _write_meta(path: str, meta: dict):
    try:
        with open(path, "w", encoding="utf-8") as f:
            _json.dump(meta, f, ensure_ascii=False, indent=1)
    except Exception as exc:
        print("[warn] 写入缓存元数据失败（不影响本次结果）：%s" % exc)


def prepare_docx(src: str, need_sniff: bool, work_dir: str,
                 quiet: bool = False, use_cache: bool = True):
    """准备好可供纯 Python 后端解析的 .docx，并（按需）在同一趟里完成类型嗅探。

    返回 (docx_path, from_cache, rtype, reason)；rtype 为 None 表示未做嗅探或未识别。

    * .docx 输入：直接返回自身，嗅探走纯 Python（零 Word）。
    * .doc / .rtf 输入：**只启动一次 Word、只 Open 一次**，在同一会话内完成
      「嗅探 + SaveAs2 转 .docx」（提速改造 T1）；结果与嗅探结论一起写入缓存，
      命中缓存时完全不启动 Word（提速改造 T3）。
    """
    ext = os.path.splitext(src)[1].lower()
    if ext == ".docx":
        if need_sniff:
            rtype, reason = detect_report_type(_extract_docx_text(src, work_dir), ext)
        else:
            rtype, reason = None, ""
        return src, True, rtype, reason

    docx_path, meta_path = docx_cache_paths(src)
    if use_cache and os.path.isfile(docx_path):
        meta = _read_meta(meta_path)
        if meta is not None or not need_sniff:
            meta = meta or {}
            if not quiet:
                print("[缓存] 命中 .docx 转换缓存（本次不启动 Word）：%s" % docx_path)
            return docx_path, True, meta.get("rtype"), meta.get("reason", "")

    os.makedirs(os.path.dirname(docx_path), exist_ok=True)
    app, need_quit = get_word_app()
    rtype, reason = None, ""
    try:
        try:
            app.DisplayAlerts = 0
        except Exception:
            pass
        try:
            app.AutomationSecurity = 3          # msoAutomationSecurityForceDisable：禁用宏，避免弹窗阻塞
        except Exception:
            pass
        doc = app.Documents.Open(os.path.abspath(src), False, True, False)   # 只读打开
        try:
            if need_sniff:
                rtype, reason = detect_report_type(_read_doc_head(doc), ext)
            doc.SaveAs2(docx_path, FileFormat=16)      # 16 = wdFormatXMLDocument
        finally:
            doc.Close(False)
    finally:
        if need_quit:
            try:
                app.Quit()
            except Exception:
                pass
    try:
        st = os.stat(src)
        _write_meta(meta_path, {"rtype": rtype, "reason": reason, "src": src,
                                "mtime": int(st.st_mtime), "size": st.st_size})
    except Exception:
        pass
    return docx_path, False, rtype, reason


def _convert_doc_to_docx(path: str, app) -> str:
    """.doc -> 临时 .docx（FileFormat=16, wdFormatXMLDocument），返回临时文件路径。"""
    tmp_dir = os.path.join(tempfile.gettempdir(), "bec_conv_%d" % os.getpid())
    os.makedirs(tmp_dir, exist_ok=True)
    out = os.path.join(tmp_dir, os.path.splitext(os.path.basename(path))[0] + ".docx")
    try:
        app.DisplayAlerts = 0
    except Exception:
        pass
    doc = app.Documents.Open(os.path.abspath(path), False, True, False)
    try:
        doc.SaveAs2(out, FileFormat=16)
    finally:
        doc.Close(False)
    return out


# ---------------------------------------------------------------------------
# 文本嗅探（.docx 纯 Python，无需 Word）
# ---------------------------------------------------------------------------
def _extract_docx_text(path: str, work_dir: str) -> str:
    if work_dir not in sys.path:
        sys.path.insert(0, work_dir)
    import docx_parse
    items = docx_parse.parse_docx(path)
    return docx_parse.full_text(items)


# ---------------------------------------------------------------------------
# 分发执行
# ---------------------------------------------------------------------------
def _run_bec(work_dir: str, docx_path: str, out_txt_path: str, quiet: bool):
    for f in ("gen_mat2.py", "docx_parse.py"):
        if not os.path.exists(os.path.join(work_dir, f)):
            raise FileNotFoundError("BECS 工作目录缺少 %s：%s（可用 --work-dir 指定）" % (f, work_dir))
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    from MaterialRecognitionBEC import main as bec_main
    bec_main(work_dir=work_dir, docx_path=docx_path, out_txt_path=out_txt_path, verbose=not quiet)


def _run_pbeca(src: str, out_txt_path: str, quiet: bool, backend: str = "docx",
               app=None, doc=None):
    """调用 PKPM 报告书解析器。

    backend='docx' -> 纯 Python 后端（提速改造 T3，输入须为 .docx）
    backend='word' -> Word COM 后端（回退用；app/doc 可传入已打开的会话，提速改造 T1）
    """
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    from MaterialRecognitionPBECA import main as pbeca_main
    argv = [src, "-o", out_txt_path, "--force", "--backend", backend]
    if quiet:
        argv.append("-q")
    return pbeca_main(argv, app=app, doc=doc)


def _backup_old_output(out_txt_path: str):
    """PBECA 路径覆盖前先备份旧输出（与 BEC 路径行为一致，不覆盖历史基线）。"""
    if not os.path.exists(out_txt_path):
        return None
    stem = os.path.splitext(out_txt_path)[0]
    backup = "%s_原_%s.json" % (stem, time.strftime("%Y%m%d_%H%M%S"))
    shutil.copyfile(out_txt_path, backup)
    print("[备份] 已备份旧输出到：%s" % backup)
    return backup


# ---------------------------------------------------------------------------
# [Galp 输出] 同步到 %LOCALAPPDATA%\Galp（2026-09-15 新增）
# ---------------------------------------------------------------------------
def galp_sync_path():
    """返回 Galp 同步目标路径：%LOCALAPPDATA%\\Galp\\MaterialHandle.json。

    LOCALAPPDATA 环境变量缺失时回退到 ~\\AppData\\Local，保证跨环境可用。
    """
    base = os.environ.get("LOCALAPPDATA") or os.path.join(
        os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(base, GALP_DIR_NAME, GALP_OUT_NAME)


def sync_to_galp(out_txt_path: str, quiet: bool = False):
    """[Galp 输出] 生成成功后把材料 JSON 复制到 Galp 目录（不存在则创建）。

    :param out_txt_path: 本次生成的主产物材料 JSON 路径
    :param quiet: 静默模式下不打印
    :return: 目标路径；复制失败时返回 None（仅告警，不影响主产物交付）
    """
    dest = galp_sync_path()
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)   # 目录不存在则创建
        shutil.copyfile(out_txt_path, dest)                 # 拷贝并固定重命名
        if not quiet:
            print("[Galp] 已复制材料 JSON 到：%s" % dest)
        return dest
    except Exception as exc:
        print("[Galp] 复制到 %s 失败（不影响主产物）：%s" % (dest, exc))
        return None


def dispatch(report: str, out_txt_path: str = None, work_dir: str = None,
             force: str = None, quiet: bool = False, galp: bool = True,
             use_docx_cache: bool = True):
    """统一入口。force 取值 'pbeca' / 'bec' / None；galp=True 时生成后同步到
    %LOCALAPPDATA%\\Galp\\MaterialHandle.json；返回 0 成功，1 失败。

    提速改造（T1 / T3）后的执行路径：
      * .docx 输入 —— 全程零 Word：嗅探与解析都走纯 Python。
      * .doc / .rtf 输入 —— 只启动一次 Word、只 Open 一次，在同一会话内完成
        「类型嗅探 + SaveAs2 转 .docx」，随后交给纯 Python 后端解析。
      * 转换结果与嗅探结论按 (路径, mtime, size) 缓存，命中缓存时完全不启动 Word。
        use_docx_cache=False（CLI: --no-docx-cache）可关闭缓存。
      * 纯 Python 后端若意外失败，自动回退到 Word COM 后端解析原始文件。
    """
    src = os.path.abspath(report)
    if not os.path.isfile(src):
        raise FileNotFoundError("找不到输入文件：%s" % src)

    ext = os.path.splitext(src)[1].lower()
    if ext not in SUPPORTED_EXTS:
        raise ValueError("不支持的报告书格式：%s（支持 %s）" % (ext, " / ".join(SUPPORTED_EXTS)))

    wd = os.path.abspath(work_dir or DEFAULT_WORK_DIR)
    out = out_txt_path or os.path.join(
        os.path.dirname(src), os.path.splitext(os.path.basename(src))[0] + "_材料.json")

    # ---------------- 报告类型识别 + .docx 准备（同一趟 Word 会话内完成）----------------
    # .rtf 按硬性规则 1 直接判定为 pbeca，无需嗅探正文
    need_sniff = (force is None) and (ext != ".rtf")
    docx_path, from_cache, s_type, s_reason = prepare_docx(
        src, need_sniff=need_sniff, work_dir=wd, quiet=quiet, use_cache=use_docx_cache)

    if force == "pbeca":
        rtype, reason = "pbeca", "用户 --force-pbeca 强制指定"
    elif force == "bec":
        rtype, reason = "bec", "用户 --force-bec 强制指定"
    elif ext == ".rtf":
        rtype, reason = "pbeca", RTF_LABEL
    else:
        rtype, reason = s_type, (s_reason or "")
        if rtype is None:
            rtype, reason = "bec", "未识别到 PKPM / BECS(斯维尔) 特征，默认按 BECS 解析"

    if not quiet:
        print("[识别] 报告类型=%s（%s）" % (rtype, reason))
        print("[识别] 输入=%s" % src)
        if docx_path != src:
            print("[加速] 解析对象=%s（%s）"
                  % (docx_path, "命中转换缓存" if from_cache else "本次由 Word 转换"))
        print("[识别] 输出=%s" % out)

    # ---------------- 分发 ----------------
    if rtype == "bec":
        _run_bec(wd, docx_path, out, quiet)
    else:
        _backup_old_output(out)
        try:
            _run_pbeca(docx_path, out, quiet, backend="docx")
        except Exception as exc:
            # 安全网：纯 Python 后端异常时回退 Word COM 直读原始文件
            print("[warn] 纯 Python docx 后端失败（%s），回退 Word COM 后端" % exc)
            _run_pbeca(src, out, quiet, backend="word")

    # [Galp 输出] 生成成功后同步到 %LOCALAPPDATA%\Galp\MaterialHandle.json
    if galp:
        sync_to_galp(out, quiet)
    return 0


def _cli(argv=None):
    ap = argparse.ArgumentParser(
        description="报告书 -> 材料 JSON 统一调度：.rtf / PKPM 内容走 MaterialRecognitionPBECA，BECS/斯维尔 内容走 MaterialRecognitionBEC")
    ap.add_argument("report", help="报告书路径（.doc / .docx / .rtf）")
    ap.add_argument("-o", "--out", dest="out", help="输出材料 JSON 路径，默认 <报告书主名>_材料.json")
    ap.add_argument("--work-dir", dest="work_dir",
                    help="BECS 工作目录（存放 gen_mat2.py / docx_parse.py），默认本技能 references 目录")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--force-pbeca", dest="force", action="store_const", const="pbeca",
                   help="强制使用 MaterialRecognitionPBECA（跳过内容识别）")
    g.add_argument("--force-bec", dest="force", action="store_const", const="bec",
                   help="强制使用 MaterialRecognitionBEC（跳过内容识别）")
    ap.add_argument("-q", "--quiet", action="store_true", help="只打印关键结论")
    ap.add_argument("--no-docx-cache", dest="use_docx_cache", action="store_false", default=True,
                    help="关闭 .doc/.rtf -> .docx 的转换缓存（默认开启，缓存位于 "
                         "%%LOCALAPPDATA%%\\Galp\\docx_cache，命中时不启动 Word）")
    ap.add_argument("--no-galp", dest="galp", action="store_false", default=True,
                    help="[Galp 输出] 关闭同步：默认生成后把材料 JSON 复制到 "
                         "%%LOCALAPPDATA%%\\Galp\\MaterialHandle.json（目录不存在自动创建）")
    ap.add_argument("--batch", action="store_true",
                    help="[2026-09-20] 批量模式：report 为目录时遍历其中全部支持的报告书，"
                         "输出到 <目录>\\_test_out\\<报告主名>_材料.json，自动跳过已存在的产物"
                         "（可加 --force 重新生成），批量模式固定不写 Galp")
    ap.add_argument("--force", dest="redo", action="store_true",
                    help="[2026-09-20] 批量模式下重新生成已存在产物")
    a = ap.parse_args(argv)

    # ---------------- 批量模式（2026-09-20）----------------
    if a.batch:
        src = os.path.abspath(a.report)
        if not os.path.isdir(src):
            print("[错误] --batch 模式下 report 必须是目录：%s" % src)
            return 1
        files = sorted(f for f in os.listdir(src)
                       if os.path.splitext(f)[1].lower() in SUPPORTED_EXTS)
        if not files:
            print("[批量] 目录下没有支持的报告书（%s）" % " / ".join(SUPPORTED_EXTS))
            return 1
        out_dir = os.path.join(src, "_test_out")
        os.makedirs(out_dir, exist_ok=True)
        ok = fail = skipped = 0
        t0 = time.time()
        for f in files:
            rp = os.path.join(src, f)
            stem = os.path.splitext(f)[0]
            out = os.path.join(out_dir, stem + "_材料.json")
            if os.path.exists(out) and not a.redo:
                print("[批量] 跳过（已存在，--force 可重做）：%s" % out)
                skipped += 1
                continue
            t1 = time.time()
            try:
                dispatch(report=rp, out_txt_path=out, work_dir=a.work_dir,
                         force=None, quiet=a.quiet, galp=False,
                         use_docx_cache=a.use_docx_cache)
                ok += 1
                print("[批量] OK %s（%.2fs）" % (f, time.time() - t1))
            except Exception as exc:
                fail += 1
                print("[批量] FAIL %s：%s" % (f, exc))
        print("[批量] 完成：成功 %d，失败 %d，跳过 %d，总耗时 %.2fs，输出目录 %s"
              % (ok, fail, skipped, time.time() - t0, out_dir))
        return 0 if fail == 0 else 1

    try:
        dispatch(report=a.report, out_txt_path=a.out, work_dir=a.work_dir,
                 force=a.force, quiet=a.quiet, galp=a.galp,
                 use_docx_cache=a.use_docx_cache)
    except Exception as exc:
        print("[错误] %s" % exc)
        return 1
    return 0


def _should_auto_run():
    g = globals()
    nm = g.get("__name__")
    if nm == "__main__":
        return True
    if nm is None and g.get("__spec__") is None and g.get("__file__"):
        return True
    return False


# ---------------------------------------------------------------------------
# 2026-09-20：.doc/.rtf 需要 Word COM（win32com）。
# 系统 python(3.13) 无 win32com 时，若发现 PKPM 自带的 venv python 则自动换解释器重启，
# 避免每次都要用户手动指定。仅当输入含 .doc/.rtf 且当前解释器缺 win32com 时触发。
# ---------------------------------------------------------------------------
PKPM_VENV_PY = r"D:\Program Files\PKPM Agent\resources\backend\.venv\Scripts\python.exe"


def _need_word_com(argv):
    for a in argv:
        if not a.startswith("-") and os.path.exists(a):
            if os.path.isdir(a):
                if any(os.path.splitext(f)[1].lower() in (".doc", ".rtf")
                       for f in os.listdir(a)):
                    return True
            elif os.path.splitext(a)[1].lower() in (".doc", ".rtf"):
                return True
    return False


def _ensure_word_capable(argv):
    if os.environ.get("MH_NO_VENV_RELAUNCH"):
        return
    if not _need_word_com(argv):
        return
    try:
        import win32com.client          # noqa: F401
        return
    except Exception:
        pass
    if os.path.isfile(PKPM_VENV_PY):
        sys.stderr.write("[warn] 当前 python 无 win32com，改用 PKPM venv python 重启：%s\n"
                         % PKPM_VENV_PY)
        os.environ["MH_NO_VENV_RELAUNCH"] = "1"
        try:
            # 用 subprocess 而非 os.execv：execv 在部分封装环境会丢参数/改写路径
            import subprocess
            code = subprocess.call([PKPM_VENV_PY, os.path.abspath(__file__)] + argv)
            sys.exit(code if code is not None else 1)
        except Exception as exc:
            sys.stderr.write("[warn] 自动重启失败（%s），继续使用当前解释器\n" % exc)


if _should_auto_run():
    _argv = sys.argv[1:] if globals().get("__name__") == "__main__" else []
    _ensure_word_capable(_argv)
    sys.exit(_cli(_argv))
