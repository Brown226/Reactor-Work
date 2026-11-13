"""sidecar 入口：解析参数、建 store、注册方法、跑事件循环。

启动方式（Node 侧见 ``packages/services/src/knowledge/knowledgeClient.ts``）：

.. code-block:: sh

    python3 -m knowledge_sidecar --data-root /path/to/knowledge

约定：

* 启动成功后先输出一行 ``{"type":"ready","version":1}`` 再进入请求循环；
* stdout 只走协议，日志全部 stderr（spec §4.2）；
* 收到 SIGTERM / stdin EOF 时优雅退出，退出码 0。
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from .handlers import KnowledgeHandlers
from . import VERSION as _PKG_VERSION
from .store import KnowledgeStore
from .transport import RpcServer, emit_ready
from .worker import IndexWorker

VERSION = _PKG_VERSION


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="knowledge_sidecar")
    parser.add_argument(
        "--data-root",
        required=True,
        help="知识库数据根目录（含 owned.sqlite 与 kb_<id>/）",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("KNOWLEDGE_LOG_LEVEL", "INFO"),
        help="stderr 日志级别，默认 INFO",
    )
    # 模型服务：走 ZCODE_KNOWLEDGE_* 环境变量（spec §4.4），不设命令行参数，
    # 避免凭据出现在进程命令行（ps 可见）。
    return parser.parse_args(argv)


def _configure_logging(level: str) -> None:
    # 日志必须写 stderr：stdout 是协议通道，混进去会让 Node 侧解析失败。
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        stream=sys.stderr,
        format="[knowledge-sidecar] %(levelname)s %(name)s: %(message)s",
    )


async def _run(data_root: Path) -> int:
    store = KnowledgeStore(data_root)
    handlers = KnowledgeHandlers(store, VERSION)

    # 索引 worker：解析/嵌入在独立线程里做，不阻塞 RPC
    worker = IndexWorker(store)
    worker.start()

    server = RpcServer()
    server.register("kb.ping", handlers.ping)
    server.register("kb.list", handlers.list)
    server.register("kb.create", handlers.create)
    server.register("kb.update", handlers.update)
    server.register("kb.delete", handlers.delete)
    server.register("kb.upload", handlers.upload)
    server.register("kb.listDocs", handlers.list_docs)
    server.register("kb.deleteDoc", handlers.delete_doc)
    server.register("kb.job", handlers.job)
    server.register("kb.listJobs", handlers.list_jobs)
    server.register("kb.search", handlers.search)
    server.register("kb.readDoc", handlers.read_doc)
    server.register("kb.stats", handlers.stats)
    server.register("kb.retryDoc", handlers.retry_doc)
    server.register("kb.reindex", handlers.reindex)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, server.stop)
        except NotImplementedError:
            # Windows 上 add_signal_handler 不可用，靠 stdin EOF 退出。
            pass

    logging.getLogger("knowledge_sidecar").info(
        "ready: version=%s dataRoot=%s", VERSION, data_root
    )
    emit_ready()
    try:
        await server.serve()
    finally:
        # 先停 worker 再退出：避免它正在写 SQLite 时进程被 SIGTERM 打断，
        # 留下半截 chunk 或锁。
        worker.stop()
    logging.getLogger("knowledge_sidecar").info("shutdown")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    _configure_logging(args.log_level)
    data_root = Path(args.data_root).expanduser().resolve()
    try:
        return asyncio.run(_run(data_root))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
