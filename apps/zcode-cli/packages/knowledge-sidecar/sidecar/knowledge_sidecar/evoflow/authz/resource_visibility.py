"""`evoflow.authz.resource_visibility` 的等价实现。

P0 单用户：所有资源都可见。P1 接多租户时这里要换成真正的可见性判断
（spec §9.3 明确权限判断应落在 services 层，sidecar 只做兜底）。
"""

from __future__ import annotations

from typing import Any


def owner_scope_visible_to_principal(*_args: Any, **_kwargs: Any) -> bool:
    return True


__all__ = ["owner_scope_visible_to_principal"]
