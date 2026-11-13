"""RPC 外观层：把 EvoFlow 的完整 service API 暴露给 Node 侧。

> **来源**：方法签名对照 EvoFlow `owned/service.py`（3320 行，76 个函数）+
> `owned/wiki.py` + `owned/kg.py`。本文件只做**参数搬运与错误归一化**，
> 业务逻辑一行不写 —— 全部转调移植过来的实现。

## 为什么要有这一层

移植过来的 service 直接用 Python 关键字参数 + dict，而 RPC 传进来的是
`dict[str, Any]`。中间需要一个薄适配：把 `params.get("kbId")` 喂给
`list_documents(kb_id)` 这类调用，同时把 `ValueError` / `StorageError`
统一成带 `code` 的错误，让 Node 侧能区分「库不存在」和「参数错了」。

## 为什么不直接改 service.py

改了它，将来再同步 EvoFlow 更新就会冲突。保持移植代码**原样**，
适配放在这一层，是这类「外来代码接入」的标准做法。
"""

from __future__ import annotations

import logging
from typing import Any

from . import kg as kg_store
from . import service as svc
from . import wiki as wiki_store
from knowledge_sidecar.store import StorageError

logger = logging.getLogger("knowledge_sidecar.owned_api")


def _require(params: dict[str, Any], key: str) -> str:
    value = str(params.get(key) or "").strip()
    if not value:
        raise StorageError("MISSING_PARAM", f"{key} 不能为空")
    return value


def _safe_path(params: dict[str, Any], key: str) -> str:
    """文件夹路径校验：拒绝 `..` / `.` / 空段 / 绝对路径。

    sidecar 的文件夹是**逻辑路径**（存进 kb_documents.folder_path），不是真实
    文件系统路径，所以理论上穿越不了。但它会被拼进 `<kb>/blobs/<doc>/...`
    这类真实路径，且前端展示时会当地址用 —— 放行 `..` 等于给未来的路径
    拼接留后门。在入口挡掉最省事。
    """
    raw = str(params.get(key) or "").replace("\\", "/").strip().strip("/")
    if raw:
        for part in raw.split("/"):
            if part in ("", ".", ".."):
                raise StorageError("INVALID_PATH", f"非法文件夹路径：{raw}")
    return raw


def _opt(params: dict[str, Any], key: str, default: str = "") -> str:
    value = params.get(key)
    return default if value is None else str(value)


def _int(params: dict[str, Any], key: str, default: int) -> int:
    raw = params.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise StorageError("INVALID_PARAM", f"{key} 必须是整数") from exc


def _bool(params: dict[str, Any], key: str, default: bool = False) -> bool:
    raw = params.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


# ── 库（base）────────────────────────────────────────────────────────────


def list_bases(_params: dict[str, Any]) -> dict[str, Any]:
    return {"bases": svc.list_bases()}


def create_base(params: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "name": _require(params, "name"),
        "description": _opt(params, "description"),
    }
    for key in (
        "embeddingModel",
        "embeddingDim",
        "contentMode",
        "chunkSize",
        "chunkOverlap",
        "chunkStrategy",
        "vectorEnabled",
        "keywordEnabled",
        "summaryEnabled",
        "wikiEnabled",
        "graphEnabled",
    ):
        if key in params and params[key] is not None:
            payload[key] = params[key]
    return {"base": svc.create_base(payload)}


def get_base(params: dict[str, Any]) -> dict[str, Any]:
    kb_id = _require(params, "kbId")
    base = svc.get_base(kb_id)
    if base is None:
        raise StorageError("KB_NOT_FOUND", f"知识库不存在：{kb_id}")
    return {"base": base}


def update_base(params: dict[str, Any]) -> dict[str, Any]:
    kb_id = _require(params, "kbId")
    payload = {k: v for k, v in params.items() if k not in {"kbId", "id"}}
    return {"base": svc.update_base(kb_id, payload)}


def delete_base(params: dict[str, Any]) -> dict[str, Any]:
    svc.delete_base(_require(params, "kbId"))
    return {"deleted": True}


def reindex_base(params: dict[str, Any]) -> dict[str, Any]:
    return svc.reindex_base(
        _require(params, "kbId"),
        embedding_model_ref=params.get("embeddingModelRef"),
        force=_bool(params, "force"),
    )


def retry_document(params: dict[str, Any]) -> dict[str, Any]:
    return svc.retry_document_parse(
        _require(params, "kbId"), _require(params, "docId")
    )


# ── 文档 ─────────────────────────────────────────────────────────────────


def list_documents(params: dict[str, Any]) -> dict[str, Any]:
    return {"docs": svc.list_documents(_require(params, "kbId"))}


def get_document(params: dict[str, Any]) -> dict[str, Any]:
    doc_id = _opt(params, "docId")
    kb_id = _opt(params, "kbId")
    doc = svc.resolve_document(kb_id, doc_id) if kb_id else svc.get_document(doc_id)
    if doc is None:
        raise StorageError("DOC_NOT_FOUND", f"文档不存在：{doc_id}")
    return {"doc": doc}


def get_document_content(params: dict[str, Any]) -> dict[str, Any]:
    doc_id = _require(params, "docId")
    content = svc.get_document_content(doc_id, max_chars=_int(params, "maxChars", 500_000))
    if content is None:
        raise StorageError("DOC_NOT_FOUND", f"文档不存在：{doc_id}")
    return {"content": content}


def update_document_content(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "doc": svc.replace_document_content(
            _require(params, "docId"),
            _opt(params, "content"),
            title=params.get("title"),
        )
    }


def upload_manual_markdown(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "doc": svc.upload_manual_markdown(
            _require(params, "kbId"),
            title=_opt(params, "title") or "未命名",
            content=_opt(params, "content"),
            folder_path=_opt(params, "folderPath"),
        )
    }


def list_chunks(params: dict[str, Any]) -> dict[str, Any]:
    return {"chunks": svc.list_chunks(_require(params, "docId"))}


def delete_document(params: dict[str, Any]) -> dict[str, Any]:
    svc.delete_document(_require(params, "docId"))
    return {"deleted": True}


def resolve_document_file(params: dict[str, Any]) -> dict[str, Any]:
    info = svc.resolve_document_file(_require(params, "docId"))
    if info is None:
        raise StorageError("DOC_NOT_FOUND", "文档或原始文件不存在")
    return {"file": info}


# ── 文件夹 ───────────────────────────────────────────────────────────────


def list_folders(params: dict[str, Any]) -> dict[str, Any]:
    return {"folders": svc.list_folders(_require(params, "kbId"))}


def create_folder(params: dict[str, Any]) -> dict[str, Any]:
    return {"folder": svc.create_folder(_require(params, "kbId"), _safe_path(params, "path"))}


def rename_folder(params: dict[str, Any]) -> dict[str, Any]:
    # rename_folder(kb_id, from_path, to_path) —— to_path 是完整新路径，
    # 不是「新名字」。前端传的是什么就转什么，不要在这里拼路径。
    return {
        "folder": svc.rename_folder(
            _require(params, "kbId"),
            _safe_path(params, "path"),
            _safe_path(params, "newPath"),
        )
    }


def move_folder(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "folder": svc.move_folder(
            _require(params, "kbId"),
            _safe_path(params, "fromPath"),
            _safe_path(params, "parentPath"),
        )
    }


def delete_folder(params: dict[str, Any]) -> dict[str, Any]:
    # 移植实现的 mode 只有两种语义（不是 recursive）：
    #   move_up     —— 删文件夹元数据，文档上移到父目录（默认，最安全）
    #   delete_docs —— 连同文档一起软删
    mode = _opt(params, "mode", "move_up") or "move_up"
    if mode not in ("move_up", "delete_docs"):
        raise StorageError(
            "INVALID_MODE", "mode 必须是 move_up 或 delete_docs"
        )
    return {
        "deleted": svc.delete_folder(
            _require(params, "kbId"),
            _safe_path(params, "path"),
            mode=mode,
        )
    }


def move_document(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "doc": svc.move_document(
            _require(params, "docId"), _safe_path(params, "folderPath")
        )
    }


# ── 同步 / 导入 ──────────────────────────────────────────────────────────


def preview_local_folder_sync(params: dict[str, Any]) -> dict[str, Any]:
    return svc.preview_local_folder_sync(
        _require(params, "kbId"), params.get("root")
    )


def preview_resync_base(params: dict[str, Any]) -> dict[str, Any]:
    return svc.preview_resync_base(_require(params, "kbId"))


def import_local_folder(params: dict[str, Any]) -> dict[str, Any]:
    return svc.import_local_folder(
        _require(params, "kbId"),
        _require(params, "sourcePath"),
        upsert=_bool(params, "upsert", True),
        prune_missing=_bool(params, "pruneMissing"),
        folder_prefix=_opt(params, "folderPrefix"),
    )


def resync_base(params: dict[str, Any]) -> dict[str, Any]:
    return svc.resync_base(
        _require(params, "kbId"), prune_missing=_bool(params, "pruneMissing")
    )


# ── 检索 / 问答 ──────────────────────────────────────────────────────────


async def search(params: dict[str, Any]) -> dict[str, Any]:
    return await svc.search(
        _opt(params, "kbId"),
        _require(params, "query"),
        mode=_opt(params, "mode", "hybrid") or "hybrid",
        top_k=_int(params, "topK", 8),
        tags=params.get("tags") if isinstance(params.get("tags"), list) else None,
    )


async def search_all(params: dict[str, Any]) -> dict[str, Any]:
    return await svc.search_all(
        _require(params, "query"),
        mode=_opt(params, "mode", "hybrid") or "hybrid",
        top_k=_int(params, "topK", 8),
        tags=params.get("tags") if isinstance(params.get("tags"), list) else None,
        kb_ids=params.get("kbIds") if isinstance(params.get("kbIds"), list) else None,
    )


async def ask(params: dict[str, Any]) -> dict[str, Any]:
    return await svc.ask(
        _require(params, "kbId"),
        _require(params, "query"),
        doc_id=params.get("docId"),
        top_k=_int(params, "topK", 6),
        model_name=params.get("modelName"),
    )


# ── 统计 / 任务 / 活动 ───────────────────────────────────────────────────


def get_status(params: dict[str, Any]) -> dict[str, Any]:
    """库状态：文档数 + 健康度 + 向量统计 + 作业概况。

    EvoFlow 的 owned/service.py 没有独立的 `get_status`（那是 dataset 版 service 的
    函数），它把这几项分摊在 `list_bases` / `_vector_stats` / `job_stats` 里。
    这里负责把它们拼成一个前端一次就能拿全的响应。

    [坑] `_vector_stats` 返回的键是 `totalChunks` / `embeddedChunks`，
    不是 `chunks` / `embeddings`。早期按后者取值，导致「文档明明索引成功，
    统计里 chunks 永远是 0」，前端会误判成索引失败。
    """
    kb_id = _require(params, "kbId")
    base = svc.get_base(kb_id)
    if base is None:
        raise StorageError("KB_NOT_FOUND", f"知识库不存在：{kb_id}")

    # list_bases 会补 documentCount / documentHealth（跨库统计它已经算好了）
    enriched = next(
        (b for b in svc.list_bases() if str(b.get("id")) == kb_id),
        base,
    )
    documents = svc.list_documents(kb_id)
    vector = svc._vector_stats(  # noqa: SLF001 — 无公开替代，仅读取统计
        kb_id,
        model=str(base.get("embeddingModel") or ""),
        dim=base.get("embeddingDim"),
    )
    total_chunks = int(vector.get("totalChunks") or 0)
    embedded = int(vector.get("embeddedChunks") or 0)
    return {
        "kbId": kb_id,
        "documents": enriched.get("documentCount", len(documents)),
        "documentHealth": enriched.get("documentHealth", {}),
        "chunks": total_chunks,
        "embeddings": embedded,
        "vectorDim": base.get("embeddingDim"),
        "vectorReady": bool(vector.get("vectorized")),
        "vectorStatus": vector.get("status", "missing"),
        "jobs": svc.job_stats(kb_id),
    }


def job_stats(params: dict[str, Any]) -> dict[str, Any]:
    return svc.job_stats(_require(params, "kbId"))


def get_job(params: dict[str, Any]) -> dict[str, Any]:
    job = svc.get_job(_require(params, "jobId"))
    if job is None:
        raise StorageError("JOB_NOT_FOUND", "作业不存在")
    return {"job": job}


def list_jobs(params: dict[str, Any]) -> dict[str, Any]:
    states = params.get("states")
    return {
        "jobs": svc.list_jobs(
            _require(params, "kbId"),
            limit=_int(params, "limit", 50),
            states=[str(s) for s in states] if isinstance(states, list) else None,
        )
    }


def list_activities(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "activities": svc.list_activities(
            kb_id=_require(params, "kbId"),
            limit=_int(params, "limit", 50),
            before=params.get("before"),
        )
    }


def list_tags(params: dict[str, Any]) -> dict[str, Any]:
    return {"tags": svc.list_tags(_require(params, "kbId"))}


def get_document_links(params: dict[str, Any]) -> dict[str, Any]:
    links = svc.get_document_links(_require(params, "docId"))
    if links is None:
        raise StorageError("DOC_NOT_FOUND", "文档不存在")
    return {"links": links}


def doc_graph(params: dict[str, Any]) -> dict[str, Any]:
    return svc.doc_graph(
        _require(params, "kbId"),
        center_doc_id=params.get("centerDocId"),
        depth=_int(params, "depth", 1),
    )


def enqueue_document_summary(params: dict[str, Any]) -> dict[str, Any]:
    return svc.enqueue_document_summary(
        _require(params, "docId"), force=_bool(params, "force")
    )


# ── 上传（走文件路径，不走 base64）────────────────────────────────────────


def upload_file(params: dict[str, Any]) -> dict[str, Any]:
    """上传：Node 侧把文件落到 incoming/ 后传路径进来，这里读字节再交给 service。

    为什么不走 base64：大文件（几百 MB 的 PDF）base64 后体积膨胀 33%，
    而且要让整份内容穿过 stdin 管道，会把 NDJSON 通道堵住。
    """
    from pathlib import Path

    path = Path(_require(params, "filePath"))
    if not path.is_file():
        raise StorageError("FILE_NOT_FOUND", f"文件不存在：{path}")
    rel_path = _opt(params, "relPath") or path.name
    return svc.upload_bytes(
        _require(params, "kbId"),
        file_name=Path(rel_path).name,
        data=path.read_bytes(),
        folder_path=_opt(params, "folderPath"),
        title=_opt(params, "title"),
    )


# ── 设置 ─────────────────────────────────────────────────────────────────
#
# 知识库设置是**全局**的（不像库级开关写在 kb_bases 里）：
# - primary：默认用「自建库」还是「内置库」
# - defaultEmbeddingModel：新建库时预选的向量模型
# - chatModel：问答/摘要用的对话模型
# - summaryDefaultEnabled：新建库是否默认开启自动摘要
#
# 实现直接转调 EvoFlow 移植过来的 `owned/settings.py`，那边已经把这套
# 读写与默认值回退逻辑写好了（含 registry 解析）。


def get_settings(_params: dict[str, Any]) -> dict[str, Any]:
    from knowledge_sidecar.owned import settings as kb_settings

    return kb_settings.settings_payload()


def _set_settings(params: dict[str, Any]) -> dict[str, Any]:
    from knowledge_sidecar.owned import settings as kb_settings

    # 逐项可选更新：只处理请求里出现的键，避免「没传就清空」。
    if "primary" in params and params["primary"] is not None:
        kb_settings.set_primary(str(params["primary"]))
    if "defaultEmbeddingModel" in params:
        raw = params["defaultEmbeddingModel"]
        kb_settings.set_default_embedding_model(
            None if raw is None else str(raw)
        )
    if "chatModel" in params:
        raw = params["chatModel"]
        kb_settings.set_chat_model(None if raw is None else str(raw))
    if "summaryDefaultEnabled" in params and params["summaryDefaultEnabled"] is not None:
        kb_settings.set_default_summary_enabled(bool(params["summaryDefaultEnabled"]))
    return kb_settings.settings_payload()


# ── Wiki ─────────────────────────────────────────────────────────────────


def list_wiki_pages(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "pages": wiki_store.list_pages(
            _require(params, "kbId"), page_type=params.get("pageType")
        )
    }


def get_wiki_page(params: dict[str, Any]) -> dict[str, Any]:
    kb_id = _require(params, "kbId")
    slug = _opt(params, "slug")
    page = wiki_store.get_page(kb_id, slug) if slug else wiki_store.get_page_by_id(
        _require(params, "pageId")
    )
    if page is None:
        raise StorageError("PAGE_NOT_FOUND", "Wiki 页面不存在")
    return {"page": page}


def update_wiki_page(params: dict[str, Any]) -> dict[str, Any]:
    # upsert_page 的参数全是 keyword-only，位置传参会 TypeError。
    return {
        "page": wiki_store.upsert_page(
            kb_id=_require(params, "kbId"),
            slug=_require(params, "slug"),
            title=_opt(params, "title") or _opt(params, "slug"),
            body_md=_opt(params, "bodyMd"),
            page_type=_opt(params, "pageType", "manual") or "manual",
            edit_source="manual",
            editor_id=_opt(params, "editorId", "local") or "local",
        )
    }


def get_wiki_graph(params: dict[str, Any]) -> dict[str, Any]:
    return wiki_store.graph_payload(_require(params, "kbId"))


def list_wiki_folders(params: dict[str, Any]) -> dict[str, Any]:
    return {"folders": wiki_store.list_folders(_require(params, "kbId"))}


# ── 知识图谱（KG）────────────────────────────────────────────────────────


def list_kg_nodes(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "nodes": kg_store.list_nodes(
            _require(params, "kbId"), limit=_int(params, "limit", 200)
        )
    }


def get_kg_graph(params: dict[str, Any]) -> dict[str, Any]:
    return kg_store.graph_payload(
        _require(params, "kbId"),
        center=params.get("center"),
        limit=_int(params, "limit", 80),
    )


def get_kg_stats(params: dict[str, Any]) -> dict[str, Any]:
    return kg_store.stats(_require(params, "kbId"))


# ── 注册表：RPC 方法名 → 处理函数 ────────────────────────────────────────
#
# 方法名沿用 EvoFlow 前端的既有契约（`kb_bases.*` / `kb_docs.*` / `kb_wiki.*`），
# 这样前端 `kb-api.ts` 那 56 个方法不用改一行 —— 它们本来就是按这套名字写的。

REGISTRY: dict[str, Any] = {
    # 库
    "kb.list": list_bases,
    "kb.create": create_base,
    "kb.get": get_base,
    "kb.update": update_base,
    "kb.delete": delete_base,
    "kb.reindex": reindex_base,
    "kb.retryDoc": retry_document,
    # 文档
    "kb.listDocs": list_documents,
    "kb.getDoc": get_document,
    "kb.readDoc": get_document_content,
    "kb.updateDocContent": update_document_content,
    "kb.listChunks": list_chunks,
    "kb.deleteDoc": delete_document,
    "kb.docFile": resolve_document_file,
    "kb.upload": upload_file,
    "kb.createManual": upload_manual_markdown,
    # 文件夹
    "kb.folder.list": list_folders,
    "kb.folder.create": create_folder,
    "kb.folder.rename": rename_folder,
    "kb.folder.move": move_folder,
    "kb.folder.delete": delete_folder,
    "kb.doc.move": move_document,
    # 同步
    "kb.sync.preview": preview_local_folder_sync,
    "kb.sync.previewResync": preview_resync_base,
    "kb.sync.import": import_local_folder,
    "kb.sync.resync": resync_base,
    # 设置
    "kb.settings.get": get_settings,
    "kb.settings.set": _set_settings,
    # 检索
    "kb.search": search,
    "kb.searchAll": search_all,
    "kb.ask": ask,
    # 统计
    "kb.stats": get_status,
    "kb.jobStats": job_stats,
    "kb.job": get_job,
    "kb.listJobs": list_jobs,
    "kb.listActivities": list_activities,
    "kb.listTags": list_tags,
    "kb.docLinks": get_document_links,
    "kb.docGraph": doc_graph,
    "kb.summary": enqueue_document_summary,
    # Wiki
    "kb.wiki.list": list_wiki_pages,
    "kb.wiki.get": get_wiki_page,
    "kb.wiki.update": update_wiki_page,
    "kb.wiki.graph": get_wiki_graph,
    "kb.wiki.folders": list_wiki_folders,
    # 图谱
    "kb.kg.nodes": list_kg_nodes,
    "kb.kg.graph": get_kg_graph,
    "kb.kg.stats": get_kg_stats,
}

__all__ = ["REGISTRY"]
