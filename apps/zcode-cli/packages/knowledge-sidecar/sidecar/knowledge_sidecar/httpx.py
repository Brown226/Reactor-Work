"""`httpx` 的最小兼容实现（仅覆盖 EvoFlow embedding 层用到的 API）。

## 为什么要有这个文件

移植过来的 `embedding/cloud_provider.py` 用 `httpx.AsyncClient` 发请求。
本仓刻意只打包纯 Python 依赖、不引入额外运行时（spec §2.2），而 httpx 会拖
httpcore/h11/anyio/sniffio 一整套。实际用到的 API 面很窄（`AsyncClient.post` +
几个异常类型），用标准库 `urllib` 在**线程池里跑同步请求**就能等价实现。

## 行为差异（有意为之）

- 不支持连接池复用：每次请求新建连接。embedding 是批量低频调用，
  这点开销远小于多打一个 HTTP 库的体积。
- 不支持重定向自动跟随之外的高级特性（stream / HTTP2 / proxy）。
  这些 EvoFlow 那边也没用到。

## 什么时候该换成真 httpx

如果将来要支持流式响应、HTTP/2 或连接复用，直接 `pip install httpx` 并把
本文件删掉即可 —— 对上层是透明的，因为它们只依赖同名 API。
"""

from __future__ import annotations

import asyncio
import json as _json
import urllib.error
import urllib.request

__all__ = [
    "AsyncClient",
    "ConnectError",
    "HTTPError",
    "Response",
    "TimeoutException",
]


class HTTPError(Exception):
    """所有 HTTP 层错误的基类，与 httpx 同名。"""


class TimeoutException(HTTPError):
    """请求超时。"""


class ConnectError(HTTPError):
    """建连失败（DNS / 端口不可达 / TLS 握手失败）。"""


class Response:
    """最小响应对象：只提供 status_code / text / json()。"""

    def __init__(self, status_code: int, content: bytes) -> None:
        self.status_code = status_code
        self.content = content

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> object:
        return _json.loads(self.text)


def _request_sync(
    url: str,
    payload: dict[str, object],
    headers: dict[str, str],
    timeout: float,
) -> Response:
    """同步 POST。放在线程里跑，避免阻塞事件循环。"""
    body = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return Response(response.status, response.read())
    except urllib.error.HTTPError as exc:
        # HTTPError 也带响应体 —— 上游用它读错误详情，必须保留
        return Response(exc.code, exc.read() or b"")
    except TimeoutError as exc:
        raise TimeoutException(str(exc)) from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, TimeoutError):
            raise TimeoutException(str(reason)) from exc
        raise ConnectError(str(reason)) from exc
    except OSError as exc:
        raise ConnectError(str(exc)) from exc


class AsyncClient:
    """`httpx.AsyncClient` 的最小子集。

    用法与 httpx 一致：

    .. code-block:: python

        async with AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=payload, headers=headers)
    """

    def __init__(self, *, timeout: float = 60.0, **_ignored: object) -> None:
        self._timeout = float(timeout)

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def aclose(self) -> None:
        return None

    async def post(
        self,
        url: str,
        *,
        json: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Response:
        return await asyncio.to_thread(
            _request_sync,
            url,
            json or {},
            headers or {},
            self._timeout if timeout is None else float(timeout),
        )
