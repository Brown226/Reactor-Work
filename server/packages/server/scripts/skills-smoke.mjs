/**
 * Skills 技能库端到端冒烟（S-1 管理面 + S-2 下发面）。
 *   起 identity(独立端口 8801, authMode=local 免 LDAP) → admin 建技能 →
 *   角色/账号可见性 → 启停即时生效 → 校验/越权/重复 → 清理。
 *
 * 前置：docker compose up -d pg；server 已 build。
 * 用法：node packages/server/scripts/skills-smoke.mjs（仓库根执行）
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";
import { useSmokeDb } from "./lib/smoke-db.mjs";

try {
  // 必须给出**绝对路径**：裸 `loadEnvFile()` 取的是 cwd 的 .env，而 pnpm 跑 npm script 时
  // cwd 是 packages/server（那里没有 .env，.env 在 server 根）。写成裸调用会让脚本在
  // `pnpm --filter @reactor/server smoke:x` 下回落到 55432（compose 映射在 15432），
  // 表现成 ECONNREFUSED 或静默 SKIP —— 与同目录 admin/t34/audit 等脚本的口径保持一致。
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* ignore */
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PORT = Number(process.env.REACTOR_SKILLS_SMOKE_PORT ?? 8801);
const BASE = `http://127.0.0.1:${PORT}`;

// 本次运行起点：收尾时按时间窗清理服务端自记的 admin_action 审计行（见 lib/audit-cleanup.mjs）
const STARTED_AT = new Date();

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
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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
const put = (p, b, t) => req("PUT", p, b, t);
const del = (p, t) => req("DELETE", p, undefined, t);

async function login(username, password) {
  return post("/auth/login", { username, password });
}

async function main() {
  // ★ 必须最先执行：把本次运行的库切到独立的冒烟库（每次重建）。
  // 下面的「清场」会删**全表**技能与套件 —— 2026-09-18 它连的是真实库，
  // 跑一次 gate:infra/gate:all 就把技能市场（28 技能/380 附件）清空了。
  // 隔离到冒烟库后，这个清场只是对空表的空操作，且收尾「清理后为空」的断言才真正成立。
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
    console.log("== Skills 冒烟（管理面 / 下发面 / 技能市场）==");
    const adminTok = (await login("admin", process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123")).json?.accessToken;
    const userTok = (await login("user", process.env.REACTOR_TEST_USER_PWD ?? "User@123")).json?.accessToken;
    check("admin/user 双登录", Boolean(adminTok) && Boolean(userTok));

    // 清场（幂等重跑）。⚠ 这里是**删全表**——只在 main() 开头 useSmokeDb() 之后才安全：
    // 冒烟跑在独立库 reactor_smoke 上，绝不要在没有 useSmokeDb() 的情况下复用这段逻辑。
    for (const b of (await get("/admin/bundles", adminTok)).json?.bundles ?? []) await del(`/admin/bundles/${b.id}`, adminTok);
    for (const s of (await get("/admin/skills", adminTok)).json?.skills ?? []) await del(`/admin/skills/${s.id}`, adminTok);

    // ── ① 创建 + 元数据（frontmatter 优先）──
    const created = await post(
      "/admin/skills",
      {
        name: "office-report",
        title: "办公周报",
        content: [
          "---",
          "description: 把要点整理成周报",
          "version: 0.9.0",
          "icon: 📝",
          "category: office",
          "tags: [周报, 汇报]",
          "disable-model-invocation: true",
          "---",
          "",
          "# 办公周报",
          "",
          "按「本周进展 / 风险 / 下周计划」三段输出。",
        ].join("\n"),
        scope: { kind: "all" },
      },
      adminTok,
    );
    check("S-1 创建技能 201", created.status === 201 && created.json?.skill?.name === "office-report", JSON.stringify(created.json?.error));
    const allSkill = created.json?.skill;
    check("元数据：frontmatter 抽取（描述/版本/图标/分类/标签）",
      allSkill?.description === "把要点整理成周报" && allSkill?.version === "0.9.0" && allSkill?.icon === "📝"
      && allSkill?.category === "office" && JSON.stringify(allSkill?.tags) === JSON.stringify(["周报", "汇报"]),
      JSON.stringify(allSkill && { d: allSkill.description, v: allSkill.version, i: allSkill.icon, c: allSkill.category, t: allSkill.tags }));
    check("元数据：disable-model-invocation 落库", allSkill?.disableModelInvocation === true, allSkill?.disableModelInvocation);

    // ── ② 下发集（本次**行为变更**）：未安装 ⇒ 不在落盘集 ──
    const before1 = await get("/me/skills", userTok);
    check("下发集：未安装的全公司技能**不**下发（语义已改为 可见∩(已装∪默认)）",
      !(before1.json?.skills ?? []).some((s) => s.name === "office-report"));

    const cat1 = await get("/me/skills/catalog?pageSize=50", userTok);
    const catItem = (cat1.json?.items ?? []).find((s) => s.name === "office-report");
    check("目录：可见技能出现在目录里", Boolean(catItem), cat1.status);
    check("目录：**列表不含正文**（卡片接口不下发 content）", catItem !== undefined && !("content" in catItem), Object.keys(catItem ?? {}));
    check("目录：带 installed=false / hasUpdate=false", catItem?.installed === false && catItem?.hasUpdate === false);

    // 安装（幂等）
    const ins1 = await post("/me/skills/office-report/install", {}, userTok);
    const ins2 = await post("/me/skills/office-report/install", {}, userTok);
    check("安装：首次 200 + 幂等（重复安装仍 200）", ins1.status === 200 && ins2.status === 200);
    const after1 = await get("/me/skills", userTok);
    const delivered = (after1.json?.skills ?? []).find((s) => s.name === "office-report");
    check("下发集：安装后出现且含正文（供落盘）", Boolean(delivered?.content?.includes("办公周报")));
    check("安装后目录态翻转（installed=true）", (await get("/me/skills/catalog", userTok)).json?.items?.find((s) => s.name === "office-report")?.installed === true);

    // ── ③ 版本与 hasUpdate / refresh ──
    await patch(`/admin/skills/${allSkill.id}`, { version: "1.0.0" }, adminTok);
    const upd = (await get("/me/skills/installed", userTok)).json?.items?.find((s) => s.name === "office-report");
    check("已安装：版本落后时 hasUpdate=true", upd?.hasUpdate === true, JSON.stringify(upd && { v: upd.version, h: upd.hasUpdate }));
    await post("/me/skills/office-report/refresh", {}, userTok);
    const upd2 = (await get("/me/skills/installed", userTok)).json?.items?.find((s) => s.name === "office-report");
    check("已安装：refresh 后 hasUpdate 归位", upd2?.hasUpdate === false);

    // ── ④ 启停：全局 + 按工作区覆盖（工作区优先）──
    const WS_A = "e:/work/alpha";
    const WS_B = "e:/work/beta";
    const stateOf = async (ws) => {
      const r = await get(`/me/skills/state?workspaceKey=${encodeURIComponent(ws)}`, userTok);
      return (r.json?.skills ?? []).find((s) => s.name === "office-report");
    };
    check("状态：默认启用", (await stateOf(WS_A))?.enabled === true);
    await put("/me/skills/office-report/enabled", { enabled: false }, userTok);
    check("状态：全局停用后两个工作区都停用", (await stateOf(WS_A))?.enabled === false && (await stateOf(WS_B))?.enabled === false);
    await put("/me/skills/office-report/enabled", { enabled: true, workspaceKey: WS_A }, userTok);
    check("状态：A 工作区覆盖为启用", (await stateOf(WS_A))?.enabled === true);
    check("状态：B 工作区仍跟随全局（停用）", (await stateOf(WS_B))?.enabled === false);
    check("状态：disableModelInvocation 一并下发（替死链 /api/skills）", (await stateOf(WS_B))?.disableModelInvocation === true);
    const cleared = await del(`/me/skills/office-report/enabled?workspaceKey=${encodeURIComponent(WS_A)}`, userTok);
    check("状态：清除工作区覆盖 200", cleared.status === 200, JSON.stringify(cleared.json?.error));
    check("状态：清除后 A 回到跟随全局（停用）", (await stateOf(WS_A))?.enabled === false);
    check("状态：清除全局开关无意义（400）", (await del("/me/skills/office-report/enabled", userTok)).status === 400);
    await put("/me/skills/office-report/enabled", { enabled: true }, userTok);

    // ── ④b 停用（软下架）语义：保留文件 + 不注入 + 界面标「已下架」（产品拍板）──
    // 这一组是防回归的关键：只要有人把 deliverableSkillsFor 的 enabled 过滤加回去，
    // 用户已装的技能就会在管理员停用瞬间被**从磁盘删掉**（曾经的实现就是这样）。
    const officeId = ((await get("/admin/skills", adminTok)).json?.skills ?? []).find((s) => s.name === "office-report")?.id;
    await patch(`/admin/skills/${officeId}`, { enabled: false }, adminTok);
    check(
      "停用：仍在下发集（本地文件保留，不会静默消失）",
      ((await get("/me/skills", userTok)).json?.skills ?? []).some((s) => s.name === "office-report"),
    );
    check(
      "停用：不在注入集（状态集不含它 → sidecar 不挂载）",
      !((await get("/me/skills/state", userTok)).json?.skills ?? []).some((s) => s.name === "office-report"),
    );
    check(
      "停用：「我安装的」仍列出且 available=false（界面据此标已下架）",
      ((await get("/me/skills/installed", userTok)).json?.items ?? []).find((s) => s.name === "office-report")?.available === false,
    );
    check(
      "停用：目录里不再出现（新人装不到）",
      !((await get("/me/skills/catalog", userTok)).json?.items ?? []).some((s) => s.name === "office-report"),
    );
    await patch(`/admin/skills/${officeId}`, { enabled: true }, adminTok);
    check(
      "重新上架：available 回到 true（无需用户重装）",
      ((await get("/me/skills/installed", userTok)).json?.items ?? []).find((s) => s.name === "office-report")?.available === true,
    );

    // ── 分类口径收敛（11 类 → 5 类）：别名兼容 + 未知值仍 400 ──
    const aliasSkill = await post(
      "/admin/skills",
      { name: "alias-cat", title: "别名分类", content: "# x\n", category: "finance", scope: { kind: "all" } },
      adminTok,
    );
    check("分类：旧编码 finance 被接受并归一到 office", aliasSkill.json?.skill?.category === "office", aliasSkill.json?.skill?.category);
    const aliasPatch = await post("/admin/skills", { name: "alias-patch", title: "x", content: "# x\n", scope: { kind: "all" } }, adminTok);
    const aliasPatched = await patch(`/admin/skills/${aliasPatch.json?.skill?.id}`, { category: "news" }, adminTok);
    check("分类：PATCH 旧编码 news 归一到 content", aliasPatched.json?.skill?.category === "content", aliasPatched.json?.skill?.category);
    const cats5 = (await get("/me/skills/categories", userTok)).json?.categories ?? [];
    // 注：字典登记过的编码（管理员显式命名过的越界值）属于合法存在；这里断言的是
    // **用户端可见的 categories 只含启用项**，且不冒出未登记的历史编码。
    check(
        "分类：用户端只回启用中的编码（未登记的历史编码不冒头）",
        cats5.every((c) => ["office", "dev", "data", "content", "other"].includes(c)),
        JSON.stringify(cats5),
    );

    // ── ⑤ 目录：搜索/分类/排序/分页 ──
    const second = await post(
      "/admin/skills",
      { name: "dev-lint", title: "代码巡检", description: "静态检查", content: "# 巡检\n", category: "dev", icon: "🔧", scope: { kind: "all" } },
      adminTok,
    );
    check("元数据：后台显式分类（frontmatter 无值时生效）", second.json?.skill?.category === "dev", second.json?.skill?.category);
    const searchByTitle = await get("/me/skills/catalog?q=" + encodeURIComponent("巡检"), userTok);
    check("目录：按标题搜索命中", (searchByTitle.json?.items ?? []).some((s) => s.name === "dev-lint"));
    const searchByDesc = await get("/me/skills/catalog?q=" + encodeURIComponent("静态检查"), userTok);
    check("目录：按描述搜索命中", (searchByDesc.json?.items ?? []).some((s) => s.name === "dev-lint"));
    const byCat = await get("/me/skills/catalog?category=dev", userTok);
    check("目录：分类过滤（只回 dev）", (byCat.json?.items ?? []).length >= 1 && (byCat.json?.items ?? []).every((s) => s.category === "dev"));
    const paged = await get("/me/skills/catalog?pageSize=1&page=1&sort=new", userTok);
    check("目录：分页（pageSize 生效 + total 为全量）", (paged.json?.items ?? []).length === 1 && (paged.json?.total ?? 0) >= 2, JSON.stringify({ n: paged.json?.items?.length, total: paged.json?.total }));

    /*
     * 排序口径（服务端 SkillSort）——客户端此前写死 sort=name，「最热/最新」等于白做，
     * 所以这里把**顺序**钉死（只断言"能查到"是不够的）。
     * 用本冒烟已有数据构造差异：office-report 被装过（hot>=1）且创建更早，dev-lint 没装过且更晚。
     */
    const sortNames = async (sort) => ((await get(`/me/skills/catalog?sort=${sort}&pageSize=50`, userTok)).json?.items ?? []).map((s) => s.name);
    const byHot = await sortNames('hot');
    check(
        "排序：sort=hot 按安装量降序（装过的 office-report 排在没装过的 dev-lint 前）",
        byHot.indexOf("office-report") >= 0 && byHot.indexOf("dev-lint") >= 0 && byHot.indexOf("office-report") < byHot.indexOf("dev-lint"),
        byHot.slice(0, 6),
    );
    const byNew = await sortNames('new');
    check(
        "排序：sort=new 按更新时间降序（后建的 dev-lint 排在 office-report 前）",
        byNew.indexOf("dev-lint") >= 0 && byNew.indexOf("office-report") >= 0 && byNew.indexOf("dev-lint") < byNew.indexOf("office-report"),
        byNew.slice(0, 6),
    );
    const byName1 = await sortNames('name');
    const byName2 = await sortNames('name');
    check("排序：sort=name 可复现（两次查询顺序一致）", JSON.stringify(byName1) === JSON.stringify(byName2), byName1.slice(0, 6));

    // ── ⑤b 标签筛选（分类只有 5 类粒度，细分靠标签）──
    const tagList = (await get("/me/skills/tags", userTok)).json?.tags ?? [];
    const weekly = tagList.find((t) => t.tag === "周报");
    check("标签清单：返回标签 + 使用计数", weekly?.tag === "周报" && weekly?.count >= 1, tagList);
    const byTag = await get(`/me/skills/catalog?tag=${encodeURIComponent("周报")}&pageSize=50`, userTok);
    check(
        "标签筛选：只回带该标签的技能",
        (byTag.json?.items ?? []).length >= 1 && (byTag.json?.items ?? []).every((s) => (s.tags ?? []).includes("周报")),
        (byTag.json?.items ?? []).map((s) => s.name),
    );
    const byTagNone = await get(`/me/skills/catalog?tag=${encodeURIComponent("并不存在的标签")}&pageSize=50`, userTok);
    check("标签筛选：不存在的标签回空（而不是回全量）", (byTagNone.json?.items ?? []).length === 0, byTagNone.json?.total);
    // 可见性口径：标签清单只统计**当前可见且上架**的技能 —— 停用后该标签应消失
    await patch(`/admin/skills/${allSkill.id}`, { enabled: false }, adminTok);
    const tagsAfterDisable = (await get("/me/skills/tags", userTok)).json?.tags ?? [];
    check(
        "标签清单跟随可见性：技能停用后其独有标签不再出现",
        !tagsAfterDisable.some((t) => t.tag === "周报" || t.tag === "汇报"),
        tagsAfterDisable.map((t) => t.tag),
    );
    await patch(`/admin/skills/${allSkill.id}`, { enabled: true }, adminTok);
    check(
        "重新上架后标签回来（无需额外操作）",
        ((await get("/me/skills/tags", userTok)).json?.tags ?? []).some((t) => t.tag === "周报"),
    );
    // ── ⑤c 使用量（对齐专家侧 agent_usage：按会话去重）──
    // 口径说明：安装量只能说明"装过"，不代表在用；「最热」以使用量为主。
    const useBad = await post("/me/skills/office-report/use", {}, userTok);
    check("使用量：缺 sessionId 400（按会话去重的前提）", useBad.status === 400, useBad.status);
    const use1 = await post("/me/skills/office-report/use", { sessionId: "smoke-sess-1" }, userTok);
    check("使用量：首次上报 created=true", use1.status === 200 && use1.json?.created === true, use1.json);
    const use2 = await post("/me/skills/office-report/use", { sessionId: "smoke-sess-1" }, userTok);
    check("使用量：同会话重复上报 created=false（幂等，不刷量）", use2.status === 200 && use2.json?.created === false, use2.json);
    await post("/me/skills/office-report/use", { sessionId: "smoke-sess-2" }, userTok);
    const useUnknown = await post("/me/skills/does-not-exist/use", { sessionId: "s" }, userTok);
    check("使用量：不存在的技能 404", useUnknown.status === 404, useUnknown.status);

    const catAfterUse = (await get("/me/skills/catalog?pageSize=50", userTok)).json?.items ?? [];
    const officeItem = catAfterUse.find((s) => s.name === "office-report");
    check("目录项带使用量（客户端「N 次使用」的数据来源）", officeItem?.uses === 2, officeItem?.uses);
    // 「最热」= 使用量优先（与专家侧同口径）：用过 2 次的必须排在 0 次的前面
    const byHotUse = (await get("/me/skills/catalog?sort=hot&pageSize=50", userTok)).json?.items ?? [];
    check(
        "排序：sort=hot 以使用量优先",
        byHotUse.findIndex((s) => s.name === "office-report") >= 0
        && byHotUse.findIndex((s) => s.name === "office-report") < byHotUse.findIndex((s) => s.name === "dev-lint"),
        byHotUse.slice(0, 5).map((s) => `${s.name}:${s.uses}`),
    );

    // ── ⑤d 收藏（对齐专家侧 agent_favorites：账号级、与安装独立）──
    const favOn = await put("/me/skills/dev-lint/favorite", {}, userTok);
    check("收藏：首次收藏成功", favOn.status === 200 && favOn.json?.favorited === true, favOn.json);
    const favAgain = await put("/me/skills/dev-lint/favorite", {}, userTok);
    check("收藏：重复收藏幂等（不报错）", favAgain.status === 200 && favAgain.json?.favorited === true);
    // 关键语义：收藏**不等于**安装 —— 不能因为收藏就把它塞进下发集
    const deliveredAfterFav = (await get("/me/skills", userTok)).json?.skills ?? [];
    check(
        "收藏不产生安装副作用（未安装的技能不会因收藏而下发）",
        !deliveredAfterFav.some((s) => s.name === "dev-lint"),
        deliveredAfterFav.map((s) => s.name),
    );
    const favOnly = (await get("/me/skills/catalog?favorited=1&pageSize=50", userTok)).json?.items ?? [];
    check("收藏筛选：只看我收藏的（只回 dev-lint）", favOnly.length === 1 && favOnly[0]?.name === "dev-lint", favOnly.map((s) => s.name));
    check("收藏标记随目录下发（客户端星标的数据来源）", favOnly[0]?.favorited === true);
    const favOff = await del("/me/skills/dev-lint/favorite", userTok);
    check("取消收藏成功", favOff.status === 200 && favOff.json?.favorited === false, favOff.json);
    check("取消后收藏列表为空", ((await get("/me/skills/catalog?favorited=1", userTok)).json?.items ?? []).length === 0);
    check("收藏：对不可见技能 404（不能越权标记别人的技能）", (await put("/me/skills/not-visible/favorite", {}, userTok)).status === 404);

    // ── ⑤e 受众预估（管理台「发给谁」，口径必须与可见性一致）──
    const audAll = await get(`/admin/skills/${allSkill.id}/audience`, adminTok);
    check("受众：返回可见/已安装人数", audAll.status === 200 && typeof audAll.json?.visibleUsers === "number" && typeof audAll.json?.installedUsers === "number", audAll.json);
    check("受众：全公司可见 = users 总数（>0）", (audAll.json?.visibleUsers ?? 0) > 0, audAll.json?.visibleUsers);
    // 造一个只有 1 个账号可见的技能：受众必须精确到 1（若不展开 scope 就会算成全员）
    const narrow = await post("/admin/skills", { name: "narrow-aud", title: "窄范围", content: "# x\n", scope: { kind: "user", uids: ["user"] } }, adminTok);
    const audNarrow = await get(`/admin/skills/${narrow.json?.skill?.id}/audience`, adminTok);
    check("受众：按账号范围只算命中账号（不是全员）", audNarrow.json?.visibleUsers === 1, audNarrow.json?.visibleUsers);
    await del(`/admin/skills/${narrow.json?.skill?.id}`, adminTok);
    check("受众：不存在的技能 404", (await get("/admin/skills/999999/audience", adminTok)).status === 404);

    const instItem = ((await get("/me/skills/catalog?pageSize=50", userTok)).json?.items ?? []).find((s) => s.name === "office-report");
    check("目录项带安装量（客户端「N 人安装」的数据来源）", typeof instItem?.hot === "number" && instItem.hot >= 1, instItem?.hot);

    const cats = await get("/me/skills/categories", userTok);
    check("分类清单：白名单 ∪ 实际使用", (cats.json?.categories ?? []).includes("dev") && (cats.json?.categories ?? []).includes("office"));

    // ── 分类字典（中间方案：编码固定，文案/顺序/启用可改且**不发版**）──
    const dict1 = (await get("/me/skills/categories", userTok)).json ?? {};
    check("字典：返回 items 且含文案/顺序/启用", Array.isArray(dict1.items) && dict1.items.length >= 5
        && dict1.items.every((x) => typeof x.code === "string" && typeof x.label === "string" && typeof x.sort === "number" && typeof x.enabled === "boolean"),
        dict1.items?.slice(0, 3));
    check("字典：仍兼容老调用面（categories 为启用中的 code 数组）", Array.isArray(dict1.categories) && dict1.categories.includes("office"));
    const officeRow = dict1.items.find((x) => x.code === "office");
    check("字典：带使用计数（管理台看得到影响面）", typeof officeRow?.skillCount === "number" && officeRow.skillCount >= 1, officeRow?.skillCount);

    const renamed = await patch("/admin/skill-categories/office", { label: "办公工具", sort: 5 }, adminTok);
    check("字典：改名成功（桌面端 chips 文案随之变化，无需发版）", renamed.json?.category?.label === "办公工具" && renamed.json?.category?.sort === 5, renamed.json?.category);
    const dictAfterRename = (await get("/me/skills/categories", userTok)).json?.items ?? [];
    check("字典：用户面立刻看到新文案（同一真源）", dictAfterRename.find((x) => x.code === "office")?.label === "办公工具");
    check("字典：排序变化生效（office 排到最前）", (dictAfterRename[0]?.code ?? null) === "office", dictAfterRename.map((x) => x.code));

    const disabled = await patch("/admin/skill-categories/data", { enabled: false }, adminTok);
    check("字典：停用分类成功", disabled.json?.category?.enabled === false);
    const dictAfterDisable = (await get("/me/skills/categories", userTok)).json ?? {};
    check("字典：停用后用户端 chips 不再返回它", !(dictAfterDisable.categories ?? []).includes("data"));
    // 关键：停用只影响 chips，**不影响存量技能**（否则等于静默下架一批技能）
    const dataStillDelivered = ((await get("/me/skills/catalog?pageSize=50", userTok)).json?.items ?? []).some((s) => s.name === "dev-lint");
    check("字典：停用分类不牵连存量技能（技能照常可见）", dataStillDelivered);
    await patch("/admin/skill-categories/data", { enabled: true }, adminTok);
    check("字典：可改回来（不丢数据）", ((await get("/me/skills/categories", userTok)).json?.categories ?? []).includes("data"));

    const dictBadLabel = await patch("/admin/skill-categories/office", { label: "  " }, adminTok);
    check("字典：空名称 400", dictBadLabel.status === 400, dictBadLabel.status);
    // 注意：这条用例可重复跑 —— 上一轮会把该行停用（清理只能用停用，字典刻意不支持删除），
    // 所以这里命名时**显式启用**，否则 INSERT ON CONFLICT DO NOTHING 会让它一直是停用态。
    const dictUnknown = await patch("/admin/skill-categories/no-such-code", { label: "越界分类示例", enabled: true }, adminTok);
    check("字典：给未知编码命名是允许的（越界值也能被解释，不算 404）", dictUnknown.status === 200, dictUnknown.status);
    check("字典：命名后能立刻读回（不会出现「改了看不见」）",
        ((await get("/me/skills/categories", userTok)).json?.items ?? []).some((x) => x.code === "no-such-code" && x.label === "越界分类示例"));
    // 用完即清：这条越界行只属于本用例，留着会污染"分类清单只含现行类"的断言与演示数据
    await patch("/admin/skill-categories/no-such-code", { enabled: false }, adminTok);
    check("字典：可停用越界分类（从用户端 chips 撤下）",
        !((await get("/me/skills/categories", userTok)).json?.categories ?? []).includes("no-such-code"));
    // 还原 office 文案与顺序，避免影响后续断言/演示数据
    await patch("/admin/skill-categories/office", { label: "办公协同", sort: 10 }, adminTok);


    // ── ⑥ 精选（换一换 = 换 nonce；同 nonce 可复现）──
    await patch(`/admin/skills/${allSkill.id}`, { featured: true, weight: 5 }, adminTok);
    await patch(`/admin/skills/${second.json.skill.id}`, { featured: true }, adminTok);
    const f1 = await get("/me/skills/featured?nonce=n1", userTok);
    const f1b = await get("/me/skills/featured?nonce=n1", userTok);
    check("精选：同 nonce 结果可复现", JSON.stringify((f1.json?.items ?? []).map((s) => s.name)) === JSON.stringify((f1b.json?.items ?? []).map((s) => s.name)));
    check("精选：只回 featured 的技能", (f1.json?.items ?? []).every((s) => s.featured === true) && (f1.json?.items ?? []).length >= 1);

    // ── ⑦ 默认安装（auto_install）──
    const auto = await post(
      "/admin/skills",
      { name: "compliance-check", title: "合规自检", content: "# 自检\n", category: "office", autoInstall: true, scope: { kind: "all" } },
      adminTok,
    );
    check("默认安装标记创建成功", auto.json?.skill?.autoInstall === true, auto.json?.error);
    const deliveredAuto = (await get("/me/skills", userTok)).json?.skills ?? [];
    check("默认安装：未手动安装也在下发集里", deliveredAuto.some((s) => s.name === "compliance-check"));

    // ── ⑦b 卸载留痕：默认安装的技能，用户主动卸载过就不该再被塞回来（产品语义）──
    // 反例（曾经的实现）：卸载 = 删行即失忆 → 下一次同步又因 auto_install 下发，
    // 用户视角就是"这个技能删不掉"。所以卸载必须留一行 dismissal。
    await post("/me/skills/compliance-check/install", {}, userTok);
    check("前置：默认安装技能被用户显式安装", ((await get("/me/skills/installed", userTok)).json?.items ?? []).some((s) => s.name === "compliance-check"));
    await del("/me/skills/compliance-check/install", userTok);
    check(
      "卸载后：默认安装技能不再自动下发（不会出现「删不掉」）",
      !((await get("/me/skills", userTok)).json?.skills ?? []).some((s) => s.name === "compliance-check"),
    );
    check(
      "卸载后：注入集也不含它（会话里不能再调用）",
      !((await get("/me/skills/state", userTok)).json?.skills ?? []).some((s) => s.name === "compliance-check"),
    );
    check(
      "卸载后：目录里仍可见且 installed=false（用户随时能装回来）",
      ((await get("/me/skills/catalog", userTok)).json?.items ?? []).some((s) => s.name === "compliance-check" && s.installed === false),
    );
    await post("/me/skills/compliance-check/install", {}, userTok);
    check(
      "重新安装：撤销卸载留痕，立即回到下发集",
      ((await get("/me/skills", userTok)).json?.skills ?? []).some((s) => s.name === "compliance-check"),
    );


    // ── ⑧ 套件（一等实体）：CRUD + 校验 + 安装 ──
    const badBundle = await post("/admin/bundles", { name: "empty-kit", title: "空套件", members: [], scope: { kind: "all" } }, adminTok);
    check("套件：成员为空 400", badBundle.status === 400);
    const badMember = await post("/admin/bundles", { name: "ghost-kit", title: "幽灵", members: ["nope"], scope: { kind: "all" } }, adminTok);
    check("套件：成员不存在 400", badMember.status === 400);
    const bundle = await post(
      "/admin/bundles",
      { name: "office-kit", title: "办公套件", description: "周报+合规", icon: "🧰", members: ["office-report", "compliance-check"], scope: { kind: "all" } },
      adminTok,
    );
    check("套件：创建 201", bundle.status === 201, JSON.stringify(bundle.json?.error));
    const bundleId = bundle.json?.bundle?.id;
    const meBundles = await get("/me/bundles", userTok);
    const meBundle = (meBundles.json?.bundles ?? []).find((b) => b.id === bundleId);
    check("套件：用户可见 + 成员数/已装数正确", meBundle?.memberCount === 2 && meBundle?.installedCount >= 1, JSON.stringify(meBundle));
    const detail = await get(`/me/bundles/${bundleId}`, userTok);
    check("套件：详情带成员目录项", (detail.json?.bundle?.members ?? []).length === 2);
    // 先卸载一个成员，再一键安装，验证批量幂等
    await del("/me/skills/office-report/install", userTok);
    const bi1 = await post(`/me/bundles/${bundleId}/install`, {}, userTok);
    const bi2 = await post(`/me/bundles/${bundleId}/install`, {}, userTok);
    check("套件：一键安装 200 + 幂等", bi1.status === 200 && bi2.status === 200);

    // 装套件也要能撤销「我不要它」：否则用户点了装套件，成员因旧 dismissal 仍不下发 ——
    // 表现是"按钮转了但技能没进来"，这种最难查。
    await del("/me/skills/compliance-check/install", userTok);
    check(
      "前置：成员已被用户显式卸载（不在下发集）",
      !((await get("/me/skills", userTok)).json?.skills ?? []).some((s) => s.name === "compliance-check"),
    );
    await post(`/me/bundles/${bundleId}/install`, {}, userTok);
    check(
      "装套件撤销成员上的卸载留痕（成员立即回到下发集）",
      ((await get("/me/skills", userTok)).json?.skills ?? []).some((s) => s.name === "compliance-check"),
    );

    check("套件：安装后成员齐备（allInstalled）", (await get(`/me/bundles/${bundleId}`, userTok)).json?.bundle?.allInstalled === true);

    // ── ⑨ 卸载清态（重装不继承旧停用态）──
    await put("/me/skills/office-report/enabled", { enabled: false }, userTok);
    check("卸载清理：停用生效（前置）", (await stateOf(WS_B))?.enabled === false);
    await del("/me/skills/office-report/install", userTok);
    await post("/me/skills/office-report/install", {}, userTok);
    check("卸载清理：重装后不继承旧停用态（回到默认启用）", (await stateOf(WS_B))?.enabled === true);

    // ── ⑩ 存量回填：标记在位 + **重启不会再跑**（用户 × 技能 的补写只能发生一次）──
    try {
      const pgmod = await import("pg");
      const client = new pgmod.default.Client({
        connectionString: process.env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor",
      });
      await client.connect();
      const marker = await client.query("SELECT kind FROM skill_migrations WHERE kind = 'installs_backfill_v1'");
      check("回填：迁移标记已写入", marker.rowCount === 1, marker.rowCount);
      const countBefore = Number((await client.query("SELECT COUNT(*) AS c FROM skill_installs")).rows[0].c);

      // 再起一个实例：ensureSchema 会重跑，但标记位必须挡住回填
      const second = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
        cwd: ROOT,
        env: { ...process.env, REACTOR_IDENTITY_PORT: String(PORT + 1), REACTOR_AUTH_MODE: "local" },
        stdio: "ignore",
      });
      await sleep(4000);
      const countAfter = Number((await client.query("SELECT COUNT(*) AS c FROM skill_installs")).rows[0].c);
      second.kill();
      check("回填：重启后不再补写安装记录（迁移只跑一次）", countAfter === countBefore, `${countBefore} -> ${countAfter}`);
      await client.end();
    } catch (e) {
      check("回填：可直连 PG 校验迁移守卫", false, String(e).slice(0, 200));
    }

    // ── ⑪ 可见性（角色范围）与管理面校验 ──
    const roleScoped = await post(
      "/admin/skills",
      { name: "admin-only", title: "管理员专用", content: "# 管理员专用\n", scope: { kind: "role", roles: ["platform_admin"] } },
      adminTok,
    );
    check("S-1 角色范围创建 201", roleScoped.status === 201);
    const roleSkillId = roleScoped.json?.skill?.id;
    const userCatalog = await get("/me/skills/catalog?pageSize=50", userTok);
    check("可见性：user 目录里没有管理员专用技能", !(userCatalog.json?.items ?? []).some((s) => s.name === "admin-only"));
    check("可见性：admin 目录里有", (await get("/me/skills/catalog?pageSize=50", adminTok)).json?.items?.some((s) => s.name === "admin-only") === true);
    check("越权：普通用户装不可见技能 404", (await post("/me/skills/admin-only/install", {}, userTok)).status === 404);

    const badName = await post("/admin/skills", { name: "Bad Name!", title: "x", content: "y", scope: { kind: "all" } }, adminTok);
    check("校验：非法标识 400", badName.status === 400);
    const badCat = await post("/admin/skills", { name: "bad-cat", title: "x", content: "y", category: "nope", scope: { kind: "all" } }, adminTok);
    check("校验：非法分类 400", badCat.status === 400);
    const badTags = await post("/admin/skills", { name: "bad-tags", title: "x", content: "y", tags: new Array(20).fill("t"), scope: { kind: "all" } }, adminTok);
    check("校验：标签超限 400", badTags.status === 400);
    const badWeight = await post("/admin/skills", { name: "bad-w", title: "x", content: "y", weight: 999, scope: { kind: "all" } }, adminTok);
    check("校验：权重越界 400", badWeight.status === 400);
    const badScope = await post("/admin/skills", { name: "no-role", title: "x", content: "y", scope: { kind: "role", roles: [] } }, adminTok);
    check("校验：角色范围空 400", badScope.status === 400);
    check("校验：重复标识 409", (await post("/admin/skills", { name: "admin-only", title: "dup", content: "y", scope: { kind: "all" } }, adminTok)).status === 409);
    check("越权：普通用户建技能 403", (await post("/admin/skills", { name: "user-made", title: "x", content: "y", scope: { kind: "all" } }, userTok)).status === 403);
    check("越权：普通用户读管理列表 403", (await get("/admin/skills", userTok)).status === 403);

    // ── ⑫ 后台覆盖：改了就保持，清除后 frontmatter 重新生效 ──
    await patch(`/admin/skills/${allSkill.id}`, { description: "人工改写的描述" }, adminTok);
    const overridden = (await get("/admin/skills", adminTok)).json?.skills?.find((s) => s.id === allSkill.id);
    check("覆盖：人工描述生效并记录", overridden?.description === "人工改写的描述" && (overridden?.overriddenFields ?? []).includes("description"), JSON.stringify(overridden?.overriddenFields));
    await post(`/admin/skills/${allSkill.id}/parse`, {}, adminTok);
    const stillManual = (await get("/admin/skills", adminTok)).json?.skills?.find((s) => s.id === allSkill.id);
    check("覆盖：parse 不动被覆盖字段", stillManual?.description === "人工改写的描述");
    await post(`/admin/skills/${allSkill.id}/clear-override`, { fields: ["description"] }, adminTok);
    const reparsed = (await get("/admin/skills", adminTok)).json?.skills?.find((s) => s.id === allSkill.id);
    check("覆盖：清除后 frontmatter 重新生效", reparsed?.description === "把要点整理成周报", reparsed?.description);

    // ── ⑦ 多文件技能（附属文件）：清单下发 + 按需拉取 + 安全边界 + 上限 ──
    // 只发 SKILL.md 的话，带 scripts/ 的技能到用户机器上跑不起来 —— 这是本轮的核心能力。
    const upFiles = await req("PUT", `/admin/skills/${allSkill.id}/files`, {
      files: [
        { path: "scripts/hello.py", content: "print('hi')\n" },
        { path: "references/guide.md", content: "# 指南\n" },
        { path: "assets/logo.bin", contentB64: Buffer.from([0, 1, 2, 255]).toString("base64") },
      ],
    }, adminTok);
    check("附件：批量上传 200 + 返回清单", upFiles.status === 200 && (upFiles.json?.files ?? []).length === 3, upFiles.json?.error);
    check("附件：清单带 path/size/sha256（不含内容，同步时只传清单）",
        (upFiles.json?.files ?? []).every((f) => typeof f.path === "string" && typeof f.size === "number" && /^[0-9a-f]{64}$/.test(f.sha256 ?? "")));
    check("附件：二进制也按原始字节算大小（4 字节）",
        (upFiles.json?.files ?? []).find((f) => f.path === "assets/logo.bin")?.size === 4);

    /**
     * ★ 跨线断言：清单里的 sha256 必须是**客户端落盘字节**的哈希，而不是 base64 文本的哈希。
     *
     * 为什么单列一条：客户端拿这个 sha 做两件事 —— 比对磁盘（命中就不重下）、
     * 下载后复核（不符则**拒写**）。两侧口径一旦分叉，症状是"上传成功、清单正常、
     * 详情里看得见，但用户机器上就是没这个文件"，且不报任何错。
     * 原先只有"清单带 sha256（形状正则）"这类断言，形状永远成立，抓不到口径分叉。
     */
    const shaOfBytes = (buf) => createHash("sha256").update(buf).digest("hex");
    const manifest = upFiles.json?.files ?? [];
    const binMeta = manifest.find((f) => f.path === "assets/logo.bin");
    check("附件：清单 sha256 == 落盘字节哈希（二进制，与客户端同源）",
        binMeta?.sha256 === shaOfBytes(Buffer.from([0, 1, 2, 255])), binMeta?.sha256);
    const txtMeta = manifest.find((f) => f.path === "scripts/hello.py");
    check("附件：清单 sha256 == 落盘字节哈希（文本）",
        txtMeta?.sha256 === shaOfBytes(Buffer.from("print('hi')\n", "utf8")), txtMeta?.sha256);

    // 下发集：SKILL.md 与附件清单一起给（内容按需拉）
    const deliveredWithFiles = ((await get("/me/skills", userTok)).json?.skills ?? []).find((sk) => sk.name === "office-report");
    check("附件：下发集里带文件清单（客户端据此比对本地）", (deliveredWithFiles?.files ?? []).length === 3, deliveredWithFiles?.files?.length);
    check("附件：下发清单里**没有**内容字段（避免每次同步传全量）",
        (deliveredWithFiles?.files ?? []).every((f) => f.content === undefined && f.contentB64 === undefined));

    const oneFile = await get(`/me/skills/office-report/file?path=${encodeURIComponent("scripts/hello.py")}`, userTok);
    check("附件：按需拉单个文件（文本）", oneFile.status === 200 && oneFile.json?.file?.content === "print('hi')\n", oneFile.status);
    const binFile = await get(`/me/skills/office-report/file?path=${encodeURIComponent("assets/logo.bin")}`, userTok);
    check("附件：二进制走 contentB64（字节不经过 UTF-8）",
        binFile.json?.file?.contentB64 === Buffer.from([0, 1, 2, 255]).toString("base64"), binFile.json?.file);

    // 安全边界：任何越界路径都必须被拒（写与读两侧）
    // 注意：反斜杠**不在**拒绝之列 —— 它会被规范化为 POSIX 分隔符（Windows 路径统一），
    // 所以 `scripts\win.py` 是合法路径 `scripts/win.py`，其归一化行为单独断言（见下）。
    for (const bad of ["../evil.py", "/etc/passwd", "C:/Windows/x", "a/../../b", "..", "./a.txt", "SKILL.md"]) {
        const r = await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: bad, content: "x" }] }, adminTok);
        check(`附件：拒绝越界路径 ${bad}`, r.status === 400, r.status);
    }
    // 反斜杠归一：Windows 风格路径被规范成 POSIX，不逃出目录（与"拒绝"是两种不同处理）
    const winPath = await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: "scripts\\win.py", content: "print(1)" }] }, adminTok);
    check("附件：反斜杠被归一为 POSIX 路径（scripts/win.py，不逃出目录）",
        winPath.status === 200 && (winPath.json?.files ?? []).some((f) => f.path === "scripts/win.py"), winPath.json?.files);

    const readBad = await get(`/me/skills/office-report/file?path=${encodeURIComponent("../../etc/passwd")}`, userTok);
    check("附件：读取越界路径 404（不返回目录外任何东西）", readBad.status === 404, readBad.status);
    check("附件：不存在的文件 404", (await get(`/me/skills/office-report/file?path=${encodeURIComponent("nope.txt")}`, userTok)).status === 404);

    // 上限：单文件 / 数量 / 路径重复 —— 且必须**整批拒绝**（不留半套）
    const tooBig = await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: "big.txt", content: "x".repeat(513 * 1024) }] }, adminTok);
    check("附件：单文件超限 400", tooBig.status === 400, tooBig.status);
    const tooMany = await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.txt`, content: "x" })) }, adminTok);
    check("附件：数量超限 400", tooMany.status === 400, tooMany.status);
    const dup = await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: "a.txt", content: "1" }, { path: "a.txt", content: "2" }] }, adminTok);
    check("附件：路径重复 400", dup.status === 400, dup.status);
    // 整批拒绝的验证：先建立已知基线（3 个附件），再发一次**必然失败**的请求，核对基线未被动过
    await req("PUT", `/admin/skills/${allSkill.id}/files`, {
      files: [{ path: "a.txt", content: "1" }, { path: "b.txt", content: "2" }, { path: "c.txt", content: "3" }],
    }, adminTok);
    const beforeFail = ((await get(`/admin/skills/${allSkill.id}/files`, adminTok)).json?.files ?? []).map((f) => f.path).sort();
    await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: "ok.txt", content: "x" }, { path: "../../nope.txt", content: "y" }] }, adminTok);
    const afterFail = ((await get(`/admin/skills/${allSkill.id}/files`, adminTok)).json?.files ?? []).map((f) => f.path).sort();
    check("附件：校验失败时整批拒绝、不留半套（ok.txt 也没写进去）",
        JSON.stringify(beforeFail) === JSON.stringify(afterFail), { beforeFail, afterFail });

    // 替换语义：整目录重传 = 全量覆盖（技能被重导时不该残留旧文件）
    const replaced = await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: "only.txt", content: "only" }] }, adminTok);
    check("附件：重新上传是**覆盖**语义（旧文件不残留）", replaced.status === 200 && (replaced.json?.files ?? []).length === 1, replaced.json?.files);

    // 详情接口带清单与总大小（详情弹层展示"带哪些文件"）
    const detailWithFiles = await get("/me/skills/office-report", userTok);
    check("附件：详情带清单与总大小", Array.isArray(detailWithFiles.json?.files) && typeof detailWithFiles.json?.filesTotalBytes === "number", detailWithFiles.json?.filesTotalBytes);

    // 越权：不可见技能不能读附件、也不能写
    check("附件：不可见技能读附件 404", (await get("/me/skills/admin-only/file?path=a.txt", userTok)).status === 404);
    check("附件：普通用户写附件 403", (await req("PUT", `/admin/skills/${allSkill.id}/files`, { files: [{ path: "x.txt", content: "x" }] }, userTok)).status === 403);

    // ── 清理 ──
    await del(`/admin/bundles/${bundleId}`, adminTok);
    for (const id of [allSkill?.id, second.json?.skill?.id, auto.json?.skill?.id, roleSkillId, aliasSkill.json?.skill?.id, aliasPatch.json?.skill?.id]) {
      if (id) await del(`/admin/skills/${id}`, adminTok);
    }
    check("清理后技能与套件均为空", ((await get("/admin/skills", adminTok)).json?.skills ?? []).length === 0
      && ((await get("/admin/bundles", adminTok)).json?.bundles ?? []).length === 0);
  } finally {
    child.kill();
    // 负向用例（user 角色打 /admin/skills → 403）会留痕，收尾清掉，避免污染真实审计表
    await cleanupAdminAudit({ since: STARTED_AT });
  }

  console.log(failed === 0 ? "\nSKILLS SMOKE PASS" : `\nSKILLS SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
