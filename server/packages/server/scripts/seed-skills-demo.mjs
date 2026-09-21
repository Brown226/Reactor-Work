/**
 * 技能市场演示数据（一次性种子，可重复跑）。
 *
 * 为什么需要它：技能市场全部冒烟/探针都会**清理自己造的数据**，所以库里长期是空的，
 * 打开技能页只能看到空态。这份种子给出 6 条可眼验的场景：
 *   - 2 条精选（首页精选位 + 「换一换」）
 *   - 1 条「默认安装」（新用户开箱即用 / 免手动安装）
 *   - 分类覆盖 office/dev/data/content（4 类 chips 都有内容）
 *   - 1 个套件（一键装 3 个成员）
 *   - 1 条**已下架**（预置给 tiankd：演示软下架 = 文件保留 + 界面标「已下架」+ 开关禁用）
 *
 * 幂等：已存在则 PATCH 更新，不报错；已下架那条会被重新置为 disabled（演示态）。
 *
 * 位置说明：这是**开发/演示工具，不是门禁探针**（不登记进 manifest，不进 gate）。
 * 用法：`node packages/server/scripts/seed-skills-demo.mjs`（需 PG 与身份服务已起）
 */
import pg from "pg";

const { Client } = pg;

const BASE = process.env.REACTOR_IDENTITY_BASE ?? "http://127.0.0.1:8791";
const ADMIN = { username: "admin", password: process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123" };
/** 演示「已下架」用的账号（你的桌面端登录账号） */
const DEMO_UID = process.env.REACTOR_DEMO_UID ?? "tiankd";

const req = async (method, path, body, token) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json };
};

const SKILLS = [
  {
    name: "weekly-report",
    title: "办公周报",
    icon: "📝",
    category: "office",
    tags: ["周报", "汇报"],
    author: "平台团队",
    featured: true,
    weight: 80,
    autoInstall: true,
    description: "把零散的工作记录整理成结构清晰的周报",
    content: `---
name: weekly-report
description: 把零散的工作记录整理成结构清晰的周报
---

# 办公周报

## 何时使用
用户提到「写周报」「本周总结」「汇报进展」时使用。

## 步骤
1. 先确认时间范围（默认本周）与汇报对象（直属领导 / 团队）。
2. 收集素材：已完成、进行中、风险与阻塞、下周计划。
3. **结论先行**：先一段亮点总结，再列条目；每条写成「做了什么 → 带来什么结果」。
4. 风险项必须给出影响面与建议动作，不要只描述现象。
5. 输出 Markdown；数据缺失处标注「待补充」，不要编造数字。
`,
  },
  {
    name: "meeting-notes",
    title: "会议纪要",
    icon: "🗒️",
    category: "office",
    tags: ["会议", "纪要"],
    author: "平台团队",
    featured: true,
    weight: 60,
    description: "把会议原始记录整理成决议、待办与责任人清单",
    content: `---
name: meeting-notes
description: 把会议原始记录整理成决议、待办与责任人清单
---

# 会议纪要

## 步骤
1. 输出三段：**结论 / 待办 / 悬而未决**。
2. 待办必须带责任人与时间点；没有就写「待定（建议 X 前确认）」。
3. 有分歧的地方保留双方观点与依据，不要只是和稀泥。
`,
  },
  {
    name: "code-review",
    title: "代码审查助手",
    icon: "🔍",
    category: "dev",
    tags: ["代码", "审查"],
    author: "平台团队",
    weight: 40,
    description: "按严重程度分级审查改动，给出可执行的修改建议",
    content: `---
name: code-review
description: 按严重程度分级审查改动，给出可执行的修改建议
---

# 代码审查助手

## 步骤
1. 先给结论：能否合并、有无阻塞项。
2. 按 **必须修复 / 建议修改 / 仅供参考** 三级列出问题，每条给出文件与行号。
3. 关注：边界条件、错误处理、并发、资源释放、日志与可观测性。
4. 对每个问题给出最小修改方案，而不是泛泛而谈「建议优化」。
`,
  },
  {
    name: "data-insight",
    title: "数据洞察",
    icon: "📊",
    category: "data",
    tags: ["分析", "可视化"],
    author: "平台团队",
    weight: 20,
    description: "从一份表格数据里找出异常、趋势与可执行结论",
    content: `---
name: data-insight
description: 从一份表格数据里找出异常、趋势与可执行结论
---

# 数据洞察

## 步骤
1. 先描述数据规模与口径（行数、时间范围、缺失情况）。
2. 找三类信号：**异常点**（离群/突变）、**趋势**（上升下降拐点）、**分层差异**（按维度对比）。
3. 每个结论都要给出依据（具体数值/区间），区分「相关」与「因果」。
4. 最后给出 2-3 条可执行建议，并标注置信度。
`,
  },
  {
    name: "ppt-outline",
    title: "演示大纲",
    icon: "🎞️",
    category: "content",
    tags: ["幻灯片", "大纲"],
    author: "平台团队",
    description: "把一个主题拆成有叙事线的演示大纲",
    content: `---
name: ppt-outline
description: 把一个主题拆成有叙事线的演示大纲
---

# 演示大纲

## 步骤
1. 先定一句话主张（听众离场后应该记住什么）。
2. 按「问题 → 现状 → 方案 → 证据 → 行动」组织 8-12 页。
3. 每页只给标题 + 3 个要点 + 一个图表建议；不要写整段文字。
`,
  },
  {
    name: "legacy-export",
    title: "旧版导出工具",
    icon: "📦",
    category: "office",
    tags: ["导出"],
    author: "平台团队",
    description: "已停用的历史导出技能（演示「已下架」语义）",
    content: `---
name: legacy-export
description: 已停用的历史导出技能（演示「已下架」语义）
---

# 旧版导出工具

> 这是**已下架**的演示技能：文件仍在你本地，但不会注入新会话；
> 在「我安装的」里会显示「已下架」，重新上架即恢复。
`,
  },
];

const BUNDLE = {
  name: "office-starter",
  title: "办公入门包",
  icon: "🧰",
  description: "周报 + 纪要 + 演示大纲，日常办公三件套",
  members: ["weekly-report", "meeting-notes", "ppt-outline"],
};

async function main() {
  const login = await req("POST", "/auth/login", ADMIN);
  if (login.status !== 200 || !login.json?.accessToken) {
    console.error(`登录失败（${BASE}，status=${login.status}）—— 身份服务起了吗？docker compose up -d`);
    process.exit(1);
  }
  const token = login.json.accessToken;

  const list = await req("GET", "/admin/skills", undefined, token);
  const existing = new Map((list.json?.skills ?? []).map((s) => [s.name, s]));

  for (const s of SKILLS) {
    // legacy-export 是演示「已下架」的，先建为启用（下面单独置停用）
    const body = { ...s, scope: { kind: "all" }, enabled: true };
    if (existing.has(s.name)) {
      const r = await req("PATCH", `/admin/skills/${existing.get(s.name).id}`, body, token);
      console.log(r.status === 200 ? `更新 ${s.name}` : `更新失败 ${s.name}: ${r.status} ${JSON.stringify(r.json)}`);
    } else {
      const r = await req("POST", "/admin/skills", body, token);
      console.log(r.status === 201 ? `新建 ${s.name}` : `新建失败 ${s.name}: ${r.status} ${JSON.stringify(r.json)}`);
    }
  }

  const bundles = await req("GET", "/admin/bundles", undefined, token);
  const has = (bundles.json?.bundles ?? []).some((b) => b.name === BUNDLE.name);
  const bundleBody = { ...BUNDLE, scope: { kind: "all" }, enabled: true };
  const br = has
    ? await req("PATCH", `/admin/bundles/${(bundles.json.bundles.find((b) => b.name === BUNDLE.name)).id}`, bundleBody, token)
    : await req("POST", "/admin/bundles", bundleBody, token);
  console.log(br.status === 200 || br.status === 201 ? `${has ? "更新" : "新建"} 套件 ${BUNDLE.name}` : `套件失败: ${br.status} ${JSON.stringify(br.json)}`);

  /* ── 给演示账号预置「已安装 + 已被管理员下架」的状态 ── */
  const after = await req("GET", "/admin/skills", undefined, token);
  const idOf = (name) => (after.json?.skills ?? []).find((s) => s.name === name)?.id;
  const legacyId = idOf("legacy-export");
  const db = new Client({ connectionString: process.env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor" });
  await db.connect();
  const uid = (await db.query("select uid from users where uid = $1", [DEMO_UID])).rows[0]?.uid;
  if (!uid) {
    console.log(`跳过「已下架」演示：账号 ${DEMO_UID} 不存在（用 REACTOR_DEMO_UID 指定）`);
  } else if (!legacyId) {
    console.log("跳过「已下架」演示：没找到 legacy-export");
  } else {
    // 模拟"该用户装过它"
    await db.query(
      `INSERT INTO skill_installs (uid, skill_id, version) VALUES ($1, $2, '1.0.0')
       ON CONFLICT (uid, skill_id) DO UPDATE SET installed_at = now()`,
      [uid, legacyId],
    );
    // 再把它下架（软下架：文件保留、不注入、界面标「已下架」）
    await req("PATCH", `/admin/skills/${legacyId}`, { enabled: false }, token);
    console.log(`已为 ${uid} 预置「已安装 + 已下架」：legacy-export`);
  }
  await db.end();

  /* ── 汇总 ── */
  const final = await req("GET", "/admin/skills", undefined, token);
  const fb = await req("GET", "/admin/bundles", undefined, token);
  console.log("\n当前技能库：");
  for (const s of final.json?.skills ?? []) {
    console.log(`  ${s.icon ?? "🧩"} ${s.title.padEnd(12, "　")} ${s.category.padEnd(8)} ${s.enabled ? "上架" : "已下架"}${s.featured ? " ·精选" : ""}${s.autoInstall ? " ·默认安装" : ""}  权重${s.weight}`);
  }
  for (const b of fb.json?.bundles ?? []) console.log(`  🧰 套件 ${b.title}（${(b.members ?? []).length} 个成员）`);
  console.log("\n桌面端操作：托盘右键「退出」再启动（关窗只是最小化到托盘，会看到旧构建）");
}

void main();
