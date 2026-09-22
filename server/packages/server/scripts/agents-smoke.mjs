/**
 * Agent 数字人端到端冒烟（A-1 管理面 + A-2 下发面 + v1 市场面）。
 *   起 identity(独立端口 8802, authMode=local) → admin 建技能 + 建 Agent →
 *   角色/账号可见性 → 技能引用校验 → 启停即时生效 → 校验/越权/重复
 *   → v1 专家市场（市场字段/上架过滤/安装/卸载/启停/收藏/越范围 404）→ 清理。
 *
 * 前置：docker compose up -d pg；server 已 build。
 * 用法：node packages/server/scripts/agents-smoke.mjs（仓库根执行）
 *
 * ⚠ v1 语义变更：`/me/agents` 从「可见即下发」改为「**市场目录**」（可见 **且已上架**）。
 *   因此本冒烟里凡要走 `/me/agents` 的 Agent 都必须带 `published: true`，
 *   未上架（草稿）只应在管理面可见 —— 这条本身就是一个断言。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";
import { useSmokeDb } from "./lib/smoke-db.mjs";

try {
  process.loadEnvFile?.();
} catch {
  /* ignore */
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PORT = Number(process.env.REACTOR_AGENTS_SMOKE_PORT ?? 8802);
const BASE = `http://127.0.0.1:${PORT}`;

// 本次运行起点：收尾时按时间窗清理服务端自记的 admin_action 审计行（见 lib/audit-cleanup.mjs）
const STARTED_AT = new Date();

/** 本测试会新建的分类（收尾与清场都要删，否则第二次跑就撞 409 —— 冒烟必须可重复跑） */
const TEST_CATEGORY_CODES = ["office", "temp-unused"];

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}
const get = (p, t) => req("GET", p, undefined, t);
const post = (p, b, t) => req("POST", p, b, t);
const patch = (p, b, t) => req("PATCH", p, b, t);
const del = (p, t) => req("DELETE", p, undefined, t);
const login = (u, p) => post("/auth/login", { username: u, password: p });

async function main() {
  // ★ 必须最先执行：切到独立冒烟库（每次重建）。下面的清场删**全表** agents 与 skills，
  // 2026-09-18 它连的是真实库，跑一次 gate:infra/gate:all 就把技能市场与数字人市场一起清空了。
  await useSmokeDb();
  const child = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: { ...process.env, REACTOR_IDENTITY_PORT: String(PORT), REACTOR_AUTH_MODE: "local" },
    stdio: "ignore",
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = await login("admin", process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123").catch(() => null);
    if (r && r.status === 200) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) {
    console.error("✗ identity 未在 20s 内就绪（PG 起了吗？）");
    child.kill();
    process.exit(1);
  }

  try {
    console.log("== Agents 冒烟 ==");
    const adminTok = (await login("admin", process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123")).json?.accessToken;
    const userTok = (await login("user", process.env.REACTOR_TEST_USER_PWD ?? "User@123")).json?.accessToken;
    check("admin/user 双登录", Boolean(adminTok) && Boolean(userTok));

    // 清场。⚠ 这里是**删全表** agents 与 skills —— 只在 main() 开头 useSmokeDb() 之后才安全：
    // 冒烟跑在独立库 reactor_smoke 上，绝不要在没有 useSmokeDb() 的情况下复用这段逻辑。
    for (const a of (await get("/admin/agents", adminTok)).json?.agents ?? []) await del(`/admin/agents/${a.id}`, adminTok);
    for (const s of (await get("/admin/skills", adminTok)).json?.skills ?? []) await del(`/admin/skills/${s.id}`, adminTok);
    /*
     * 本测试会新建分类 —— 必须清，否则第二次跑会因「分类标识已存在」而红。
     * 分类有引用时删不掉（409），但这里 agents 已清空，正常应 200。
     * 分类的种子数据（product/engineering/.../other）不在此列，不动。
     */
    for (const code of TEST_CATEGORY_CODES) {
      await del(`/admin/agent-categories/${code}`, adminTok).catch(() => undefined);
    }

    // 前置：技能 + （v1）标签库 —— 标签是受控词表，不给库里加标签就无法给专家打标签
    const skill = await post(
      "/admin/skills",
      { name: "report-writer", title: "报告写作", content: "# 报告写作\n\n写周报。", scope: { kind: "all" } },
      adminTok,
    );
    check("前置：技能创建 201", skill.status === 201);
    const tag1 = await post("/admin/agent-tags", { name: "周报" }, adminTok);
    const tag2 = await post("/admin/agent-tags", { name: "材料整理" }, adminTok);
    check("前置：标签库新增 201", tag1.status === 201 && tag2.status === 201, JSON.stringify(tag1.json ?? {}));
    check("前置：重复标签 409", (await post("/admin/agent-tags", { name: "周报" }, adminTok)).status === 409);

    // v1 字典：分类为种子数据（可改名/排序/停用/新增），标签库空则专家无法打标签
    const tax = await get("/admin/agent-taxonomy", adminTok);
    check("v1 字典含种子分类", (tax.json?.categories ?? []).some((c) => c.code === "other" && c.label === "其他"));
    const userTax = await get("/me/agent-taxonomy", userTok);
    check("v1 普通用户可取市场字典", userTax.status === 200 && Array.isArray(userTax.json?.categories));

    // A-1 创建 Agent（全公司 + 引用技能 + v1 市场字段与预设包）
    const created = await post(
      "/admin/agents",
      {
        name: "office-helper",
        title: "办公助手",
        description: "帮你写周报与整理材料",
        emoji: "📝",
        persona: "你是企业内部办公助手，回答简洁、先给结论。",
        provider: "tokenrhythm",
        modelId: "deepseek-v4-flash-0731",
        skills: ["report-writer"],
        scope: { kind: "all" },
        // v1 市场字段
        published: true,
        tags: ["周报", "材料整理"],
        category: "other",
        official: true,
        author: "平台运营",
        // v1 预设包（D2）
        sessionType: "work",
        policyMode: "build",
        thinkingLevel: "medium",
        starters: ["帮我整理这份材料", "写一份本周周报"],
      },
      adminTok,
    );
    check("A-1 创建 Agent 201", created.status === 201 && created.json?.agent?.name === "office-helper", JSON.stringify(created.json));
    const agentId = created.json?.agent?.id;
    check("A-1 技能白名单已保存", JSON.stringify(created.json?.agent?.skills) === '["report-writer"]');
    check("A-1 模型已保存", created.json?.agent?.provider === "tokenrhythm" && created.json?.agent?.modelId === "deepseek-v4-flash-0731");
    check("v1 市场字段已保存", created.json?.agent?.official === true && created.json?.agent?.author === "平台运营" && created.json?.agent?.category === "other", JSON.stringify(created.json?.agent ?? {}).slice(0, 200));
    check("v1 上架时间已写入", typeof created.json?.agent?.publishedAt === "string" && created.json.agent.publishedAt.length > 0);
    check(
      "v1 预设包已保存",
      JSON.stringify(created.json?.agent?.preset) === JSON.stringify({ sessionType: "work", policyMode: "build", thinkingLevel: "medium", starters: ["帮我整理这份材料", "写一份本周周报"] }),
      created.json?.agent?.preset,
    );
    check("v1 标签已保存", JSON.stringify(created.json?.agent?.tags) === '["周报","材料整理"]');

    const list = await get("/admin/agents", adminTok);
    check("A-1 列表可见", (list.json?.agents ?? []).some((a) => a.name === "office-helper"));

    // A-2 下发（= v1 市场目录：可见且已上架）
    const userAgents1 = await get("/me/agents", userTok);
    const seen = (userAgents1.json?.agents ?? []).find((a) => a.name === "office-helper");
    check("A-2 全公司 Agent 对 user 可见（含 persona/model/skills）", Boolean(seen) && seen.persona.includes("办公助手") && seen.skills.length === 1);
    check("v1 市场载荷带关系与热度", seen?.installed === false && seen?.favorited === false && seen?.hot === 0, { installed: seen?.installed, hot: seen?.hot });
    check("v1 市场载荷带预设包（应用到会话用）", seen?.sessionType === "work" && seen?.policyMode === "build" && seen?.thinkingLevel === "medium" && (seen?.starters ?? []).length === 2);
    check("v1 市场载荷带卡片字段", seen?.official === true && seen?.author === "平台运营" && (seen?.tags ?? []).length === 2);

    // v1 分类/标签写入校验
    console.log("== v1 分类与标签字典 ==");
    const newCat = await post("/admin/agent-categories", { code: "office", label: "办公协同" }, adminTok);
    check("v1 新增分类 201（管理员自由添加）", newCat.status === 201 && newCat.json?.category?.code === "office", JSON.stringify(newCat.json ?? {}));
    check("v1 重复分类 409", (await post("/admin/agent-categories", { code: "office", label: "x" }, adminTok)).status === 409);
    check("v1 非法分类标识 400", (await post("/admin/agent-categories", { code: "Bad Code", label: "x" }, adminTok)).status === 400);
    const renamed = await patch("/admin/agent-categories/office", { label: "办公协同（改）" }, adminTok);
    check("v1 分类改名 200（code 不变）", renamed.status === 200 && renamed.json?.category?.label === "办公协同（改）" && renamed.json?.category?.code === "office");
    check("v1 停用分类 200", (await patch("/admin/agent-categories/office", { enabled: false }, adminTok)).json?.category?.enabled === false);
    check(
      "v1 新增专家不能选停用分类 400",
      (await post("/admin/agents", { name: "use-disabled-cat", title: "x", category: "office", scope: { kind: "all" } }, adminTok)).status === 400,
    );
    check(
      "v1 引用不存在的分类 400",
      (await post("/admin/agents", { name: "ghost-cat", title: "x", category: "ghost", scope: { kind: "all" } }, adminTok)).status === 400,
    );
    check(
      "v1 引用不在标签库的标签 400",
      (await post("/admin/agents", { name: "ghost-tag", title: "x", tags: ["不存在的标签"], scope: { kind: "all" } }, adminTok)).status === 400,
    );
    // 有专家在用 → 分类不可删（409 + 引用数）；未被用的新分类可删
    const draft = await post("/admin/agents", { name: "draft-agent", title: "草稿专家", category: "engineering", scope: { kind: "all" } }, adminTok);
    check("v1 未上架创建 201", draft.status === 201);
    const blocked = await del("/admin/agent-categories/engineering", adminTok);
    check("v1 有专家在用的分类拒绝删除 409", blocked.status === 409, JSON.stringify(blocked.json ?? {}));
    /* 无引用才能删：另建一个没人用的分类来验（不能拿 other —— 主 Agent 正占着它） */
    await post("/admin/agent-categories", { code: "temp-unused", label: "临时未使用" }, adminTok);
    const unused = await del("/admin/agent-categories/temp-unused", adminTok);
    check("v1 无引用的分类可删 200", unused.status === 200, JSON.stringify(unused.json ?? {}));
    check("v1 删除后市场字典不再含该分类", !((await get("/me/agent-taxonomy", userTok)).json?.categories ?? []).some((c) => c.code === "temp-unused"));

    // 有专家在用的标签同样拒绝删除（主 Agent 刚用过「周报」）
    check("v1 有专家在用的标签拒绝删除 409", (await del(`/admin/agent-tags/${encodeURIComponent("周报")}`, adminTok)).status === 409);
    check("v1 草稿不进市场", !((await get("/me/agents", userTok)).json?.agents ?? []).some((a) => a.name === "draft-agent"));
    check("v1 草稿在管理面可见", ((await get("/admin/agents", adminTok)).json?.agents ?? []).some((a) => a.name === "draft-agent"));

    // 角色范围（v1 一并上架：这样「看不到」断言考的是**范围**，而不是上架态）
    const roleScoped = await post(
      "/admin/agents",
      { name: "admin-agent", title: "管理员助手", persona: "仅管理员。", published: true, scope: { kind: "role", roles: ["platform_admin"] } },
      adminTok,
    );
    check("A-1 角色范围创建 201", roleScoped.status === 201);
    const roleAgentId = roleScoped.json?.agent?.id;
    const userAgents2 = await get("/me/agents", userTok);
    check("A-2 user 看不到管理员 Agent", !(userAgents2.json?.agents ?? []).some((a) => a.name === "admin-agent"));
    const adminAgents2 = await get("/me/agents", adminTok);
    check("A-2 admin 看到两条", (adminAgents2.json?.agents ?? []).length >= 2);

    // 启停即时生效
    const disabled = await patch(`/admin/agents/${agentId}`, { enabled: false }, adminTok);
    check("A-1 停用 200", disabled.status === 200 && disabled.json?.agent?.enabled === false);
    const userAgents3 = await get("/me/agents", userTok);
    check("A-2 停用后 user 不可见", !(userAgents3.json?.agents ?? []).some((a) => a.name === "office-helper"));

    // 校验与越权
    const badName = await post("/admin/agents", { name: "Bad Name!", title: "x", scope: { kind: "all" } }, adminTok);
    check("校验：非法标识 400", badName.status === 400);
    const badSkill = await post(
      "/admin/agents",
      { name: "ghost-skill-agent", title: "x", skills: ["not-exist"], scope: { kind: "all" } },
      adminTok,
    );
    check("校验：引用不存在的技能 400", badSkill.status === 400, JSON.stringify(badSkill.json));
    const longPersona = await post(
      "/admin/agents",
      { name: "long-persona", title: "x", persona: "x".repeat(8001), scope: { kind: "all" } },
      adminTok,
    );
    check("校验：人设超长 400", longPersona.status === 400);
    const dup = await post("/admin/agents", { name: "admin-agent", title: "dup", scope: { kind: "all" } }, adminTok);
    check("校验：重复标识 409", dup.status === 409);
    const forbidden = await post("/admin/agents", { name: "user-made", title: "x", scope: { kind: "all" } }, userTok);
    check("越权：普通用户建 Agent 403", forbidden.status === 403);
    const forbiddenList = await get("/admin/agents", userTok);
    check("越权：普通用户读管理列表 403", forbiddenList.status === 403);

    // ===== v1 市场面：安装 / 卸载 / 启停 / 收藏 / 越范围 =====
    console.log("== v1 专家市场 ==");
    const markRead = async (name) => ((await get("/me/agents", userTok)).json?.agents ?? []).find((a) => a.name === name);

    // 市场字段白名单
    const badCategory = await post("/admin/agents", { name: "bad-cat", title: "x", category: "nope", scope: { kind: "all" } }, adminTok);
    check("v1 分类白名单 400", badCategory.status === 400, JSON.stringify(badCategory.json));

    // 先恢复主 Agent（前面被停用过）
    await patch(`/admin/agents/${agentId}`, { enabled: true }, adminTok);

    const ins1 = await post("/me/agents/office-helper/install", {}, userTok);
    check("v1 安装 200 且 created=true", ins1.status === 200 && ins1.json?.created === true, JSON.stringify(ins1.json));
    const ins2 = await post("/me/agents/office-helper/install", {}, userTok);
    check("v1 重复安装幂等（created=false）", ins2.status === 200 && ins2.json?.created === false);
    const afterInstall = await markRead("office-helper");
    check("v1 安装后 installed=true / hot=1 / installEnabled=true", afterInstall?.installed === true && afterInstall?.hot === 1 && afterInstall?.installEnabled === true, { installed: afterInstall?.installed, hot: afterInstall?.hot, installEnabled: afterInstall?.installEnabled });

    const off = await patch("/me/agents/office-helper/install", { enabled: false }, userTok);
    check("v1 停用 200", off.status === 200 && off.json?.enabled === false);
    const afterOff = await markRead("office-helper");
    check("v1 停用后关系仍在（installed=true / installEnabled=false）", afterOff?.installed === true && afterOff?.installEnabled === false);
    const on = await patch("/me/agents/office-helper/install", { enabled: true }, userTok);
    check("v1 重新启用 200", on.status === 200 && on.json?.enabled === true);

    const fav1 = await post("/me/agents/office-helper/favorite", {}, userTok);
    check("v1 收藏返回最终态 true", fav1.status === 200 && fav1.json?.favorited === true);
    check("v1 收藏后市场可见 favorited=true", (await markRead("office-helper"))?.favorited === true);
    const fav2 = await post("/me/agents/office-helper/favorite", {}, userTok);
    check("v1 再点取消收藏（返回 false）", fav2.status === 200 && fav2.json?.favorited === false);

    check("v1 卸载前 installed=true", (await markRead("office-helper"))?.installed === true);
    const un = await del("/me/agents/office-helper/install", userTok);
    check("v1 卸载 200", un.status === 200);
    const afterUn = await markRead("office-helper");
    check("v1 卸载后 installed=false 且热度归零", afterUn?.installed === false && afterUn?.hot === 0, { installed: afterUn?.installed, hot: afterUn?.hot });

    // v1 使用量（真实热度）：按「专家 × 会话」去重
    const use1 = await post("/me/agents/office-helper/use", { sessionId: "sess-1" }, userTok);
    check("v1 首次使用上报计入（created=true）", use1.status === 200 && use1.json?.created === true, JSON.stringify(use1.json ?? {}));
    const use1Again = await post("/me/agents/office-helper/use", { sessionId: "sess-1" }, userTok);
    check("v1 同会话重复上报幂等（created=false）", use1Again.status === 200 && use1Again.json?.created === false);
    await post("/me/agents/office-helper/use", { sessionId: "sess-2" }, userTok);
    check("v1 使用量累计到 2（两会话）", (await markRead("office-helper"))?.uses === 2, (await markRead("office-helper"))?.uses);
    check("v1 使用量不影响安装量", (await markRead("office-helper"))?.hot === 0);
    check("v1 缺 sessionId 400", (await post("/me/agents/office-helper/use", {}, userTok)).status === 400);
    check("v1 不存在专家上报使用 404", (await post("/me/agents/ghost-expert/use", { sessionId: "s" }, userTok)).status === 404);

    const unAgain = await del("/me/agents/office-helper/install", userTok);
    check("v1 重复卸载幂等 200", unAgain.status === 200);

    const conflict = await patch("/me/agents/office-helper/install", { enabled: true }, userTok);
    check("v1 未安装却启停 409", conflict.status === 409, JSON.stringify(conflict.json));
    const noBody = await patch("/me/agents/office-helper/install", {}, userTok);
    check("v1 启停缺 enabled 400", noBody.status === 400);

    const ghost = await post("/me/agents/ghost-expert/install", {}, userTok);
    check("v1 不存在的专家写操作 404", ghost.status === 404);
    const outOfScope = await post("/me/agents/admin-agent/install", {}, userTok);
    check("v1 超出授权范围的专家写操作 404", outOfScope.status === 404, JSON.stringify(outOfScope.json));
    const draftInstall = await post("/me/agents/draft-agent/install", {}, userTok);
    check("v1 未上架专家不可安装 404", draftInstall.status === 404);

    // 隔离性：另一个账号的安装不影响我的关系
    const adminSees = ((await get("/me/agents", adminTok)).json?.agents ?? []).find((a) => a.name === "office-helper");
    check("v1 安装关系按账号隔离", adminSees?.installed === false);

    // 清理（列表里剩下的草稿也一并删，否则最后一条断言会红）
    for (const a of (await get("/admin/agents", adminTok)).json?.agents ?? []) await del(`/admin/agents/${a.id}`, adminTok);
    await del(`/admin/skills/${skill.json.skill.id}`, adminTok);
    // v1 标签库也清掉（分类里有种子数据，只清本测试新建的）
    for (const t of (await get("/admin/agent-taxonomy", adminTok)).json?.tags ?? []) {
      await del(`/admin/agent-tags/${encodeURIComponent(t.name)}`, adminTok);
    }
    // 本测试新建的分类：前面靠「有引用 → 409」验过，这里 agents 已清空，能真正删掉
    for (const code of TEST_CATEGORY_CODES) {
      await del(`/admin/agent-categories/${code}`, adminTok).catch(() => undefined);
    }
    check("清理后 Agent 列表为空", ((await get("/admin/agents", adminTok)).json?.agents ?? []).length === 0);
  } finally {
    child.kill();
    // 负向用例（user 角色打 /admin/agents → 403）会留痕，收尾清掉，避免污染真实审计表
    await cleanupAdminAudit({ since: STARTED_AT });
  }

  console.log(failed === 0 ? "\nAGENTS SMOKE PASS" : `\nAGENTS SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
