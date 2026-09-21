/**
 * 公共知识库 —— **无 PG** 的纯逻辑与源契约探针（KB-⑥ 服务端，`probes` 组）。
 *
 * ## 为什么要有这一条（而不是全塞进 PG 探针）
 *
 * KB 的两条红线里，**红线 ①（应用层裁剪）是纯逻辑**：请求的 `datasetIds` 必须 ⊆ 可见集合，
 * 越权要**剔除并点名**而不是静默忽略。若只在 PG 探针里验，这条红线就变成
 * 「只有跑得起 docker 的机器才验得了」—— CI 上等于没有覆盖。
 * 所以把裁剪抽成纯函数 `clipToVisible` 在这里断言；PG 探针只管 SQL 层与真实检索。
 *
 * 另外守一条**源契约**：`visibilitySql` 写死了 `$1`=role / `$2`=deptId / `$3`=uid，
 * 因此 `repo.ts` 里每个用到它的查询，参数数组都必须以这三件套开头。这条一旦被重排，
 * 表现是「过滤看似生效、实际按错的字段过滤」（PG 不会报错，只会静默放行）——
 * 纯静态断言正好能钉住它，而且不需要连库。
 *
 * 用法：`pnpm --filter @reactor/server exec tsx scripts/kb-pure-smoke.ts`
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { clipToVisible, cosineSimilarity, sourceOfDataset } from "../src/datasets/retrieval.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

/* ── ① 应用层裁剪（红线 ① 的核心逻辑） ─────────────────────────────────── */

console.log("· 应用层裁剪 clipToVisible");
{
  const visible = [1, 2, 3];

  const all = clipToVisible(undefined, visible);
  check("缺省请求 = 全部可见库", all.ids.join(",") === "1,2,3" && all.dropped.length === 0, all);

  const empty = clipToVisible([], visible);
  check("空数组 = 全部可见库（不是「什么都不查」）", empty.ids.join(",") === "1,2,3", empty);

  const subset = clipToVisible([2], visible);
  check("请求子集原样返回", subset.ids.join(",") === "2" && subset.dropped.length === 0, subset);

  const over = clipToVisible([1, 9, 3], visible);
  check("越权 id 被剔除（不返回）", !over.ids.includes(9), over);
  check("★ 越权 id 必须**点名**（红线 ①：剔除要可见，不静默）", over.dropped.join(",") === "9", over);

  const mixed = clipToVisible([2, 2, 7, 7], visible);
  check("重复 id 去重（ids 与 dropped 都不重复）", mixed.ids.join(",") === "2" && mixed.dropped.join(",") === "7", mixed);

  const junk = clipToVisible(["abc", 2.5, null as unknown as number, 2], visible);
  check("非整数/非数字被忽略（不抛、不误当 0）", junk.ids.join(",") === "2", junk);

  const none = clipToVisible([8, 9], visible);
  check("全部越权 ⇒ ids 为空（调用方据此返回空结果，而不是回退到全量）", none.ids.length === 0 && none.dropped.length === 2, none);
}

/* ── ② 来源映射（公共库只到「部门 + 全员」两级） ────────────────────────── */

console.log("· 来源标注 sourceOfDataset");
{
  check("scope=all ⇒ org（全员）", sourceOfDataset("all") === "org");
  check("scope=dept ⇒ department", sourceOfDataset("dept") === "department");
  check("scope=role ⇒ department", sourceOfDataset("role") === "department");
  check("scope=user ⇒ department（不是 personal —— 个人库在端上）", sourceOfDataset("user") === "department");
}

/* ── ③ Node 内余弦（pgvector 不可用时的回退路径） ───────────────────────── */

console.log("· Node 内余弦 cosineSimilarity");
{
  check("同向 ⇒ 1", Math.abs(cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9);
  check("正交 ⇒ 0", Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  check("反向 ⇒ -1", Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  check("零向量 ⇒ 0（不 NaN）", cosineSimilarity([0, 0], [1, 1]) === 0);
  check("长度不等 ⇒ 0（不抛）", cosineSimilarity([1, 2], [1]) === 0);
  check("空向量 ⇒ 0", cosineSimilarity([], []) === 0);
}

/* ── ④ 源契约：visibilitySql 的参数顺序（重排 = 静默按错字段过滤） ─────── */

console.log("· 源契约：scope 三件套必须落在 $1~$3");
{
  const repoPath = path.join(import.meta.dirname ?? ".", "..", "src", "datasets", "repo.ts");
  const src = readFileSync(repoPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * 断言口径（2026-09-19 修订）：「每个 visibilitySql 调用，其邻域（±15 行）内必须有一组
   * `viewer.role, viewer.deptId, viewer.uid` 打头的参数」。
   *
   * 为什么不再是 1:1 计数：`listApplications` 的参数也以三件套打头，但它**不走** scope 过滤
   * （审批权与写权限同源：管理员看全部、普通用户只看自己创建的库收到的申请，按 `created_by` 过滤）
   * —— 代码是对的，1:1 假设过窄。反过来「调用旁必有三件套」才是要钉的真不变量
   * （重排 = 静默按错字段过滤）。
   */
  const lines = src.split("\n");
  const callLines = lines.reduce<number[]>((acc, l, i) => (l.includes("visibilitySql({") ? (acc.push(i), acc) : acc), []);
  const trioLines = lines.reduce<number[]>((acc, l, i) => (/\[\s*viewer\.role,\s*viewer\.deptId,\s*viewer\.uid\b/.test(l) ? (acc.push(i), acc) : acc), []);
  const WINDOW = 15;
  const orphan = callLines.filter((ci) => !trioLines.some((ti) => Math.abs(ti - ci) <= WINDOW));

  check("repo.ts 里确实用了 visibilitySql（防正则失效后假绿）", callLines.length >= 4, callLines.length);
  check(
    `★ 每个 visibilitySql 调用的 ±${WINDOW} 行内都有一组「role, deptId, uid 打头」参数（${callLines.length} 处调用 / ${trioLines.length} 组参数，孤异常数 ${orphan.length}）`,
    orphan.length === 0,
    orphan.map((i) => `L${i + 1}`),
  );

  // 反向：不能有把 scope 参数塞到末尾的写法
  const trailing = /\[\s*[^[\]]*viewer\.uid\s*\]/.test(src) && /\[\s*datasetIds[^\]]*viewer\.role/.test(src);
  check("没有「把 scope 参数塞到末尾」的写法", !trailing);
}

console.log(failed === 0 ? "\n全部断言通过" : `\n${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
