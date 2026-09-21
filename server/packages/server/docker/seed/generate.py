#!/usr/bin/env python3
"""从员工导入模板 xlsx 生成 seed 产物（mock CNPE LDAP + 平台 CSV）。

用法:
    python generate.py <员工导入模板.xlsx>

输出到本目录:
    employees.csv   —— 平台「CSV/模板导入」与 ldif 生成的同源数据（UTF-8）
    seed.ldif       —— osixia/openldap 首启自动加载（OU 树 + 用户）
                       顶层 ou=cnpe 挂在 LDAP_DOMAIN 生成的 dc=cnpe,dc=cc 下

口径（与 docs/实施计划/第1批-身份底座-公司口径与测试期方案.md 一致）:
  - 一级/二级部门 → OU 两级树；三级列本期为空（模板无）
  - 用户 uid=登录账号, cn/sn/displayName=真实姓名, mail=邮箱(按列原样，不推断)
  - userPassword = 模板密码列(测试占位 123456)；角色本期全 USER 不落 LDAP

DN 约定（最具体在前）:
  ou=河北分公司,ou=cnpe,dc=cnpe,dc=cc
  ou=设计管理部,ou=河北分公司,ou=cnpe,dc=cnpe,dc=cc
  uid=luct,ou=设计管理部,ou=河北分公司,ou=cnpe,dc=cnpe,dc=cc
"""
import csv
import sys
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
SUFFIX = ",ou=cnpe,dc=cnpe,dc=cc"  # 一级部门挂在 ou=cnpe 之下


def esc(v: str) -> str:
    return (
        str(v)
        .replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\0", "\\0")
    )


def ou_dn(parts: list[str]) -> str:
    """部门树路径（根→叶）→ 该部门 OU 的 DN（叶在前）。"""
    rdns = ",".join(f"ou={esc(p)}" for p in reversed(parts))
    return rdns + SUFFIX


def main(xlsx_path: str) -> None:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb["Sheet1"]
    rows = list(ws.iter_rows(values_only=True))
    header, data = rows[0], rows[1:]
    assert header[0] == "登录账号", f"模板列头不符: {header}"

    csv_path = HERE / "employees.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(list(header))
        for r in data:
            w.writerow(r)

    declared: set[str] = set()
    out: list[str] = []

    # 顶层 ou=cnpe（一级部门的父，挂在 dc=cnpe,dc=cc 下）
    out.append(
        f"dn: ou=cnpe,dc=cnpe,dc=cc\n"
        f"objectClass: organizationalUnit\n"
        f"ou: cnpe\n"
    )
    declared.add(("cnpe",))

    def ensure_ou(parts: list[str]) -> None:
        for i in range(1, len(parts) + 1):
            sub = tuple(parts[:i])
            if sub in declared:
                continue
            declared.add(sub)
            out.append(
                f"dn: {ou_dn(list(sub))}\n"
                f"objectClass: organizationalUnit\n"
                f"ou: {esc(parts[i - 1])}\n"
            )

    n = 0
    for r in data:
        login, name, pwd, _role, d1, d2, d3, mail = (list(r) + [None] * 8)[:8]
        parts = [p for p in (d1, d2, d3) if p]
        if not parts:
            continue
        ensure_ou(parts)
        user_dn = ",".join([f"uid={esc(login)}"] + [f"ou={esc(p)}" for p in reversed(parts)]) + SUFFIX
        attrs = [
            f"dn: {user_dn}",
            "objectClass: top",
            "objectClass: person",
            "objectClass: organizationalPerson",
            "objectClass: inetOrgPerson",
            "objectClass: uidObject",
            f"cn: {esc(name)}",
            f"sn: {esc(name)}",
            f"displayName: {esc(name)}",
            f"uid: {esc(login)}",
        ]
        if mail:
            attrs.append(f"mail: {esc(mail)}")
        attrs.append(f"userPassword: {esc(pwd or '')}")
        out.append("\n".join(attrs) + "\n")
        n += 1

    ldif_path = HERE / "seed.ldif"
    ldif_path.write_text("\n".join(out), encoding="utf-8")
    print(f"OK users={n} ous={len(declared)}")
    print(f"  csv : {csv_path}")
    print(f"  ldif: {ldif_path}")


def auto_find_template() -> Path:
    """自动在仓库 docs/ 下定位员工导入模板（避免 argv 中文在 Windows 被截断）。"""
    repo = HERE.parents[3]  # …/packages/server/docker/seed -> …/Reactor-Desktop
    hits = list(repo.joinpath("docs").rglob("*员工导入模板*.xlsx"))
    if not hits:
        sys.exit(f"未找到员工导入模板: {repo}/docs/**/员工导入模板*.xlsx")
    if len(hits) > 1:
        print("命中多个模板，取第一个:", hits)
    return hits[0]


if __name__ == "__main__":
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else auto_find_template()
    main(str(xlsx))
