"""sidecar 入口：解析参数、初始化存储、注册方法、跑事件循环。

启动方式（Node 侧见 ``packages/services/src/knowledge/knowledgeClient.ts``）：

.. code-block:: sh

    python3 -m knowledge_sidecar --data-root /path/to/knowledge

约定：

* 启动成功后先输出一行 ``{"type":"ready","version":1}`` 再进入请求循环；
* stdout 只走协议，日志全部 stderr（spec §4.2）；
* 收到 SIGTERM / stdin EOF 时优雅退出，退出码 0。

## 两套实现的共存关系

本 sidecar 有两层：

1. **`owned/` 下的移植层**（EvoFlow `knowledge/owned/`，约 9000 行）——
   完整能力：库/文档/文件夹/Wiki/图谱/同步/活动流/作业状态机。
   这是**主路径**，`owned.owned_api.REGISTRY` 里的 46 个方法都走它。
2. **顶层 `handlers.py`**（本仓自写，约 700 行）—— 早期实现，只覆盖
   「建库/上传/解析/检索」最小闭环。保留它是因为 `owned/` 的 worker 与本仓
   的 worker 调度方式不同，热切换有风险；并且它能作为移植层的对照实现。

注册顺序上 `owned` 先注册、`handlers` 后注册会冲突（同名方法只能注册一次），
所以这里**以 owned 为准**，handlers 只补 owned 没有的方法。
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from . import VERSION as _PKG_VERSION
from .env_bridge import apply_env_bridge
from .evoflow.config import paths as evo_paths
from .handlers import KnowledgeHandlers
from .models import client_from_env
from .owned.owned_api import REGISTRY as OWNED_REGISTRY
from .store import KnowledgeStore
from .transport import RpcServer, emit_ready
from .worker import IndexWorker

VERSION = _PKG_VERSION

logger = logging.getLogger("knowledge_sidecar")


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
    # 移植代码按 EvoFlow 的变量名读凭据，本仓用 ZCODE_ 前缀。
    # 启动期做一次映射，避免改上游代码（见 env_bridge.py 的说明）。
    apply_env_bridge()

    # 移植层（owned/）通过 evoflow.config.paths 拿根目录，必须先初始化，
    # 否则它所有 `xxx_root()` 调用都会抛「兼容层未初始化」。
    evo_paths.set_base_dir(data_root)

    store = KnowledgeStore(data_root)

    # 模型服务客户端：从 ZCODE_KNOWLEDGE_* 环境变量读配置。
    # 没配就返回 None —— 此时仍可建库/上传/解析/关键词检索，只是没有向量
    # （spec §4.4 语义降级），不要把「没配模型」当成启动失败。
    model_client = client_from_env()
    if model_client is None:
        logger.warning(
            "未配置模型服务（ZCODE_KNOWLEDGE_MODEL_BASE_URL），"
            "向量检索不可用，关键词检索正常"
        )

    handlers = KnowledgeHandlers(store, VERSION, model_client)

    # 索引 worker：解析/嵌入在独立线程里做，不阻塞 RPC
    worker = IndexWorker(store, model_client)
    worker.start()

    server = RpcServer()

    # ① 移植层（完整能力，46 个方法）
    for method, handler in OWNED_REGISTRY.items():
        server.register(method, handler)

    # ② 本仓自写层：只补 owned 没有的方法，避免重复注册
    legacy = {
        "kb.ping": handlers.ping,
    }
    for method, handler in legacy.items():
        if method not in OWNED_REGISTRY:
            server.register(method, handler)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, server.stop)
        except NotImplementedError:
            # Windows 上 add_signal_handler 不可用，靠 stdin EOF 退出。
            pass

    logger.info(
        "ready: version=%s dataRoot=%s methods=%d",
        VERSION,
        data_root,
        len(OWNED_REGISTRY) + len(legacy),
    )
    emit_ready()
    try:
        await server.serve()
    finally:
        # 先停 worker 再退出：避免它正在写 SQLite 时进程被 SIGTERM 打断，
        # 留下半截 chunk 或锁。
        worker.stop()
    logger.info("shutdown")
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
