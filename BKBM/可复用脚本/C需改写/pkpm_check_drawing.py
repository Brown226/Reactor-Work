#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""调用 PKPM 图纸识别校审程序 AutoRecDwg.exe。

exe 的调用约定：
    AutoRecDwg.exe <图纸路径> <日志JSON路径> [-seismic N] [-concrete N] [-cover N] [-slab N]

没给 --exe / --software-dir 时自动定位：在本机已安装的 PKPM 里按版本从高到低挑第一个
可用的，AutoRecDwg.exe 在安装目录下的位置见 CHECKER_PATHS_UNDER_INSTALL。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

from PKPMAgent.software_link_kit.pkpm_install import find_pkpm_installs
from PKPMAgent.utils.winsys import parse_version

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

CHECKER_FILENAME = "AutoRecDwg.exe"
PKPMMAIN_FILENAME = "PKPMMain.exe"
PKPM_ROOT_FILENAME = "PKPM.exe"
# AutoRecDwg.exe 相对 PKPM 安装目录的位置。
CHECKER_PATHS_UNDER_INSTALL = (
    Path("Ribbon") / "DRAWCK" / "ODA" / CHECKER_FILENAME,
)

# 带图纸校审功能的最低 PKPM 版本，低于这个版本的安装即使装了也不用。
# 和 mcp_link/pkpm.py 里 MCP 服务的门槛是两条独立的线，各管各的。
MIN_SUPPORTED_VERSION = "2027.1.1"

AUTORECDWG_PARAM_DEFAULT_INPUTS = {
    "seismic": "三级",
    "concrete": "C30",
    "cover": "20mm",
    "slab": "100mm",
}
AUTORECDWG_PARAM_ORDER = ("seismic", "concrete", "cover", "slab")
AUTORECDWG_PARAM_FLAGS = {
    "seismic": "-seismic",
    "concrete": "-concrete",
    "cover": "-cover",
    "slab": "-slab",
}
CAD_REVIEW_FALLBACK_MESSAGE = (
    "当前 Agent 暂无法完成该图纸的校审。建议改用 PKPM 施工图审查 CAD 端继续审查，"
    "其功能更完善，支持梁、柱、墙、板及钢结构等构件的校审。启动方式：在 PKPM 界面选择“施工图&审查”，"
    "再选择相应的 CAD 版本启动。"
)
SEISMIC_LEVEL_TO_VALUE = {
    "特一级": 0,
    "特一": 0,
    "特1级": 0,
    "特1": 0,
    "一级": 1,
    "1级": 1,
    "二级": 2,
    "2级": 2,
    "三级": 3,
    "3级": 3,
    "四级": 4,
    "4级": 4,
    "非抗震": 5,
    "不抗震": 5,
    "无抗震": 5,
}
SEISMIC_VALUE_TO_LABEL = {
    0: "特一级",
    1: "一级",
    2: "二级",
    3: "三级",
    4: "四级",
    5: "非抗震",
}
_FULLWIDTH_DIGIT_TRANS = str.maketrans("０１２３４５６７８９", "0123456789")


def _norm_param_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value).strip().translate(_FULLWIDTH_DIGIT_TRANS))


def parse_seismic_level(value: Any) -> int:
    """Parse seismic construction measure level to AutoRecDwg numeric value 0..5."""
    s = _norm_param_text(value)
    if not s:
        raise ValueError("抗震构造措施等级不能为空")
    if ":" in s or "：" in s:
        s = re.split(r"[:：]", s)[-1]
    if re.fullmatch(r"[0-5]", s):
        return int(s)
    # Match longer/special labels first so “特一级” is not treated as “一级”.
    for label in ("特一级", "特一", "特1级", "特1", "非抗震", "不抗震", "无抗震", "一级", "二级", "三级", "四级", "1级", "2级", "3级", "4级"):
        if label in s:
            return SEISMIC_LEVEL_TO_VALUE[label]
    m = re.search(r"(?<!\d)([0-5])级?(?!\d)", s)
    if m:
        return int(m.group(1))
    raise ValueError(f"无法解析抗震构造措施等级: {value!r}；支持 特一级/一级/二级/三级/四级/非抗震 或 0-5")


def parse_concrete_strength(value: Any) -> int:
    """Parse concrete strength such as C30/c30/30 to AutoRecDwg numeric value 30."""
    s = _norm_param_text(value).upper()
    if not s:
        raise ValueError("混凝土等级不能为空")
    if ":" in s or "：" in s:
        s = re.split(r"[:：]", s)[-1].upper()
    if re.search(r"\d+\.\d+", s):
        raise ValueError(f"混凝土等级必须为整数强度值: {value!r}")
    m = re.fullmatch(r"C?(\d+)", s, flags=re.IGNORECASE)
    if not m:
        raise ValueError(f"无法解析混凝土等级: {value!r}；格式为 C+数字或数字，例如 C30、c30 或 30")
    n = int(m.group(1))
    if n <= 0:
        raise ValueError(f"混凝土等级必须大于 0: {value!r}")
    return n


def parse_positive_int_mm(value: Any, param_name: str) -> int:
    """Parse a millimetre parameter such as 20mm/20 to a positive integer."""
    s = _norm_param_text(value).lower()
    if not s:
        raise ValueError(f"{param_name}不能为空")
    if ":" in s or "：" in s:
        s = re.split(r"[:：]", s)[-1].lower()
    if re.search(r"\d+\.\d+", s):
        raise ValueError(f"{param_name}必须为大于 0 的整数，单位 mm: {value!r}")
    m = re.search(r"(?<!\d)(\d+)(?!\d)", s)
    if not m:
        raise ValueError(f"无法解析{param_name}: {value!r}；示例 20mm 或 20")
    n = int(m.group(1))
    if n <= 0:
        raise ValueError(f"{param_name}必须大于 0mm: {value!r}")
    return n


def parse_autorecdwg_parameters(
    seismic: Any = AUTORECDWG_PARAM_DEFAULT_INPUTS["seismic"],
    concrete: Any = AUTORECDWG_PARAM_DEFAULT_INPUTS["concrete"],
    cover: Any = AUTORECDWG_PARAM_DEFAULT_INPUTS["cover"],
    slab: Any = AUTORECDWG_PARAM_DEFAULT_INPUTS["slab"],
) -> dict[str, int]:
    return {
        "seismic": parse_seismic_level(seismic),
        "concrete": parse_concrete_strength(concrete),
        "cover": parse_positive_int_mm(cover, "保护层厚度"),
        "slab": parse_positive_int_mm(slab, "楼板厚度"),
    }


def display_autorecdwg_parameters(params: dict[str, int]) -> dict[str, str]:
    return {
        "seismic": SEISMIC_VALUE_TO_LABEL.get(int(params["seismic"]), str(params["seismic"])),
        "concrete": f"C{int(params['concrete'])}",
        "cover": f"{int(params['cover'])}mm",
        "slab": f"{int(params['slab'])}mm",
    }


def autorecdwg_parameter_args(params: dict[str, int]) -> list[str]:
    out: list[str] = []
    for key in AUTORECDWG_PARAM_ORDER:
        out.extend([AUTORECDWG_PARAM_FLAGS[key], str(int(params[key]))])
    return out


def autorecdwg_parameter_payload(params: dict[str, int]) -> dict[str, Any]:
    return {
        "numeric": {k: int(params[k]) for k in AUTORECDWG_PARAM_ORDER},
        "display": display_autorecdwg_parameters(params),
    }


@dataclass
class Candidate:
    """定位时考虑过的一个 AutoRecDwg.exe 路径，--locate-only 会把它们全列出来供排查。"""
    source: str        # 这个路径是怎么来的
    version: str       # 对应的 PKPM 版本号；用户直接指定路径时为空
    checker_path: str
    exists: bool

    @classmethod
    def from_path(cls, source: str, version: str, exe: Path) -> "Candidate":
        return cls(source, version, str(exe), exe.exists())


def _absolute_path(path: str | Path) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        return p.resolve(strict=False)
    except Exception:
        return p.absolute()


def _drawing_work_dir(drawing_path: str | Path) -> Path:
    return _absolute_path(drawing_path).parent


def read_text_smart(path: str | Path) -> str:
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gbk", "cp936"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def read_log_json(log_path: str | Path) -> dict[str, Any] | None:
    p = Path(log_path)
    if not p.exists() or not p.is_file():
        return None
    try:
        data = json.loads(read_text_smart(p))
    except Exception:
        return None
    return data if isinstance(data, dict) else {"raw": data}


def resolve_log_path(log_path: Path, value: Any) -> Path | None:
    if not value:
        return None
    p = Path(str(value).strip().strip('"'))
    return p if p.is_absolute() else (log_path.parent / p)


def summarize_db_file(db_path: Path) -> dict[str, Any] | None:
    if not db_path.exists():
        return None
    script_dir = Path(__file__).resolve().parent
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))
    try:
        from mulckdata_query import MulCkDB, list_projects, component_rows  # type: ignore
    except Exception:
        return None
    db = MulCkDB(db_path)
    try:
        projects = list_projects(db)
        drawings = projects.get("projects") or []
        drawing_count = len(drawings)
        review_count = sum(int(d.get("review_count") or 0) for d in drawings)
        component_count = 0
        for d in drawings:
            cut_id = d.get("cut_id")
            if cut_id is None:
                continue
            try:
                component_count += int(component_rows(db, int(cut_id), kind="all").get("total") or 0)
            except Exception:
                pass
        return {
            "source": str(db_path),
            "type": "sqlite",
            "drawing_count": drawing_count,
            "component_count": component_count,
            "review_count": review_count,
        }
    finally:
        db.close()


def summarize_json_file(json_path: Path) -> dict[str, Any] | None:
    if not json_path.exists():
        return None
    script_dir = Path(__file__).resolve().parent
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))
    try:
        from pkpm_json_query import load_payloads, summary_report  # type: ignore
    except Exception:
        return None
    try:
        report = summary_report(load_payloads([json_path]))
    except Exception:
        return None
    return {
        "source": str(json_path),
        "type": "json",
        "drawing_count": report.get("drawing_count", 0),
        "component_count": report.get("component_count", 0),
        "checked_component_count": report.get("checked_component_count", 0),
        "not_checked_component_count": report.get("not_checked_component_count", 0),
        "review_count": report.get("review_count", 0),
        "issue_group_count": report.get("issue_group_count", 0),
    }


def inspect_log_result(log_path: str | Path) -> dict[str, Any]:
    log_path = Path(log_path)
    log = read_log_json(log_path)
    if not log:
        return {"log_exists": log_path.exists(), "log": None}
    status = str(log.get("status", "")).strip().lower()
    output_db = resolve_log_path(log_path, log.get("output_db") or log.get("outputDb"))
    output_json = resolve_log_path(log_path, log.get("output_json") or log.get("outputJson"))
    summary = None
    # JSON carries richer, normalized clause/checktype information; prefer it for default counts.
    if output_json:
        summary = summarize_json_file(output_json)
    if not summary and output_db:
        summary = summarize_db_file(output_db)
    return {
        "log_exists": True,
        "log": log,
        "status": status,
        "success": status == "success",
        "message": log.get("message", ""),
        "dwg": log.get("dwg", ""),
        "output_db": str(output_db) if output_db else "",
        "output_json": str(output_json) if output_json else "",
        "output_db_exists": bool(output_db and output_db.exists()),
        "output_json_exists": bool(output_json and output_json.exists()),
        "summary": summary,
    }


def execution_monitor(returncode: int, log_result: dict[str, Any]) -> dict[str, Any]:
    """将进程结束状态与校审结果分开，供调用方判断是否可以继续读取结果。"""
    process_status = "completed" if returncode == 0 else "abnormal_exit"
    if log_result.get("success"):
        review_status = "success"
    elif log_result.get("log") is not None:
        review_status = "failure"
    else:
        review_status = "unavailable"

    requires_cad_review = process_status != "completed" or review_status != "success"
    return {
        "process_status": process_status,
        "returncode_hex": f"0x{returncode & 0xFFFFFFFF:08X}",
        "review_status": review_status,
        "requires_cad_review": requires_cad_review,
        "agent_message": CAD_REVIEW_FALLBACK_MESSAGE if requires_cad_review else "",
    }


def _version_ge(version: str, floor: str) -> bool:
    """版本号是否不低于下限。位数不一样时短的一方按 0 补齐，"2027.1" 和 "2027.1.0" 算同一版。"""
    ver, low = parse_version(version), parse_version(floor)
    width = max(len(ver), len(low))
    return ver + (0,) * (width - len(ver)) >= low + (0,) * (width - len(low))


def _checker_paths_under_install(install_dir: Path) -> list[Path]:
    """PKPM 安装目录下 AutoRecDwg.exe 的候选路径。"""
    return [install_dir / relative for relative in CHECKER_PATHS_UNDER_INSTALL]


def _checker_paths_from_software_dir(software_dir: str) -> list[Path]:
    r"""把 --software-dir 翻成 AutoRecDwg.exe 的候选路径，按可能性从大到小排。

    用户给的可能是 AutoRecDwg.exe 本身、<安装目录>\Ribbon\PKPMMain.exe、
    <安装目录>\PKPM.exe、PKPM 安装目录，也可能是直接放着 AutoRecDwg.exe 的目录。
    """
    given = Path(software_dir.strip().strip('"'))
    name = given.name.lower()
    if name == CHECKER_FILENAME.lower():
        return [given]
    if name == PKPMMAIN_FILENAME.lower():
        return _checker_paths_under_install(given.parent.parent)
    if name == PKPM_ROOT_FILENAME.lower():
        return _checker_paths_under_install(given.parent)
    return [*_checker_paths_under_install(given), given / CHECKER_FILENAME]


def _not_found_reason(has_candidate: bool, outdated_version: str) -> str:
    """自动定位失败时给用户的说法。

    Args:
        has_candidate: 有没有版本够高的 PKPM 进到候选里
        outdated_version: 版本不够的那些安装中最高的版本号，一个都没有则为空字符串
    """
    if has_candidate:
        return f"已安装的 PKPM 里找不到 {CHECKER_FILENAME}，可能是安装时没有勾选图纸校审模块。"
    if outdated_version:
        return (
            f"本机 PKPM 最高版本为 {outdated_version}，图纸校审需要 "
            f"{MIN_SUPPORTED_VERSION} 及以上版本，请升级后重试。"
        )
    return "未找到 PKPM 软件安装路径，请确认已安装 64 位版本的 PKPM。"


def discover_checker(
    software_dir: str | None = None, explicit_exe: str | None = None
) -> tuple[Path | None, list[Candidate], list[str]]:
    """定位 AutoRecDwg.exe：用户指定的优先，否则在本机已安装的 PKPM 里挑。

    Returns:
        tuple: (exe 路径, 考虑过的候选, 备注)。没找到时 exe 为 None，备注里说明原因。
    """
    def first_existing(candidates: list[Candidate]) -> Path | None:
        return next((Path(c.checker_path) for c in candidates if c.exists), None)

    if explicit_exe:
        candidates = [Candidate.from_path("--exe", "", Path(explicit_exe.strip().strip('"')))]
        return first_existing(candidates), candidates, []

    if software_dir:
        candidates = [
            Candidate.from_path("--software-dir", "", exe)
            for exe in _checker_paths_from_software_dir(software_dir)
        ]
        return first_existing(candidates), candidates, []

    # find_pkpm_installs 已按版本从高到低排好，取第一个版本够高、exe 又确实在的
    candidates = []
    outdated_version = ""  # 版本不够的安装里最高的那个，用来提示用户升级
    for install in find_pkpm_installs():
        if not _version_ge(install.version, MIN_SUPPORTED_VERSION):
            outdated_version = outdated_version or install.version
            continue
        for exe in _checker_paths_under_install(Path(install.path)):
            candidates.append(Candidate.from_path("已安装的 PKPM", install.version, exe))

    found = first_existing(candidates)
    notes = [] if found else [_not_found_reason(bool(candidates), outdated_version)]
    return found, candidates, notes


def run_check(
    exe: Path,
    drawing_path: Path,
    log_path: Path,
    timeout: int | None = None,
    autorecdwg_params: dict[str, int] | None = None,
) -> dict[str, Any]:
    exe = _absolute_path(exe)
    drawing_path = _absolute_path(drawing_path)
    log_path = _absolute_path(log_path)
    if autorecdwg_params is None:
        autorecdwg_params = parse_autorecdwg_parameters()
    work_dir = _drawing_work_dir(drawing_path)
    if not work_dir.exists() or not work_dir.is_dir():
        raise FileNotFoundError(f"图纸所在文件夹不存在: {work_dir}")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists():
        if not log_path.is_file():
            raise ValueError(f"日志路径不是文件: {log_path}")
        log_path.unlink()
    command = [str(exe), str(drawing_path), str(log_path), *autorecdwg_parameter_args(autorecdwg_params)]
    start = time.time()
    process = subprocess.Popen(
        command,
        cwd=str(work_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    wait_timeout = timeout if timeout and timeout > 0 else None
    try:
        stdout, stderr = process.communicate(timeout=wait_timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(command, wait_timeout or 0, output=stdout, stderr=stderr) from None
    log_result = inspect_log_result(log_path)
    result = {
        "exe": str(exe),
        "drawing_path": str(drawing_path),
        "log_path": str(log_path),
        "working_dir": str(work_dir),
        "command": command,
        "autorecdwg_parameters": autorecdwg_parameter_payload(autorecdwg_params),
        "pid": process.pid,
        "returncode": process.returncode,
        "elapsed_seconds": round(time.time() - start, 3),
        "stdout": stdout,
        "stderr": stderr,
        "log_exists": log_path.exists(),
    }
    result["log_result"] = log_result
    result.update(execution_monitor(process.returncode, log_result))
    return result


def print_markdown(data: dict[str, Any]) -> None:
    if data.get("requires_cad_review"):
        print(data.get("agent_message") or CAD_REVIEW_FALLBACK_MESSAGE)
        return
    if data.get("mode") == "locate":
        print(f"AutoRecDwg.exe: `{data.get('exe') or '未找到'}`")
    else:
        print(f"执行文件: `{data.get('exe') or '未找到'}`")
        print(f"图纸路径: `{data.get('drawing_path', '')}`")
        print(f"日志路径: `{data.get('log_path', '')}`")
        if data.get("working_dir"):
            print(f"工作目录: `{data.get('working_dir')}`")
        params = data.get("autorecdwg_parameters") or {}
        display_params = params.get("display") if isinstance(params, dict) else None
        numeric_params = params.get("numeric") if isinstance(params, dict) else None
        if display_params and numeric_params:
            print(
                "校审参数: "
                f"抗震构造措施等级 {display_params.get('seismic')}({numeric_params.get('seismic')})；"
                f"混凝土等级 {display_params.get('concrete')}({numeric_params.get('concrete')})；"
                f"保护层厚度 {display_params.get('cover')}；"
                f"楼板厚度 {display_params.get('slab')}"
            )
        if "returncode" in data:
            print(f"返回码: `{data.get('returncode')}`；日志存在: `{data.get('log_exists')}`")
        process_status = data.get("process_status")
        if process_status:
            if process_status == "completed":
                print("进程状态: **正常结束**")
            elif process_status == "abnormal_exit":
                print(f"进程状态: **异常退出**；Windows 退出码: `{data.get('returncode_hex', '-')}`")
            elif process_status == "timeout":
                print("进程状态: **等待超时，已停止**")
            else:
                print("进程状态: **未启动**")
        log_result = data.get("log_result") or {}
        log = log_result.get("log") if isinstance(log_result, dict) else None
        if log:
            success = log_result.get("success")
            status_text = "审查成功" if success else "审查失败"
            print(f"状态: **{status_text}**；说明: {log_result.get('message') or '-'}")
            if log_result.get("output_db"):
                print(f"详细 SQLite: `{log_result.get('output_db')}`；存在: `{log_result.get('output_db_exists')}`")
            if log_result.get("output_json"):
                print(f"精简 JSON: `{log_result.get('output_json')}`；存在: `{log_result.get('output_json_exists')}`")
            summary = log_result.get("summary") or {}
            if success and summary:
                print(
                    "结果汇总: "
                    f"图纸 {summary.get('drawing_count', 0)} 张；"
                    f"构件 {summary.get('component_count', 0)} 个；"
                    f"审查意见 {summary.get('review_count', 0)} 条"
                )
        elif data.get("log_path"):
            print("状态: 未读取到日志 JSON。")
    candidates = data.get("candidates") or []
    if candidates:
        print("\n| 来源 | PKPM 版本 | AutoRecDwg.exe | 存在 |")
        print("| --- | --- | --- | --- |")
        for c in candidates:
            print(f"| {c.get('source','')} | {c.get('version') or '-'} | `{c.get('checker_path','')}` | {c.get('exists')} |")
    notes = data.get("notes") or []
    if notes:
        print("\n备注：")
        for n in notes:
            print(f"- {n}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Run PKPM AutoRecDwg drawing recognition/check.")
    ap.add_argument("drawing_path", nargs="?", help="图纸路径，可包含空格。调用 exe 时作为第一个参数。")
    ap.add_argument("log_path", nargs="?", help="日志 JSON 路径。调用 exe 时作为第二个参数。")
    ap.add_argument("--software-dir", help="PKPM 软件目录、PKPMMain.exe/PKPM.exe 路径、或包含/指向 AutoRecDwg.exe 的目录。")
    ap.add_argument("--exe", help="直接指定 AutoRecDwg.exe 路径；优先级最高。")
    ap.add_argument("--timeout", type=int, default=0, help="等待 exe 结束的超时秒数；0 表示不限制。")
    ap.add_argument("--seismic", default=AUTORECDWG_PARAM_DEFAULT_INPUTS["seismic"], help="抗震构造措施等级：特一级/一级/二级/三级/四级/非抗震，或 0-5；默认 三级。")
    ap.add_argument("--concrete", default=AUTORECDWG_PARAM_DEFAULT_INPUTS["concrete"], help="混凝土强度等级：C 可省略且不区分大小写，如 C30/c30/30；默认 C30。")
    ap.add_argument("--cover", default=AUTORECDWG_PARAM_DEFAULT_INPUTS["cover"], help="保护层厚度，单位 mm，大于 0 的整数；默认 20mm。")
    ap.add_argument("--slab", default=AUTORECDWG_PARAM_DEFAULT_INPUTS["slab"], help="楼板厚度，单位 mm，大于 0 的整数；默认 100mm。")
    ap.add_argument("--locate-only", action="store_true", help="只定位 AutoRecDwg.exe，不执行校审。")
    ap.add_argument("--dry-run", action="store_true", help="输出将执行的命令，不真正启动 exe。")
    ap.add_argument("--format", choices=["markdown", "json"], default="markdown")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    exe, candidates, notes = discover_checker(args.software_dir, args.exe)
    base = {
        "exe": str(exe) if exe else None,
        "candidates": [asdict(c) for c in candidates],
        "notes": notes,
    }
    if args.locate_only:
        base["mode"] = "locate"
        if args.format == "json":
            print(json.dumps(base, ensure_ascii=False, indent=2))
        else:
            print_markdown(base)
        return 0 if exe else 2

    if not args.drawing_path or not args.log_path:
        print("drawing_path 和 log_path 为必填位置参数；或使用 --locate-only 只定位 exe。", file=sys.stderr)
        return 2
    drawing_path = Path(args.drawing_path)
    log_path = Path(args.log_path)
    try:
        autorecdwg_params = parse_autorecdwg_parameters(args.seismic, args.concrete, args.cover, args.slab)
    except ValueError as exc:
        if args.format == "json":
            print(json.dumps({**base, "drawing_path": str(drawing_path), "log_path": str(log_path), "error": str(exc)}, ensure_ascii=False, indent=2))
        else:
            print(f"参数错误: {exc}", file=sys.stderr)
        return 2
    base.update({
        "drawing_path": str(drawing_path),
        "log_path": str(log_path),
        "autorecdwg_parameters": autorecdwg_parameter_payload(autorecdwg_params),
    })

    if not exe:
        if args.format == "json":
            print(json.dumps({**base, "error": "AutoRecDwg.exe not found"}, ensure_ascii=False, indent=2))
        else:
            print_markdown({**base, "error": "AutoRecDwg.exe not found"})
        return 3

    if args.dry_run:
        run_exe = _absolute_path(exe)
        run_drawing_path = _absolute_path(drawing_path)
        run_log_path = _absolute_path(log_path)
        work_dir = _drawing_work_dir(run_drawing_path)
        base["mode"] = "dry-run"
        base["exe"] = str(run_exe)
        base["drawing_path"] = str(run_drawing_path)
        base["log_path"] = str(run_log_path)
        base["working_dir"] = str(work_dir)
        base["working_dir_exists"] = work_dir.exists() and work_dir.is_dir()
        base["command"] = [str(run_exe), str(run_drawing_path), str(run_log_path), *autorecdwg_parameter_args(autorecdwg_params)]
        if args.format == "json":
            print(json.dumps(base, ensure_ascii=False, indent=2))
        else:
            print_markdown(base)
            print("\n将执行命令：")
            print(" ".join(f'\"{x}\"' if " " in x else x for x in base["command"]))
        return 0

    try:
        result = run_check(exe, drawing_path, log_path, args.timeout, autorecdwg_params)
    except subprocess.TimeoutExpired as exc:
        result = {
            **base,
            "error": f"timeout after {args.timeout}s",
            "process_status": "timeout",
            "review_status": "unavailable",
            "requires_cad_review": True,
            "agent_message": CAD_REVIEW_FALLBACK_MESSAGE,
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
        }
        rc = 124
    except Exception as exc:
        result = {
            **base,
            "error": str(exc),
            "process_status": "not_started",
            "review_status": "unavailable",
            "requires_cad_review": True,
            "agent_message": CAD_REVIEW_FALLBACK_MESSAGE,
        }
        rc = 1
    else:
        result = {**base, **result}
        if result.get("requires_cad_review"):
            # 进程正常结束但校审失败时也返回非零，避免调用方误判为成功。
            rc = int(result.get("returncode") or 4)
        else:
            rc = 0

    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_markdown(result)
        if not result.get("requires_cad_review") and result.get("stdout"):
            print("\nstdout:")
            print(result["stdout"])
        if not result.get("requires_cad_review") and result.get("stderr"):
            print("\nstderr:")
            print(result["stderr"])
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
