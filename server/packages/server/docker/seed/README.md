# docker/seed — mock CNPE LDAP 种子

- `generate.py`：从员工导入模板 xlsx 生成 `employees.csv` 与 `seed.ldif`（OU 树 + 用户）。
- `employees.csv` / `seed.ldif`：**生成产物，含真实员工信息，已 gitignore 不入库**。
  新环境先放好模板再执行 `python seed/generate.py`（自动在仓库 `docs/` 下定位
  `*员工导入模板*.xlsx`），然后 `docker compose up -d`（osixia/openldap 首启自动加载 seed.ldif）。
- 验证：`docker exec reactor-ldap ldapsearch -x -H ldap://localhost:389 -D cn=admin,dc=cnpe,dc=cc -w admin123 -b ou=cnpe,dc=cnpe,dc=cc "(objectClass=inetOrgPerson)" uid | grep -c '^uid:'` → 应为 807。
