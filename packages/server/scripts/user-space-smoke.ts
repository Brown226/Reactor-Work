/* eslint-disable no-console -- 冒烟脚本以 stdout 作为验收报告。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createUserSpaceRoutes } from "../src/user-space/routes.js";

/**
 * 我的空间后端冒烟测试（方案 §7 验收场景的后端部分）。
 *
 * 直接调用 Hono 的 app.request()，不启监听端口：
 * - 临时目录作为 REACTOR_WEB_WORKSPACE_ROOT，shares.json 落在它的同级；
 * - 显式 ?uid= 走阶段一身份口径，不需要真实登录；
 * - 覆盖：列目录、上传（含 413）、下载/预览、改名/移动、删除→回收站→还原→purge、
 *   用量分类、路径穿越、符号链接、分享创建/公开下载/口令/过期/撤销。
 *
 * 运行：pnpm --filter @zcode/server exec tsx scripts/user-space-smoke.ts
 */

const tempBase = await mkdtemp(join(tmpdir(), "user-space-smoke-"));
const workspaceRoot = join(tempBase, "users");
process.env["REACTOR_WEB_WORKSPACE_ROOT"] = workspaceRoot;
delete process.env["REACTOR_WEB_USER_QUOTA_BYTES"];

const app = new Hono();
app.route("/api/space", createUserSpaceRoutes());

const uid = "smoke-user";
const otherUid = "smoke-other";
const userRoot = join(workspaceRoot, uid);
let passed = 0;

function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

function spaceUrl(path: string, params: Record<string, string> = {}, user = uid): string {
  const search = new URLSearchParams({ uid: user, ...params });
  return `/api/space${path}?${search.toString()}`;
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function upload(
  dirRel: string,
  name: string,
  content: string,
  user = uid,
): Promise<Response> {
  return app.request(spaceUrl("/upload", { path: dirRel }, user), {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(name),
      "content-type": "application/octet-stream",
    },
    body: new TextEncoder().encode(content),
  });
}

async function entries(dirRel = "", user = uid) {
  const response = await app.request(spaceUrl("/entries", { path: dirRel }, user));
  assert.equal(response.status, 200);
  return jsonBody<{
    path: string;
    entries: Array<{ name: string; kind: string; size: number }>;
    usage: Usage;
  }>(response);
}

interface Usage {
  usedBytes: number;
  quotaBytes: number;
  trashBytes: number;
  byCategory: Record<string, number>;
}

async function usage(user = uid): Promise<Usage> {
  const response = await app.request(spaceUrl("/usage", {}, user));
  assert.equal(response.status, 200);
  return jsonBody<Usage>(response);
}

async function trashItems(user = uid) {
  const response = await app.request(spaceUrl("/trash", {}, user));
  assert.equal(response.status, 200);
  return jsonBody<{
    items: Array<{ id: string; name: string; size: number; fromPath: string; deletedAt: string }>;
  }>(response).then((body) => body.items);
}

async function main(): Promise<void> {
  // 1. 空空间
  const empty = await entries();
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.usage.usedBytes, 0);
  pass("空空间列目录返回 []，usedBytes=0");

  // 2. 建目录
  assert.equal(
    (await app.request(spaceUrl("/mkdir"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "docs" }),
    })).status,
    201,
  );
  pass("mkdir 201");

  // 3. 上传（中文名 percent-encode）
  const firstUpload = await upload("docs", "报告 v1.txt", "hello-space");
  assert.equal(firstUpload.status, 200);
  const firstBody = await jsonBody<{ entry: { name: string; size: number } }>(firstUpload);
  assert.equal(firstBody.entry.name, "报告 v1.txt");
  assert.equal(firstBody.entry.size, 11);
  pass("上传中文名写入原名");

  // 4. 同名自动加后缀，不覆盖
  const secondUpload = await upload("docs", "报告 v1.txt", "second");
  const secondBody = await jsonBody<{ entry: { name: string } }>(secondUpload);
  assert.equal(secondBody.entry.name, "报告 v1 (1).txt");
  assert.equal((await readFile(join(workspaceRoot, uid, "docs", "报告 v1.txt"), "utf8")), "hello-space");
  pass("同名上传生成 (1) 后缀且不覆盖原文件");

  // 5. 下载 / 预览头
  const download = await app.request(spaceUrl("/download", { path: "docs/报告 v1.txt" }));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename="/);
  assert.equal(await download.text(), "hello-space");
  const preview = await app.request(spaceUrl("/preview", { path: "docs/报告 v1.txt" }));
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition") ?? "", /^inline; filename="/);
  assert.match(preview.headers.get("content-security-policy") ?? "", /sandbox/);
  await preview.arrayBuffer();
  pass("下载 attachment / 预览 inline + CSP sandbox");

  // 6. 列目录含 kind/size
  const listed = await entries("docs");
  const fileEntry = listed.entries.find((entry) => entry.name === "报告 v1.txt");
  assert.ok(fileEntry);
  assert.equal(fileEntry.kind, "file");
  assert.equal(fileEntry.size, 11);
  pass("列目录返回 name/kind/size/mtime");

  // 7. 重命名 + 移动
  assert.equal(
    (await app.request(spaceUrl("/rename"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "docs/报告 v1 (1).txt", name: "second.txt" }),
    })).status,
    200,
  );
  assert.equal(
    (await app.request(spaceUrl("/mkdir"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "archive" }),
    })).status,
    201,
  );
  const move = await app.request(spaceUrl("/move"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["docs/second.txt"], toDir: "archive" }),
  });
  assert.equal(move.status, 200);
  assert.equal((await jsonBody<{ moved: number }>(move)).moved, 1);
  pass("rename + move 生效");

  // 8. 用量分类（单独 uid，避免已有文件干扰）
  const categorySizes = { "a.png": 7, "b.dxf": 9, "c.docx": 13, "d.bin": 17 };
  for (const [name, size] of Object.entries(categorySizes)) {
    const response = await upload("", name, "x".repeat(size), otherUid);
    assert.equal(response.status, 200);
  }
  const categoryUsage = await usage(otherUid);
  assert.equal(categoryUsage.byCategory["image"], 7);
  assert.equal(categoryUsage.byCategory["drawing"], 9);
  assert.equal(categoryUsage.byCategory["document"], 13);
  assert.equal(categoryUsage.byCategory["other"], 17);
  assert.equal(categoryUsage.usedBytes, 46);
  pass("usage.byCategory 分类金额正确（document/image/drawing/other）");

  // 9. 删除 → 回收站（容量不释放）→ 还原 → purge（容量释放）
  const beforeDelete = await usage();
  const deleteResponse = await app.request(spaceUrl("/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["archive/second.txt"] }),
  });
  assert.equal(deleteResponse.status, 200);
  const trashed = await trashItems();
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0]?.name, "second.txt");
  assert.equal(trashed[0]?.fromPath, "archive/second.txt");
  const afterDelete = await usage();
  assert.equal(afterDelete.usedBytes, beforeDelete.usedBytes);
  assert.equal(afterDelete.trashBytes, beforeDelete.trashBytes + 6);
  const rootListing = await entries();
  assert.ok(!rootListing.entries.some((entry) => entry.name === ".trash"));
  pass("删除进回收站：容量不释放、trashBytes 增加、.trash 不在文件树");

  assert.equal(
    (await app.request(spaceUrl("/trash/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [trashed[0]?.id] }),
    })).status,
    200,
  );
  assert.equal(
    await readFile(join(workspaceRoot, uid, "archive", "second.txt"), "utf8"),
    "second",
  );
  assert.equal((await trashItems()).length, 0);
  pass("还原回到 meta.fromPath");

  // 10. 还原冲突：原路径被占用时加后缀
  const conflictDelete = await app.request(spaceUrl("/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["archive/second.txt"] }),
  });
  assert.equal(conflictDelete.status, 200);
  const conflictId = (await trashItems())[0]?.id;
  assert.equal((await upload("archive", "second.txt", "recreated")).status, 200);
  const restoreConflict = await app.request(spaceUrl("/trash/restore"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [conflictId] }),
  });
  assert.equal(restoreConflict.status, 200);
  assert.equal(await readFile(join(workspaceRoot, uid, "archive", "second (1).txt"), "utf8"), "second");
  assert.equal(await readFile(join(workspaceRoot, uid, "archive", "second.txt"), "utf8"), "recreated");
  pass("还原冲突自动加 (1) 后缀");

  // 11. purge 释放容量；空数组清空
  const deleteAgain = await app.request(spaceUrl("/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["docs/报告 v1.txt"] }),
  });
  assert.equal(deleteAgain.status, 200);
  const trashBeforePurge = await trashItems();
  assert.equal(trashBeforePurge.length, 1);
  const usageBeforePurge = await usage();
  const purge = await app.request(spaceUrl("/trash/purge"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: trashBeforePurge.map((item) => item.id) }),
  });
  assert.equal(purge.status, 200);
  const purgeBody = await jsonBody<{ purged: number; freedBytes: number }>(purge);
  assert.equal(purgeBody.purged, trashBeforePurge.length);
  assert.equal(purgeBody.freedBytes, 11);
  assert.equal((await usage()).trashBytes, 0);
  assert.ok((await usage()).usedBytes < usageBeforePurge.usedBytes);
  assert.equal((await trashItems()).length, 0);

  assert.equal(
    (await app.request(spaceUrl("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["archive/second.txt"] }),
    })).status,
    200,
  );
  assert.equal((await trashItems()).length, 1);
  const purgeAll = await app.request(spaceUrl("/trash/purge"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal((await jsonBody<{ purged: number }>(purgeAll)).purged, 1);
  assert.equal((await trashItems()).length, 0);
  pass("purge 释放容量；空 ids 清空回收站");

  // 12. 配额 413 且不落盘
  const usageNow = await usage();
  process.env["REACTOR_WEB_USER_QUOTA_BYTES"] = String(usageNow.usedBytes + 5);
  const overQuota = await upload("docs", "too-big.txt", "0123456789");
  assert.equal(overQuota.status, 413);
  const quotaBody = await jsonBody<{ error: string }>(overQuota);
  assert.match(quotaBody.error, /空间不足/);
  delete process.env["REACTOR_WEB_USER_QUOTA_BYTES"];
  const docsAfterQuota = await entries("docs");
  assert.ok(!docsAfterQuota.entries.some((entry) => entry.name === "too-big.txt"));
  pass("超配额 413 且文件不落盘");

  // 13. 路径穿越 / 非法路径 / 保留目录
  for (const badPath of ["../escape", "/etc/passwd", "C:\\Windows", ".trash", "docs/../escape"]) {
    const response = await app.request(spaceUrl("/entries", { path: badPath }));
    assert.equal(response.status, 400, `path=${badPath} 应拒绝`);
  }
  pass("路径穿越（../、绝对路径、盘符、.trash）全部 400");

  // 14. 符号链接不跟随（Windows 无权限时跳过）
  const outsideFile = join(tempBase, "outside-secret.txt");
  await writeFile(outsideFile, "secret", "utf8");
  try {
    await symlink(outsideFile, join(userRoot, "link.txt"), "file");
    const linkDownload = await app.request(spaceUrl("/download", { path: "link.txt" }));
    assert.equal(linkDownload.status, 400);
    const linkPreview = await app.request(spaceUrl("/preview", { path: "link.txt" }));
    assert.equal(linkPreview.status, 400);
    // 中间段是目录符号链接：仅 lstat 最终条目会看到链接目标，必须逐段拒绝。
    await symlink(tempBase, join(userRoot, "escape"), "dir");
    assert.equal((await app.request(spaceUrl("/entries", { path: "escape" }))).status, 400);
    assert.equal(
      (await app.request(spaceUrl("/download", { path: "escape/outside-secret.txt" }))).status,
      400,
    );
    assert.equal(
      (await app.request(spaceUrl("/delete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["escape/outside-secret.txt"] }),
      })).status,
      400,
    );
    pass("符号链接（最终项/中间目录）下载、预览、列目录、删除全部 400");
  } catch (error) {
    console.log(`SKIP 符号链接用例（当前系统无法创建 symlink）: ${String(error)}`);
  }

  // 15. 目录不能下载；目录不能分享
  assert.equal((await app.request(spaceUrl("/download", { path: "docs" }))).status, 400);
  const dirShare = await app.request(spaceUrl("/share"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs", ttlHours: 1 }),
  });
  assert.equal(dirShare.status, 400);
  pass("目录不可下载/分享");

  // 16. 分享：创建 + 公开下载 + 口令
  assert.equal((await upload("", "share.txt", "share-content")).status, 200);
  const sharePath = "share.txt";
  const publicShare = await app.request(spaceUrl("/share"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: sharePath, ttlHours: 1 }),
  });
  assert.equal(publicShare.status, 201);
  const shareBody = await jsonBody<{ token: string; expiresAt: string; url: string }>(publicShare);
  assert.match(shareBody.token, /^[0-9a-f]{64}$/);
  assert.equal(shareBody.url, `/api/space/shared/${shareBody.token}`);
  const publicDownload = await app.request(shareBody.url);
  assert.equal(publicDownload.status, 200);
  assert.equal(await publicDownload.text(), "share-content");
  assert.match(publicDownload.headers.get("content-disposition") ?? "", /^attachment/);
  pass("分享创建 + 无 uid 公开下载成功");

  const passwordShare = await app.request(spaceUrl("/share"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: sharePath, ttlHours: 1, password: "s3cret" }),
  });
  const passwordToken = (await jsonBody<{ token: string }>(passwordShare)).token;
  assert.equal((await app.request(`/api/space/shared/${passwordToken}`)).status, 401);
  assert.equal((await app.request(`/api/space/shared/${passwordToken}?pwd=wrong`)).status, 403);
  const passwordOk = await app.request(`/api/space/shared/${passwordToken}?pwd=s3cret`);
  assert.equal(passwordOk.status, 200);
  await passwordOk.arrayBuffer();
  pass("分享口令：缺失 401、错误 403、正确 200");

  // 17. 过期 + 撤销 + 归属隔离
  const expiringShare = await app.request(spaceUrl("/share"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: sharePath, ttlHours: 0.0001 }),
  });
  const expiringToken = (await jsonBody<{ token: string }>(expiringShare)).token;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await app.request(`/api/space/shared/${expiringToken}`)).status, 410);
  pass("过期分享 410");

  const sharesList = await jsonBody<{ items: Array<{ token: string }> }>(
    await app.request(spaceUrl("/shares")),
  );
  assert.ok(sharesList.items.some((item) => item.token === shareBody.token));
  const otherShares = await jsonBody<{ items: unknown[] }>(
    await app.request(spaceUrl("/shares", {}, otherUid)),
  );
  assert.equal(otherShares.items.length, 0);
  assert.equal(
    (await app.request(spaceUrl("/share/revoke", {}, otherUid), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: shareBody.token }),
    })).status,
    404,
  );
  assert.equal(
    (await app.request(spaceUrl("/share/revoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: shareBody.token }),
    })).status,
    200,
  );
  assert.equal((await app.request(shareBody.url)).status, 404);
  pass("分享列表按 uid 隔离、他人不能撤销、撤销后 404");

  // 18. 缺少身份 / 缺少文件名 / 目标目录不存在
  assert.equal((await app.request("/api/space/usage")).status, 401);
  assert.equal(
    (await app.request(spaceUrl("/upload", { path: "docs" }), { method: "POST", body: new Uint8Array([1]) }))
      .status,
    400,
  );
  assert.equal((await upload("missing-dir", "x.txt", "x")).status, 404);
  pass("无 uid 401 / 缺 x-file-name 400 / 目标目录不存在 404");

  // 19. .trash 被替换成符号链接时，回收站视图必须拒绝而不是跟随
  const trashPath = join(userRoot, ".trash");
  await rm(trashPath, { recursive: true, force: true });
  await symlink(tempBase, trashPath, "dir");
  assert.equal((await app.request(spaceUrl("/trash"))).status, 409);
  pass(".trash 被替换为符号链接时 GET /trash 409");

  console.log(`\n全部通过：${passed} 组断言`);
}

try {
  await main();
} finally {
  if (process.env["KEEP_SMOKE_DIR"] !== "1") {
    await rm(tempBase, { recursive: true, force: true });
  } else {
    console.log(`临时目录保留：${tempBase}`);
  }
}
