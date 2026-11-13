"""NDJSON JSON-RPC 传输层。

协议（见 docs/未完成-知识库-sidecar-与检索链路-spec-v1.md §4.2）：

* 一行一个 JSON，``\\n`` 分隔；
* **stdout 只输出协议行**，日志一律走 stderr —— 混进 stdout 会让 Node 侧解析失败
  （dwg-tools 的 sidecar 踩过这个坑，这里从一开始就隔离）；
* 请求可并发：按 ``id`` 回包，不保证顺序；
* 单行上限 8 MiB，超限按协议错误处理，不尝试恢复。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import traceback
from collections.abc import Awaitable, Callable
from typing import Any

# 单行上限：知识库请求里最大的是检索 query 与上传路径，8 MiB 足够。
MAX_LINE_BYTES = 8 * 1024 * 1024

PROTOCOL_VERSION = 1

logger = logging.getLogger("knowledge_sidecar.transport")

Handler = Callable[[dict[str, Any]], Awaitable[Any]]


class ProtocolError(Exception):
    """请求本身不合法（缺 id / 缺 method / JSON 解析失败）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RpcServer:
    """按 method 分发的异步 NDJSON 服务器。"""

    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}
        self._stopping = asyncio.Event()

    def register(self, method: str, handler: Handler) -> None:
        if method in self._handlers:
            raise ValueError(f"method 重复注册：{method}")
        self._handlers[method] = handler

    def stop(self) -> None:
        self._stopping.set()

    async def serve(self) -> None:
        """读 stdin 逐行分发，写 stdout 回包。

        stdin 关闭（Node 侧退出）时结束循环并返回 —— 不调用 sys.exit，
        交给入口函数决定退出码。
        """
        loop = asyncio.get_running_loop()
        pending: set[asyncio.Task[None]] = set()

        while not self._stopping.is_set():
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                # EOF：Node 侧关闭了 stdin。
                break
            stripped = line.strip()
            if not stripped:
                continue
            if len(stripped.encode("utf-8")) > MAX_LINE_BYTES:
                await self._write(
                    {
                        "id": None,
                        "ok": False,
                        "error": {
                            "code": "LINE_TOO_LARGE",
                            "message": f"请求行超过 {MAX_LINE_BYTES} 字节上限",
                        },
                    }
                )
                continue
            task = asyncio.create_task(self._dispatch(stripped))
            pending.add(task)
            task.add_done_callback(pending.discard)

        if pending:
            # 给在途请求一个收口窗口；不强杀，避免写出半截响应。
            await asyncio.gather(*pending, return_exceptions=True)

    async def _dispatch(self, raw: str) -> None:
        request_id: Any = None
        try:
            try:
                request = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ProtocolError("BAD_JSON", f"请求不是合法 JSON：{exc}") from exc

            if not isinstance(request, dict):
                raise ProtocolError("BAD_REQUEST", "请求必须是 JSON 对象")

            request_id = request.get("id")
            if request_id is None:
                raise ProtocolError("MISSING_ID", "请求缺少 id")

            method = request.get("method")
            if not isinstance(method, str) or not method:
                raise ProtocolError("MISSING_METHOD", "请求缺少 method")

            handler = self._handlers.get(method)
            if handler is None:
                raise ProtocolError("UNKNOWN_METHOD", f"未知方法：{method}")

            params = request.get("params") or {}
            if not isinstance(params, dict):
                raise ProtocolError("BAD_PARAMS", "params 必须是 JSON 对象")

            result = await handler(params)
            await self._write({"id": request_id, "ok": True, "result": result})
        except ProtocolError as exc:
            await self._write(
                {"id": request_id, "ok": False, "error": {"code": exc.code, "message": exc.message}}
            )
        except Exception as exc:  # noqa: BLE001 — 单请求失败不能拖垮常驻进程
            logger.error("handler 异常：\n%s", traceback.format_exc())
            await self._write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": getattr(exc, "code", "INTERNAL"),
                        "message": str(exc) or exc.__class__.__name__,
                    },
                }
            )

    async def _write(self, payload: dict[str, Any]) -> None:
        """写一行到 stdout 并立即 flush —— 不 flush 会让 Node 侧一直等。"""
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def emit_ready() -> None:
    """握手信号：Node 侧收到它才算启动成功。"""
    sys.stdout.write(json.dumps({"type": "ready", "version": PROTOCOL_VERSION}) + "\n")
    sys.stdout.flush()
