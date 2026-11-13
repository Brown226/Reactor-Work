#!/usr/bin/env python3
"""端到端验证：建库 → 上传 → 解析 → 嵌入 → 检索。

跑法（在仓库根目录）：

    set -a && . .secrets/siliconflow.env && set +a
    ZCODE_KNOWLEDGE_MODEL_BASE_URL="$SILICONFLOW_BASE_URL" \
    ZCODE_KNOWLEDGE_MODEL_API_KEY="$SILICONFLOW_API_KEY" \
    ZCODE_KNOWLEDGE_EMBEDDING_MODEL="$SILICONFLOW_EMBEDDING_MODEL" \
    ZCODE_KNOWLEDGE_RERANK_MODEL="$SILICONFLOW_RERANK_MODEL" \
    python3 scripts/dev/knowledge-e2e.py
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "apps/zcode-cli/packages/knowledge-sidecar/sidecar"))

from knowledge_sidecar.handlers import KnowledgeHandlers  # noqa: E402
from knowledge_sidecar.models import client_from_env  # noqa: E402
from knowledge_sidecar.pipeline import run_embed_job, run_parse_job  # noqa: E402
from knowledge_sidecar.store import KnowledgeStore  # noqa: E402

DOC_SPEC = """# 建筑工程施工质量验收规范

本标准规定了建筑工程施工质量的验收要求，适用于新建、扩建和改建工程。

## 3.1 材料进场验收

所有进场材料必须具有出厂合格证明文件，并按规定进行抽样复验。
复验不合格的材料不得使用，且应在 24 小时内清退出场。

## 3.2 隐蔽工程验收

隐蔽工程需要在覆盖前完成验收，并留存影像资料。未经验收擅自覆盖的，
监理单位有权要求剥露检查，费用由施工单位承担。

## 3.3 竣工验收

单位工程完工后，施工单位应当自检合格后向建设单位提交竣工验收报告。
建设单位收到报告后应当组织有关单位进行验收，验收合格后方可交付使用。

## 4.1 质量责任

| 责任主体 | 主要职责 | 违约责任 |
| --- | --- | --- |
| 施工单位 | 按图施工、自检 | 返工并承担费用 |
| 监理单位 | 旁站监督、验收 | 承担连带责任 |
| 建设单位 | 组织验收 | 不得强行交付 |

## 5.1 罚则

未按本规范执行的，责令限期整改；逾期未整改的，处以合同价款 2% 至 5% 的罚款。
"""

DOC_FAQ = """# 差旅报销常见问题

## 出差住宿标准

一线城市每人每晚不超过 600 元，二线城市不超过 400 元，其他城市不超过 300 元。

## 报销时限

出差结束后 15 个工作日内提交报销单，逾期需要部门负责人书面说明理由。

## 交通费

高铁二等座据实报销，飞机经济舱需提前审批，市内交通按每天 100 元包干。
"""


async def main() -> int:
    client = client_from_env()
    if client is None:
        print("✗ 未配置模型服务，跳过检索验证")
        return 2
    print(f"模型服务：embedding={client.embedding_model} rerank={client.has_rerank}")

    root = Path(tempfile.mkdtemp(prefix="kb-e2e-"))
    try:
        store = KnowledgeStore(root)
        handlers = KnowledgeHandlers(store, "e2e", client)

        # ── 建库 ──────────────────────────────────────────────────────
        base = (await handlers.create(
            {
                "name": "规范与FAQ",
                "description": "端到端验证",
                "embeddingModel": client.embedding_model,
                "embeddingDim": 1024,
            }
        ))["base"]
        kb_id = base["id"]
        print(f"✓ 建库 {kb_id}")

        # ── 上传（模拟：直接落 blob + 建文档行）──────────────────────────
        doc_ids: list[str] = []
        for name, content in (("规范.md", DOC_SPEC), ("FAQ.md", DOC_FAQ)):
            doc_pk = f"doc_{name.replace('.', '_')}"
            # blob 约定：<kb>/blobs/<doc_pk>/<file_name>（与 handlers.upload 一致）
            blob_dir = store.kb_blobs_dir(kb_id) / doc_pk
            blob_dir.mkdir(parents=True, exist_ok=True)
            (blob_dir / name).write_text(content, encoding="utf-8")
            with store.kb_conn(kb_id) as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO kb_documents
                      (id, doc_id, title, file_name, rel_path, content_hash,
                       byte_size, parse_status, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,'pending',?,?)
                    """,
                    (
                        doc_pk,
                        doc_pk,
                        name.removesuffix(".md"),
                        name,
                        f"{name}",
                        "e2e",
                        len(content),
                        "2026-01-01T00:00:00+00:00",
                        "2026-01-01T00:00:00+00:00",
                    ),
                )
            doc_ids.append(doc_pk)

        # ── 解析 ──────────────────────────────────────────────────────
        for doc_pk in doc_ids:
            outcome = run_parse_job(store, kb_id, doc_pk, chunk_size=200, chunk_overlap=60)
            print(f"✓ 解析 {doc_pk}: ok={outcome.ok} chunks={outcome.chunks}")
            if not outcome.ok:
                print(f"  ✗ {outcome.error}")
                return 1

        # ── 嵌入 ──────────────────────────────────────────────────────
        t0 = time.monotonic()
        for doc_pk in doc_ids:
            outcome = run_embed_job(store, kb_id, doc_pk, client=client, model=client.embedding_model)
            print(f"✓ 嵌入 {doc_pk}: ok={outcome.ok} chunks={outcome.chunks}")
            if not outcome.ok:
                print(f"  ✗ {outcome.error}")
                return 1
        print(f"  嵌入耗时 {time.monotonic() - t0:.2f}s")

        stats = await handlers.stats({"kbId": kb_id})
        print(f"✓ 统计 documents={stats['documents']} chunks={stats['chunks']} embeddings={stats['embeddings']}")

        # ── 检索 ──────────────────────────────────────────────────────
        cases = [
            ("材料复验不合格怎么处理", "规范"),
            ("隐蔽工程覆盖前要做什么", "规范"),
            ("住宿费标准多少钱", "FAQ"),
            ("报销要多久内提交", "FAQ"),
            ("罚款比例是多少", "规范"),
        ]
        print("\n=== 检索验证 ===")
        passed = 0
        for query, expect in cases:
            t0 = time.monotonic()
            result = await handlers.search({"kbId": kb_id, "query": query, "topK": 3})
            elapsed = (time.monotonic() - t0) * 1000
            items = result["items"]
            if not items:
                print(f"✗ {query!r} → 无结果")
                continue
            top = items[0]
            title = top.get("title") or top.get("fileName") or ""
            ok = expect in title
            passed += 1 if ok else 0
            mark = "✓" if ok else "✗"
            print(
                f"{mark} {query!r} → {title} "
                f"(rrf={top.get('rrfScore')} vec={top.get('vectorScore')} "
                f"kw={top.get('keywordScore')} degraded={result['degraded']}) {elapsed:.0f}ms"
            )
            print(f"    首位片段：{top.get('content', '')[:60]!r}")

        # ── 各模式对比 ────────────────────────────────────────────────
        print("\n=== 模式对比（查询：住宿标准）===")
        for mode in ("keyword", "vector", "hybrid", "title"):
            result = await handlers.search(
                {"kbId": kb_id, "query": "住宿标准", "topK": 2, "mode": mode}
            )
            titles = [i.get("title") for i in result["items"]]
            print(f"  {mode:8s} → {titles} degraded={result['degraded']}")

        # ── ask ───────────────────────────────────────────────────────
        print("\n=== ask 验证 ===")
        answer = await handlers.ask({"kbId": kb_id, "query": "竣工验收要谁组织", "topK": 3})
        print(f"  来源数={len(answer['sources'])} 上下文长度={len(answer['context'])}")
        print(f"  首来源：{answer['sources'][0]['title']} / {answer['sources'][0]['contextHeader']}")

        print(f"\n检索通过 {passed}/{len(cases)}")
        return 0 if passed == len(cases) else 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
