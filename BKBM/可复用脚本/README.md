# 可复用脚本（按类别整理）

来源：PKPM Agent 2.5.7 明文脚本
整理日期：2026-11-18

| 目录 | 说明 | 处理方式 |
|---|---|---|
| A可直接用 | 零 PKPMAgent 依赖、零外部软件调用 | 复制即用 |
| B小改可用 | 依赖第三方库（pypcae/win32com等） | 装依赖即可 |
| C需改写 | 调用了编译层的连接函数 | 自己实现连接层 |
| D换一行 | 仅因 vault.connect_db 解密库 | 改成 sqlite3.connect |

## D 类通用替换

```python
# 原
from PKPMAgent.skill_kit.vault import connect_db
conn = connect_db(DB_PATH)

# 改
import sqlite3
conn = sqlite3.connect(DB_PATH)
```

API 库已解密在 `../decrypted/db/`。

## 优先看这几个

- A/mulckdata_query.py (1667行) — 施工图审查解析
- A/preflight_analysis_spec.py (823行) — 计算前预检
- B/evaluate_result_evidence.py (736行) — 结果证据闸门
- C/IndustryCorridor.py (747行) — 通廊桁架建模
- B/PKPMCAE 示例 43 个 — 复杂结构 Python 描述范本
