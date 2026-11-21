#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Open the packaged offline report_designer.html for Word report export.

The script starts a tiny local HTTP server so the HTML can load local JS libs
and the built-in DOCX template reliably. All startup defaults are passed by URL
query parameters; no extra startup files are written.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import mimetypes
import os
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse
import webbrowser

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DESIGNER_DIR = SKILL_DIR / "assets" / "report_designer"
HTML_NAME = "report_designer.html"
DEFAULT_TEMPLATE_NAME = "PKPM校审清单模板示例.docx"
LOCAL_FILE_ENDPOINT = "/__pkpm_local_file__"
ALLOWED_LOCAL_FILE_SUFFIXES = {
    ".json",
    ".docx",
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
    ".webp",
    ".svg",
}

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


def output_json_from_log(log_path: str | Path) -> Path | None:
    from pkpm_json_query import output_json_from_log as _impl  # type: ignore
    return _impl(log_path)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def path_for_url(path_value: str | Path) -> str:
    p = Path(path_value).expanduser()
    try:
        return str(p.resolve(strict=False))
    except Exception:
        return str(p)


def collect_json_paths(args: argparse.Namespace) -> list[str]:
    paths: list[str] = []
    for raw in args.json or []:
        p = Path(raw).expanduser()
        if not p.exists():
            raise SystemExit("JSON 文件不存在：" + str(p))
        paths.append(path_for_url(p))
    if args.from_log:
        p = output_json_from_log(args.from_log)
        if p:
            if not p.exists():
                raise SystemExit("log 指向的 JSON 文件不存在：" + str(p))
            paths.append(path_for_url(p))
    for raw in args.default_json_path or []:
        paths.append(path_for_url(raw))
    # Preserve order while de-duplicating.
    return list(dict.fromkeys(paths))


def build_url(port: int, args: argparse.Namespace) -> tuple[str, list[str]]:
    template_path = Path(args.template).expanduser() if args.template else DESIGNER_DIR / DEFAULT_TEMPLATE_NAME
    if args.template and not template_path.exists():
        raise SystemExit("模板文件不存在：" + str(template_path))
    template_value = path_for_url(template_path) if args.template else DEFAULT_TEMPLATE_NAME

    params: list[tuple[str, str]] = [("template", template_value)]
    json_paths = collect_json_paths(args)
    params.extend(("jsonPath", p) for p in json_paths)

    url_fields = [
        ("projectName", args.project_name),
        ("projectCode", args.project_code),
        ("stage", args.stage),
        ("reviewer", args.reviewer),
        ("designLead", args.design_lead),
        ("designer", args.designer),
        ("outputName", args.output_name),
    ]
    params.extend((name, value) for name, value in url_fields if value)

    query = urlencode(params)
    return f"http://127.0.0.1:{port}/{HTML_NAME}?{query}", json_paths


class ReportDesignerHandler(http.server.SimpleHTTPRequestHandler):
    """Static report designer server plus a local-file endpoint for URL defaults."""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003 - stdlib signature
        return

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        parsed = urlparse(self.path)
        if parsed.path == LOCAL_FILE_ENDPOINT:
            self._serve_local_file(parsed.query)
            return
        super().do_GET()

    def _serve_local_file(self, query: str) -> None:
        path_value = parse_qs(query).get("path", [""])[0]
        if not path_value:
            self.send_error(400, "missing path")
            return

        try:
            file_path = Path(path_value).expanduser().resolve(strict=True)
        except Exception:
            self.send_error(404, "file not found")
            return

        if not file_path.is_file() or file_path.suffix.lower() not in ALLOWED_LOCAL_FILE_SUFFIXES:
            self.send_error(404, "file not allowed")
            return

        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if file_path.suffix.lower() == ".json":
            content_type = "application/json; charset=utf-8"
        elif file_path.suffix.lower() == ".docx":
            content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

        try:
            content = file_path.read_bytes()
        except Exception:
            self.send_error(500, "read failed")
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)


def run_server(port: int) -> None:
    handler = functools.partial(ReportDesignerHandler, directory=str(DESIGNER_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.serve_forever()


def start_server(port: int) -> subprocess.Popen[Any]:
    cmd = [sys.executable, str(Path(__file__).resolve()), "--serve", "--port", str(port)]
    kwargs: dict[str, Any] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(cmd, **kwargs)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Open packaged PKPM report designer for Word export.")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="append", help="CheckList.json 路径，可多次传入；会拼接为多个 jsonPath URL 参数")
    parser.add_argument("--default-json-path", action="append", help="默认 JSON 路径，可多次传入；会拼接为多个 jsonPath URL 参数")
    parser.add_argument("--from-log", help="识别校审 log.json 路径，从 output_json 字段读取 CheckList.json")
    parser.add_argument("--template", help=f"可选自定义 .docx 模板；不传则使用内置 {DEFAULT_TEMPLATE_NAME}")
    parser.add_argument("--project-name")
    parser.add_argument("--project-code")
    parser.add_argument("--stage")
    parser.add_argument("--reviewer")
    parser.add_argument("--design-lead")
    parser.add_argument("--designer")
    parser.add_argument("--output-name", help="Word 导出默认文件名，不含 .docx")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open", action="store_true", help="只启动本地服务并打印 URL，不打开浏览器")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.serve:
        run_server(args.port)
        return 0

    html = DESIGNER_DIR / HTML_NAME
    if not html.exists():
        raise SystemExit("离线报告网页未打包：" + str(html))
    port = args.port or free_port()
    url, json_paths = build_url(port, args)
    proc = start_server(port)
    if not args.no_open:
        webbrowser.open(url)
    print("已启动 PKPM Word 报告导出网页")
    print(f"URL: {url}")
    print(f"Server PID: {proc.pid}")
    if json_paths:
        print(f"已通过 URL 参数设置 JSON 路径: {len(json_paths)} 个")
        for p in json_paths:
            print(f"- {p}")
    else:
        print("已直接打开报告设计器 URL；在网页中选择 CheckList.json 后生成并导出 Word")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
