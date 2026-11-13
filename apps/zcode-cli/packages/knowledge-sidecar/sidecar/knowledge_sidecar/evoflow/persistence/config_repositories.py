"""`evoflow.persistence.config_repositories` 的等价实现：知识库设置的持久化。

## 为什么需要真实现

早期版本这里是**空实现**（读恒返回默认值、写直接丢弃），因为以为「本仓没有
设置库，这些开关不重要」。但知识库设置有四项是用户可见的：

- 新建库默认是否开启自动摘要
- 默认向量模型 / 对话模型
- 主库来源（自建 / 内置）

空实现导致一个具体 bug：设置面板里打开开关 → 保存成功提示 → 刷新后**又变回
关闭**（写入被丢弃，读取拿默认值）。所以必须落地。

## 存在哪

`<data-root>/settings.json` —— 与 owned.sqlite 同级，跟随数据根迁移。
不放 SQLite 的原因：这些是**极低频写、整份读**的配置（一共不到 10 个键），
用 JSON 文件最简单，也便于用户手工排查。

## 并发

单用户单进程（sidecar），写入用「读-改-写 + 原子替换」，不需要文件锁。
`_lock` 只防同一进程内的线程竞争（worker 线程也可能写）。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger("knowledge_sidecar.app_settings")

_lock = threading.RLock()
_cache: dict[str, Any] | None = None

FILE_NAME = "settings.json"


def _settings_path() -> Path:
    """设置文件路径。必须在 `paths.set_base_dir()` 之后调用。"""
    from knowledge_sidecar.evoflow.config.paths import resolve_base_dir

    return resolve_base_dir() / FILE_NAME


def _load() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    path = _settings_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        _cache = data if isinstance(data, dict) else {}
    except FileNotFoundError:
        _cache = {}
    except (OSError, json.JSONDecodeError) as exc:
        # 文件损坏不能阻断启动：记一笔，按空配置继续（用户可在面板里重设）。
        logger.warning("设置文件读取失败，按空配置继续：%s", exc)
        _cache = {}
    return _cache


def _save(data: dict[str, Any]) -> None:
    """原子写入：先写临时文件再 rename，避免写一半断电留下损坏的 JSON。"""
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".settings-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_name, path)
    except BaseException:
        # 失败要清掉临时文件，否则数据目录会积一堆 .settings-*.tmp
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def get_app_setting(key: str, default: Any = None) -> Any:
    """读一个 app 设置。不存在时返回 default。"""
    with _lock:
        return _load().get(key, default)


def set_app_setting(key: str, value: Any) -> None:
    """写一个 app 设置。"""
    with _lock:
        data = dict(_load())
        data[key] = value
        _save(data)
        _cache_commit(data)


def _cache_commit(data: dict[str, Any]) -> None:
    global _cache
    _cache = data


def reset_cache_for_tests() -> None:
    """测试用：丢掉进程缓存，下次读取重新读盘。"""
    global _cache
    with _lock:
        _cache = None


def all_settings() -> dict[str, Any]:
    """整份设置（调试/诊断用）。"""
    with _lock:
        return dict(_load())


__all__ = [
    "all_settings",
    "get_app_setting",
    "reset_cache_for_tests",
    "set_app_setting",
]
