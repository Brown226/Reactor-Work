# 标准清单 Excel 导入 / 筛重 / 导出 — 实施规范（STD-IO）

> 状态：已与大王对齐（2026-10-19），四项决策全部取推荐项。实现前先读本文，实现后按 §7 验收。
> 影响面：`packages/server/src/standards/{routes,repo}.ts`、`packages/admin/src/{services/standards.ts,pages/Standards.tsx}`。
> **后端新增 `exceljs` 依赖**（server workspace）——原 `routes.ts` 头注「不为它引入 exceljs」的前提是「调用方是运维脚本」，本需求把调用方改成浏览器运维人员，前提失效，依赖随之必要。

## 1. 背景与目标

标准清单（`standard` 表，现 13445 条）原只有 **JSON 批量导入**一个写入入口，调用方定位是运维脚本。现在管理员要在管理台上直接操作，要求三件事：

1. **Excel 模板导入**：替代「导入 JSON」，上传固定模板的 `.xlsx` 由服务端解析；
2. **入库筛重**：重复行不静默入库，导入前给出明细，人工确认后才写库；
3. **数据导出**：按当前页面筛选条件导出为同模板 `.xlsx`，可改完再导回。

约束不变：标准库是**治理数据**，全部写操作限 `platform_admin`；导入必须可重跑、不得越灌越多。

## 2. Excel 模板定义（唯一契约，改动即破坏前后数据一致性）

单 sheet，**第 1 行表头，第 2 行起数据**，共 8 列，顺序固定：

| # | 列名 | 必填 | 对应表列 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 标准编号 | 是 | `standard_no` | 如 `GB/T 50001-2017` |
| 2 | 标准名称 | 是 | `standard_name` | |
| 3 | 状态 | 否 | `status` | **填中文**：现行 / 即将实施 / 已废止 / 未标注；空 = 未标注 |
| 4 | 分类 | 否 | `category` | 如 `材料/冶金` |
| 5 | 发布日期 | 否 | `publish_date` | `YYYY-MM-DD` |
| 6 | 实施日期 | 否 | `implement_date` | `YYYY-MM-DD`` |
| 7 | 废止日期 | 否 | `abolish_date` | `YYYY-MM-DD` |
| 8 | 替换信息 | 否 | `replace_info` | 源清单原文，形如 `替换:CB/T1033-1999;;` |

**不入模板的列**：`ident`（标识符前缀）由 `standard_no` 经 `resolveIdent()` 自动解析，服务端不接受外部写入（沿用现有语义）；`id` / `created_at` / `updated_at` 是库内部字段。

状态中文 → 规范串复用 `normalizeStatus()`（`routes.ts` 已有，同义异形如「废止/已废止」在此归一），**不写第二套映射**。

## 3. 筛重口径

**`(standard_no, standard_name)` 二元组相等即重复**，与 `uq_standard_no_name` 唯一索引严格一致。

理由（`schema.ts` 原注释，勿改）：同一编号在源清单里存在多版本行（如 `GB 150-1998` 现行 + 废止两行），只按编号去重会静默丢掉状态，自检因此报不出「该条已废止」。**不得**改成只按编号判重。

重复判定分两个层次，缺一不可：

- **文件内去重**：同一 Excel 内出现相同二元组，只保留首次出现的一行，后续行计入「文件内重复」；
- **与库中去重**：文件内去重后的键再与 `standard` 表现有行比对，命中的计入「库中已存在」。

## 4. 接口契约

### 4.1 预检 `POST /admin/standards/import-excel`

- Content-Type: `multipart/form-data`，字段名 `file`，仅接受 `.xlsx`（拒绝 `.xls`/`.csv`，避免两套解析路径）。
- 上限 10MB（xlsx 压缩比高，13445 行约 1MB 量级；JSON 入口的 64MB 不适用于此）。
- 服务端：解析 → 表头校验 → 行净化（trim、状态归一、日期格式校验、乱码 U+FFFD 拦截）→ 文件内去重 → 与库中比对。

响应：

```ts
{
  received: number;      // Excel 数据行总数（不含表头与空行）
  valid: number;         // 净化后可用行数
  willInsert: number;    // 去重后确定新增的条数（= items.length）
  willSkip: number;      // 重复条数（文件内重复 + 库中已存在）
  invalid: Array<{ row: number; reason: string }>;   // 无法解析的行，row 为 Excel 行号（含表头偏移）
  duplicates: Array<{ row: number; standardNo: string; standardName: string; source: "file" | "db" }>;
  items: StandardImportItem[];   // 去重后的待新增数据，原样带回 confirm
}
```

`duplicates` 是给人看的明细，**最多返回前 100 条**（响应体不随重复量无限涨），总数看 `willSkip`。`items` 始终完整——确认入库要靠它。

### 4.2 确认入库 `POST /admin/standards/import`

**复用现有 JSON 导入端点，不新增**。前端把 4.1 返回的 `items` 原样 POST 回来。这样做的理由：

- 入库逻辑（`insertStandards` 分批 + `ON CONFLICT DO NOTHING`）只有一份，不会出现「Excel 导入走另一条写入路径」的双轨漂移；
- 服务端无状态：不在内存里缓存待导入数据，预检与确认之间库被他人改动也能正确收敛（冲突行被 `DO NOTHING` 跳过，`inserted` 如实反映）；
- 代价是确认请求体会带上 `items`（13445 行约 2~3MB），在现有 64MB 限制内，可接受。

并发边界：预检后、确认前若他人已导入相同行，确认时 `inserted` 会小于 `willInsert`——**这是正确行为**，提示语按实际 `inserted` 报，不按预检值报。

### 4.3 模板下载 `GET /admin/standards/template`

返回 `standard-template.xlsx`：仅第 1 行表头（8 列）+ 第 2 行一行示例数据（标注「示例行，导入时请删除」的说明放在表头批注或单独 `说明` sheet，**不放在数据 sheet**，避免示例行被误导入）。

### 4.4 导出 `GET /admin/standards/export`

- Query 与列表页完全一致：`search` / `status` / `category` / `sortField` / `sortOrder`（**不带** `page`/`pageSize`，即全量导出当前筛选结果）。
- 复用 `buildWhere`，不新增筛选逻辑（避免导出与列表口径漂移）。
- 返回 `standards-export.xlsx`，列序与模板一致（8 列，状态输出中文标签）。
- 上限：全量 13445 行一次生成；超出 5 万行仍生成但响应头带 `X-Standards-Truncated: true` 并只导前 5 万行（防止误操作全表导出把内存打爆）。

## 5. 前端交互

「导入 JSON」按钮改为 **「导入 Excel」**，工具栏新增 **「下载模板」** 与 **「导出 Excel」**。

导入流程（两段式）：

```
选 .xlsx → POST import-excel（预检）
   ├─ invalid 非空 → 提示「N 行无法解析」+ 前 10 条原因，中止
   ├─ willInsert === 0 → 提示「没有可新增的数据（全部重复）」，中止
   └─ 否则弹确认框：
        「将新增 N 条；跳过 M 条重复（文件内 X / 库中已存在 Y）」
        + 重复明细列表（前 100 条，超出显示「等共 M 条」）
        [取消] [确认导入 N 条]
           └─ 确认 → POST import({items}) → toast「新增 N 条（收到 R，跳过 S）」
```

导出流程：点「导出 Excel」→ 带当前筛选 GET export → 浏览器下载文件（`URL.createObjectURL` + a[download]）。

## 6. 边界与异常

| 场景 | 行为 |
| --- | --- |
| 文件非 xlsx / 超过 10MB | 前端直接拦，toast 提示，不发请求 |
| 表头列名不匹配 | 400，指出第几列期望什么 |
| 编号或名称为空 | 该行进 `invalid`，不中断整批 |
| 编号/名称含 U+FFFD | 该行进 `invalid`（沿用 `hasReplacementChar` 的既有理由：坏行入库会污染自检比对） |
| 日期不是 `YYYY-MM-DD` | 该行进 `invalid`，**不**像 PATCH 那样返 400 中断整批（批量导入要容忍个别坏行） |
| Excel 有公式/合并单元格 | 只读 `values`，忽略公式与合并结构 |
| 空文件（仅表头） | 400「没有数据行」 |
| 重复行在文件内多次出现 | 首次保留，后续计 `source: "file"` |

## 7. 验收场景

1. **模板下载**：得到的 xlsx 表头 8 列与 §2 一致，无示例数据行混入数据 sheet；
2. **全新导入**：构造 3 行新数据 → 预检 `willInsert=3, willSkip=0` → 确认后列表可见、总数 +3；
3. **库中重复**：把刚导入的 3 行原样再传 → 预检 `willInsert=0, willSkip=3, duplicates[].source="db"` → 提示无可新增；
4. **文件内重复**：同一文件里同一行出现 2 次 → 预检 `willInsert=1, willSkip=1, source="file"`；
5. **编号同名不同名**：`GB 150-1998` 造「现行」「已废止」两行 → 两行都应 `willInsert`（验证未被按编号误去重）；
6. **坏行容忍**：混入 1 行空编号 + 1 行乱码 → `invalid` 2 条带行号，其余正常导入；
7. **导出联动**：列表页搜 `GB/T` + 筛选 `现行` → 导出文件行数与页面 total 一致、列序与模板一致、状态为中文；
8. **导回闭环**：导出文件改一行名称再导入 → 该行按新二元组新增（旧行仍在），符合 §3 口径。

## 8. 验证记录

冒烟脚本：`packages/server/std-io-verify.mjs`（起本地实例 + 登录 + 跑 §7 全部场景 + 清理测试数据，结果 **33/33 通过**）。

验证中抓到并修复的真实缺陷：

- **判重键分隔符损坏**：`repo.ts` 里拼接判重键的模板字符串被写成了真实 NUL 字节（`\u0000`），与 `excel.ts` 用的空格分隔符永远匹配不上，导致库中筛重完全失效（整份重传全部判成新行）。修复：三处拼接触点全部收口到共享函数 `standardKey(no, name)`，从结构上杜绝再次不一致。
- **无索引访问**：`noUncheckedIndexedAccess` 下补非空断言（布局同款处理，随类型检查暴露即修）。

脚本自身的两处构造错误（非产品缺陷，记录备查）：

- 场景 5 若两行名称也相同，按 §3 二元组口径就是文件内重复，「多版本」必须靠不同名称构造；
- 场景 8 改名称必须**替换**第 2 列，插入新列会让名字没变、二元组不变。
