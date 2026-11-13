"""`evoflow.authz.principals` 的等价实现。

本仓 P0 是单用户本地库，没有 principal 概念。返回一个固定的本地管理员，
让移植代码里「补 owner_scope_id」的逻辑有个稳定的值可写。
"""

from __future__ import annotations

_LOCAL_ADMIN_ID = "local"


def get_or_create_local_admin() -> dict[str, str]:
    return {"principal_id": _LOCAL_ADMIN_ID, "display_name": "本机用户"}


__all__ = ["get_or_create_local_admin"]
