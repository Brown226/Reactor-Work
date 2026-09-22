/**
 * 软件更新（UPD）—— **PG + 路由探针**（前置：`docker compose up -d pg`；连不上打印 SKIP 并以 0 退出）。
 *
 * ## 守什么（都是"静态检查看不出来"的那类）
 *
 * ① **建表幂等**：无迁移框架，靠 `IF NOT EXISTS`，连跑两次不能抛。
 * ② **下发面真的公开**：只挂公开工厂、**不注入任何 claims** 也能取到 manifest ——
 *    桌面客户端取更新时不带 Authorization，这一条挂了就是全网客户端"检查更新失败"。
 * ③ **sha512 口径**：manifest 里的必须是 **base64**（electron-updater 的 hashFile 口径），
 *    写成 hex 客户端会判定校验不过并无限重下 —— 探针用本地独立计算值对照。
 * ④ **两步式上传**：PUT 原始字节落盘 + 校验和/大小入库；空文件被拒。
 * ⑤ **只发已上线**：草稿态取不到 manifest（404），上线后才有；下线后立刻回到 404。
 * ⑥ **Range 续传**：断点续传靠 206 + content-range，客户端大包下载强依赖。
 * ⑦ **灰度分桶稳定**：同一 device_mid 反复请求结果一致，且 rollpoutPercent=1 时能被分到桶外。
 * ⑧ **删除清产物**：删记录同时清磁盘文件，避免 manifest 指向 404 产物。
 *
 * 产物落盘目录在本脚本里指向临时目录（**动态 import 路由模块** —— UPDATE_FILE_DIR 是模块级常量，
 * 必须在 import 之前设好环境变量），跑完删除。
 *
 * 用法：`pnpm --filter @reactor/server exec tsx scripts/updates-smoke.ts`
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import type { TokenClaims } from "../src/identity/auth.js";
import { closeIdentityDb, createIdentityDb, type IdentityDb } from "../src/identity/db.js";
// 冒烟库隔离（真实库不受影响）：见 lib/smoke-db.mjs 头注（2026-09-18 市场被清空事故）
import { useSmokeDb } from "./lib/smoke-db.mjs";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

const dbUrl = () =>
  process.env["REACTOR_DB_URL"]?.trim() ||
  process.env["REACTOR_DATABASE_URL"]?.trim() ||
  "postgres://reactor:reactor@127.0.0.1:55432/reactor";

/** 造一段可校验的假安装包（内容无所谓，只要字节确定）。 */
function fakeArtifact(seed: string): Buffer {
  return Buffer.concat([Buffer.from(`REACTOR-ARTIFACT:${seed}:`), Buffer.alloc(64 * 1024, seed.charCodeAt(0) % 251)]);
}

const sha512Base64 = (bytes: Buffer): string => createHash("sha512").update(bytes).digest("base64");

async function main(): Promise<void> {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响
  try {
    await useSmokeDb();
  } catch (err) {
    // 与其余冒烟同一口径：前置 PG 不可达就 SKIP 且不算失败（本机没起 docker compose pg 是常态）
    console.log(`SKIP: 冒烟库准备失败（PG 不可达？）: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  const artifactDir = mkdtempSync(join(tmpdir(), "reactor-updates-smoke-"));
  process.env["REACTOR_UPDATE_FILE_DIR"] = artifactDir;

  let db: IdentityDb;
  try {
    db = createIdentityDb(dbUrl());
    await db.pool.query("SELECT 1");
  } catch (err) {
    console.log(`SKIP: PG 不可达（${dbUrl()}）: ${err instanceof Error ? err.message : String(err)}`);
    rmSync(artifactDir, { recursive: true, force: true });
    process.exit(0);
  }

  const createdIds: number[] = [];
  try {
    // ★ 动态 import：路由模块在模块级读 REACTOR_UPDATE_FILE_DIR，必须先设好环境变量再加载
    const { ensureUpdatesSchema } = await import("../src/updates/schema.js");
    const { createUpdatesRoutes, createUpdatesPublicRoutes } = await import("../src/updates/routes.js");

    /* ── ① 建表幂等 ──────────────────────────────────────────────────── */
    console.log("· 建表");
    await ensureUpdatesSchema(db);
    await ensureUpdatesSchema(db); // 幂等：第二次不应报错
    check("建表幂等（连跑两次不抛）", true);

    /* ── 路由装配：管理面注入 claims，下发面刻意不注入 ─────────────────── */
    const admin = new Hono<{ Variables: { claims: TokenClaims } }>();
    let currentClaims: TokenClaims = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };
    admin.use("*", async (c, next) => {
      c.set("claims", currentClaims);
      await next();
    });
    admin.route("/", createUpdatesRoutes(db));

    const publicApp = new Hono();
    publicApp.route("/", createUpdatesPublicRoutes(db));

    /** 只依赖 request 的结构类型：免得在两种 Env 泛型之间来回 cast。 */
    type Requestable = { request: (input: string, init?: RequestInit) => Promise<Response> };
    const adminApp: Requestable = admin;
    const pub: Requestable = publicApp;

    const jsonPost = (app: Requestable, path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const jsonPatch = (app: Requestable, path: string, body: unknown) =>
      app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    /* ── ② 越权拦截 ─────────────────────────────────────────────────── */
    console.log("· 管理面鉴权");
    currentClaims = { sub: "probe-user", name: "探针用户", role: "user" };
    const denied = await jsonPost(adminApp, "/admin/updates/releases", {
      platform: "windows-x64",
      channel: "stable",
      version: "9.9.9",
    });
    check("非 platform_admin 建发布 → 403", denied.status === 403, denied.status);
    currentClaims = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };

    /* ── ③ 建草稿 + 重名 409 ─────────────────────────────────────────── */
    console.log("· 发布登记（两步式）");
    const draftRes = await jsonPost(adminApp, "/admin/updates/releases", {
      platform: "windows-x64",
      channel: "stable",
      version: "1.0.0",
      releaseNotesZh: "- 首个测试版本\n- 中文说明保留换行",
      releaseNotesEn: "- first test build",
      rolloutPercent: 100,
    });
    const draft = (await draftRes.json()) as { release: { id: number; published: boolean; hasArtifact: boolean } };
    check("建草稿 → 201 且未上线、无产物", draftRes.status === 201 && !draft.release.published && !draft.release.hasArtifact, draft);
    createdIds.push(draft.release.id);

    const dup = await jsonPost(adminApp, "/admin/updates/releases", {
      platform: "windows-x64",
      channel: "stable",
      version: "1.0.0",
    });
    check("同平台同通道重复版本 → 409", dup.status === 409, dup.status);

    const badVersion = await jsonPost(adminApp, "/admin/updates/releases", {
      platform: "windows-x64",
      channel: "stable",
      version: "vNext",
    });
    check("非语义化版本号 → 400", badVersion.status === 400, badVersion.status);

    /* ── ④ 产物上传（原始字节流）+ 校验和口径 ───────────────────────── */
    const artifact = fakeArtifact("win-x64-1.0.0");
    const uploadRes = await adminApp.request(`/admin/updates/releases/${draft.release.id}/file`, {
      method: "PUT",
      headers: { "x-file-name": "Reactor-1.0.0-setup.exe", "content-type": "application/octet-stream" },
      body: artifact,
    });
    const uploaded = (await uploadRes.json()) as { release: { hasArtifact: boolean; sizeBytes: number; fileName: string } };
    check("上传产物 → 200 且登记成功", uploadRes.status === 200 && uploaded.release.hasArtifact, uploaded);
    check("大小按真实字节数入库", uploaded.release.sizeBytes === artifact.length, uploaded.release.sizeBytes);
    check("原始文件名保留（供 UI 与下载头）", uploaded.release.fileName === "Reactor-1.0.0-setup.exe", uploaded.release.fileName);

    const badType = await adminApp.request(`/admin/updates/releases/${draft.release.id}/file`, {
      method: "PUT",
      headers: { "x-file-name": "setup.apk", "content-type": "application/octet-stream" },
      body: artifact,
    });
    check("非白名单后缀 → 400", badType.status === 400, badType.status);

    const empty = await adminApp.request(`/admin/updates/releases/${draft.release.id}/file`, {
      method: "PUT",
      headers: { "x-file-name": "empty.exe", "content-type": "application/octet-stream" },
      body: Buffer.alloc(0),
    });
    check("空文件 → 400", empty.status === 400, empty.status);

    /* ── ⑤ 未上线时下发面必须 404 ───────────────────────────────────── */
    console.log("· 下发面（公开、无 Authorization）");
    const beforePublish = await publicApp.request(
      "/api/v1/releases/electron/manifest?platform=windows-x64&channel=1",
    );
    check("草稿态取 manifest → 404（不泄露未发布版本）", beforePublish.status === 404, beforePublish.status);

    /* ── ⑥ 上线 + manifest 字段契约 ─────────────────────────────────── */
    const publishRes = await jsonPatch(adminApp, `/admin/updates/releases/${draft.release.id}`, {
      published: true,
    });
    const published = (await publishRes.json()) as { release: { published: boolean; publishedAt: string | null } };
    check("上线 → 200 且写入 publishedAt", publishRes.status === 200 && published.release.published && Boolean(published.release.publishedAt), published);

    const manifestRes = await publicApp.request(
      "/api/v1/releases/electron/manifest?platform=windows-x64&channel=1&device_mid=probe-mid-1",
    );
    const manifestText = await manifestRes.text();
    const manifest = JSON.parse(manifestText) as {
      version: string;
      files: Array<{ url: string; sha512: string; size: number }>;
      releaseNotesByLocale: Record<string, { markdown: string }>;
    };
    check("公开取 manifest → 200（无 Authorization 也能拿到）", manifestRes.status === 200, manifestRes.status);
    check("manifest 版本正确", manifest.version === "1.0.0", manifest.version);
    check(
      "sha512 为 base64 口径且与本地独立计算一致",
      manifest.files?.[0]?.sha512 === sha512Base64(artifact),
      { got: manifest.files?.[0]?.sha512?.slice(0, 16), want: sha512Base64(artifact).slice(0, 16) },
    );
    check("files[0].url 指向下发路径", manifest.files?.[0]?.url?.startsWith("/api/v1/releases/electron/files/") === true, manifest.files?.[0]?.url);
    check("中英文本地化说明都在", Boolean(manifest.releaseNotesByLocale?.["zh-CN"]?.markdown && manifest.releaseNotesByLocale?.["en-US"]?.markdown), Object.keys(manifest.releaseNotesByLocale ?? {}));

    /* ── ⑦ 产物下载 + Range 续传 ────────────────────────────────────── */
    const fileUrl = manifest.files[0]!.url;
    const fullRes = await publicApp.request(fileUrl);
    const fullBytes = Buffer.from(await fullRes.arrayBuffer());
    check("产物下载 200 且字节一致", fullRes.status === 200 && fullBytes.equals(artifact), fullRes.status);
    check("下载头带校验和（便于排查）", fullRes.headers.get("x-checksum-sha512") === sha512Base64(artifact));

    const rangeRes = await publicApp.request(fileUrl, { headers: { range: "bytes=10-19" } });
    const rangeBytes = Buffer.from(await rangeRes.arrayBuffer());
    check(
      "Range 请求 → 206 且切片正确",
      rangeRes.status === 206 && rangeBytes.equals(artifact.subarray(10, 20)) && rangeRes.headers.get("content-range") === `bytes 10-19/${artifact.length}`,
      { status: rangeRes.status, cr: rangeRes.headers.get("content-range") },
    );

    /* ── ⑧ 灰度分桶：同一 mid 结果稳定，且能落到桶外 ─────────────────── */
    console.log("· 灰度");
    await jsonPatch(adminApp, `/admin/updates/releases/${draft.release.id}`, { rolloutPercent: 1 });
    const midResults: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await publicApp.request(
        `/api/v1/releases/electron/manifest?platform=windows-x64&channel=1&device_mid=probe-mid-${i}`,
      );
      midResults.push(res.status);
    }
    const again = await publicApp.request(
      "/api/v1/releases/electron/manifest?platform=windows-x64&channel=1&device_mid=probe-mid-0",
    );
    check("同一 device_mid 重复请求结果一致（分桶稳定）", again.status === midResults[0], { first: midResults[0], again: again.status });
    check("1% 灰度下有设备被分到桶外", midResults.includes(404), midResults);
    await jsonPatch(adminApp, `/admin/updates/releases/${draft.release.id}`, { rolloutPercent: 100 });

    /* ── ⑨ 下线 → 立刻 404；删除 → 清磁盘产物 ───────────────────────── */
    console.log("· 下线与删除");
    await jsonPatch(adminApp, `/admin/updates/releases/${draft.release.id}`, { published: false });
    const afterUnpublish = await publicApp.request(
      "/api/v1/releases/electron/manifest?platform=windows-x64&channel=1&device_mid=probe-mid-0",
    );
    check("下线后 manifest → 404", afterUnpublish.status === 404, afterUnpublish.status);

    const storedName = decodeURIComponent(fileUrl.slice(fileUrl.lastIndexOf("/") + 1));
    check("产物文件确实落在更新目录", existsSync(join(artifactDir, storedName)));

    const deleteRes = await adminApp.request(`/admin/updates/releases/${draft.release.id}`, { method: "DELETE" });
    check("删除记录 → 200", deleteRes.status === 200, deleteRes.status);
    createdIds.length = 0;
    check("磁盘产物被一并清理（不留孤儿包）", !existsSync(join(artifactDir, storedName)));
  } finally {
    for (const id of createdIds) {
      await db.pool.query("DELETE FROM app_release WHERE id = $1", [id]).catch(() => undefined);
    }
    await closeIdentityDb(db).catch(() => undefined);
    rmSync(artifactDir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\n全部断言通过" : `\n有 ${failed} 条断言失败`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
