"""后台索引 worker：轮询 kb_jobs 并执行解析 / 嵌入。

## 为什么要有独立线程

解析一个 PDF 可能要几秒到几十秒。放在 RPC 处理函数里同步做，会让
`kb.upload` 阻塞几十秒 —— 而前端上传后立刻要刷新列表，用户体验是「卡住」。

所以：upload 只登记 + 排 job 就返回；worker 在独立线程里慢慢消化。

## 单线程而非线程池

SQLite 的写锁是库级（即使 WAL，同一时刻只有一个写者）。多线程消费
只会让它们互相排队，还增加 `database is locked` 的风险。
单线程串行处理最简单可靠；要并行时应该按库分库（每库一个 DB 已经是这样，
将来可以每库一线程）。

## 生命周期

- 随 sidecar 启动，随 stdin EOF / SIGTERM 停止；
- 空闲时 200ms 轮询一次（可配），有活时立即继续；
- 单作业失败不影响后续作业（记录到 kb_jobs.last_error）。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .pipeline import (
    claim_job,
    finish_job,
    pending_parse_jobs,
    run_parse_job,
)
from .store import KnowledgeStore, StorageError

logger = logging.getLogger("knowledge_sidecar.worker")

# 空闲轮询间隔：200ms 足够让「上传 → 列表显示处理中」几乎无感，
# 又不至于空转吃 CPU。
IDLE_POLL_SECONDS = 0.2


class IndexWorker:
    def __init__(self, store: KnowledgeStore) -> None:
        self._store = store
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="kb-index-worker", daemon=True)
        self._thread.start()
        logger.info("index worker 已启动")

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)
            if thread.is_alive():
                logger.warning("index worker 未在 %.1fs 内退出", timeout)
        self._thread = None
        logger.info("index worker 已停止")

    def _run(self) -> None:
        while not self._stop.is_set():
            worked = False
            try:
                worked = self._drain_once()
            except Exception:  # noqa: BLE001 — worker 不能因单个异常退出
                logger.error("worker 循环异常", exc_info=True)
            if not worked:
                # 没活时休眠；用 Event.wait 以便 stop 能立即打断
                self._stop.wait(IDLE_POLL_SECONDS)

    def _drain_once(self) -> bool:
        """扫所有库，各取一小批待办。返回是否做过事。"""
        did_work = False
        for base in self._all_bases():
            kb_id = base["id"]
            try:
                jobs = pending_parse_jobs(self._store, kb_id, limit=5)
            except StorageError:
                # 库在扫描过程中被删掉了，跳过
                continue
            for job in jobs:
                if self._stop.is_set():
                    return did_work
                if not claim_job(self._store, kb_id, job["id"]):
                    continue  # 已被别的消费者抢走
                did_work = True
                self._execute(kb_id, job)
        return did_work

    def _execute(self, kb_id: str, job: dict[str, str]) -> None:
        job_id = job["id"]
        kind = job["kind"]
        doc_pk = job["doc_id"]
        try:
            if kind == "parse":
                if not doc_pk:
                    finish_job(self._store, kb_id, job_id, ok=False, error="作业缺 doc_id")
                    return
                outcome = run_parse_job(self._store, kb_id, doc_pk)
                finish_job(
                    self._store,
                    kb_id,
                    job_id,
                    ok=outcome.ok,
                    error=outcome.error,
                )
            elif kind == "embed":
                # P0-c 实现；当前只把这些作业标记为跳过，避免永久 queued
                finish_job(
                    self._store,
                    kb_id,
                    job_id,
                    ok=False,
                    error="embedding 尚未实现（P0-c）",
                )
            else:
                finish_job(self._store, kb_id, job_id, ok=False, error=f"未知作业类型：{kind}")
        except Exception as exc:  # noqa: BLE001
            logger.error("作业执行失败 kb=%s job=%s", kb_id, job_id, exc_info=True)
            try:
                finish_job(self._store, kb_id, job_id, ok=False, error=str(exc))
            except Exception:  # noqa: BLE001
                pass

    def _all_bases(self) -> list[dict[str, Any]]:
        with self._store.central() as conn:
            rows = conn.execute("SELECT id FROM kb_bases").fetchall()
        return [{"id": row["id"]} for row in rows]
