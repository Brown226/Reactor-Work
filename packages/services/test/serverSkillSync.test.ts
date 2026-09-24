import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import { createServerSkillSyncService } from "../src/server-skills/serverSkillSyncService.js";
import { resolveServerSkillRoot } from "../src/server-skills/serverSkillsRoot.js";

/**
 * server-skills 同步器行为测试。
 * 覆盖契约 docs/server-skill-sync.md 的核心失败语义与增量口径：
 * 离线零删、401 区分、附件 sha 短路与二进制哈希、硬收回删目录、卸载链路。
 */

interface FakeServerRoute {
  method: string;
  match: RegExp;
  status?: number;
  body?: unknown;
}

function createFakeApiClient(routes: FakeServerRoute[]): ApiClient {
  return {
    async request(input, init) {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const route = routes.find((item) => item.match.test(url) && item.method === method);
      if (!route) {
        return new Response(JSON.stringify({ error: { code: "404", message: "no route" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const status = route.status ?? 200;
      return new Response(JSON.stringify(route.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function fakeReactorServer(loggedIn: boolean) {
  return {
    getStatus: async () => ({
      configured: loggedIn,
      loggedIn,
      serverUrl: loggedIn ? "http://server.test:8791" : null,
      gatewayBaseUrl: null,
      user: null,
      models: [],
      lastError: null,
    }),
  };
}

function fakeCredentials() {
  return {
    load: async (key: string) => (key === "reactor:accessToken" ? "token-abc" : null),
    save: async () => {},
    delete: async () => {},
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const SKILL_MD = "---\nname: alpha\ndescription: test skill\n---\n\nAlpha body\n";

function deliverableBody(extra: Record<string, unknown> = {}): unknown {
  return {
    skills: [
      {
        name: "alpha",
        title: "Alpha",
        description: "test skill",
        content: SKILL_MD,
        version: "1.0.0",
        disableModelInvocation: false,
        files: [],
        ...extra,
      },
    ],
  };
}

/** 市场目录条目（对齐服务端 `SkillCatalogItem` 形状，见 shared `server-skills-market-types.ts`）。 */
function catalogItem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: "alpha",
    title: "Alpha",
    description: "test skill",
    icon: "📊",
    category: "data",
    tags: ["excel"],
    author: "官方",
    version: "1.0.0",
    featured: false,
    hot: 3,
    uses: 7,
    autoInstall: false,
    disableModelInvocation: false,
    updatedAt: "2026-09-01T00:00:00.000Z",
    installed: false,
    favorited: false,
    enabled: true,
    hasUpdate: false,
    ...extra,
  };
}

test("sync 写入 SKILL.md 并在第二次调用时保持幂等（无变更零写入）", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-sync-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const apiClient = createFakeApiClient([
      { method: "GET", match: /\/me\/skills$/, body: deliverableBody() },
      {
        method: "GET",
        match: /\/me\/skills\/state/,
        body: { skills: [{ name: "alpha", enabled: true }] },
      },
    ]);
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const first = await service.sync();
    assert.equal(first.offline, false);
    assert.deepEqual(first.changed, ["alpha"]);
    assert.deepEqual(first.names, ["alpha"]);
    assert.deepEqual(first.errors, []);

    const skillMd = join(resolveServerSkillRoot(), "alpha", "SKILL.md");
    assert.equal(await readFile(skillMd, "utf-8"), SKILL_MD);
    const { mtimeMs } = await (await import("node:fs/promises")).stat(skillMd);

    // 等 5ms 让 mtime 有机会变化；第二次 sync 不应重写文件。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.sync();
    assert.deepEqual(second.changed, []);
    assert.equal((await (await import("node:fs/promises")).stat(skillMd)).mtimeMs, mtimeMs);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test("离线（5xx）时零删除零写盘，本地副本完整保留", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-offline-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // 预置一个本地已有技能（模拟上次同步的成果）。
    const localDir = join(resolveServerSkillRoot(), "alpha");
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, "SKILL.md"), SKILL_MD, "utf-8");

    const apiClient = createFakeApiClient([
      {
        method: "GET",
        match: /\/me\/skills$/,
        status: 503,
        body: { error: { code: "503", message: "down" } },
      },
    ]);
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const result = await service.sync();
    assert.equal(result.offline, true);
    assert.equal(result.authExpired, false);
    assert.deepEqual(result.removed, []);
    assert.equal(await readFile(join(localDir, "SKILL.md"), "utf-8"), SKILL_MD);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("401 判定为 authExpired（区别于离线），同样不动本地", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-auth-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const localDir = join(resolveServerSkillRoot(), "alpha");
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, "SKILL.md"), SKILL_MD, "utf-8");

    const apiClient = createFakeApiClient([
      {
        method: "GET",
        match: /\/me\/skills$/,
        status: 401,
        body: { error: { code: "401", message: "expired" } },
      },
    ]);
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const result = await service.sync();
    assert.equal(result.authExpired, true);
    assert.equal(result.offline, false);
    assert.equal(await readFile(join(localDir, "SKILL.md"), "utf-8"), SKILL_MD);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("附件增量：sha 一致不重拉；二进制按解码后字节校验后写盘", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-attach-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const binaryBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10]);
    let fileRequests = 0;
    const apiClient: ApiClient = {
      async request(input, init) {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && /\/me\/skills$/.test(url)) {
          return new Response(
            JSON.stringify(
              deliverableBody({
                files: [
                  {
                    path: "assets/data.bin",
                    size: binaryBytes.length,
                    sha256: sha256(binaryBytes),
                    executable: false,
                  },
                  {
                    path: "docs/readme.txt",
                    size: 5,
                    sha256: sha256(Buffer.from("hello")),
                    executable: false,
                  },
                ],
              }),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "GET" && /\/file\?path=/.test(url)) {
          fileRequests += 1;
          const path = decodeURIComponent(new URL(url).searchParams.get("path") ?? "");
          if (path === "assets/data.bin") {
            return new Response(
              JSON.stringify({
                file: {
                  path,
                  contentB64: binaryBytes.toString("base64"),
                  sha256: sha256(binaryBytes),
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              file: { path, content: "hello", sha256: sha256(Buffer.from("hello")) },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "GET" && /\/me\/skills\/state/.test(url)) {
          return new Response(JSON.stringify({ skills: [{ name: "alpha", enabled: true }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      },
    };
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const first = await service.sync();
    assert.deepEqual(first.changed, ["alpha"]);
    assert.deepEqual(first.errors, []);
    assert.equal(fileRequests, 2, "两个附件都应各拉一次");
    assert.deepEqual(
      await readFile(join(resolveServerSkillRoot(), "alpha", "assets", "data.bin")),
      binaryBytes,
    );
    assert.equal(
      await readFile(join(resolveServerSkillRoot(), "alpha", "docs", "readme.txt"), "utf-8"),
      "hello",
    );

    // 第二次 sync：sha 全部一致，不应再发起 /file 请求。
    const second = await service.sync();
    assert.equal(fileRequests, 2, "sha 短路命中后不得重拉附件");
    assert.deepEqual(second.changed, []);

    // 篡改本地二进制附件：哈希不符 → 重拉并修复。
    await writeFile(
      join(resolveServerSkillRoot(), "alpha", "assets", "data.bin"),
      Buffer.from([0x00]),
    );
    const third = await service.sync();
    assert.equal(fileRequests, 3);
    assert.deepEqual(third.changed, ["alpha"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("硬收回：落盘集之外的合法名目录被删除；非法名内容不动", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-revoke-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const staleDir = join(resolveServerSkillRoot(), "gone-skill");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "SKILL.md"), "stale", "utf-8");
    // 非技能名内容（用户放的文件 / 特殊目录）不在写入面，必须原样保留。
    const foreignDir = join(resolveServerSkillRoot(), "Not-A-Valid_Name");
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, "keep.txt"), "keep", "utf-8");

    const apiClient = createFakeApiClient([
      { method: "GET", match: /\/me\/skills$/, body: deliverableBody() },
      {
        method: "GET",
        match: /\/me\/skills\/state/,
        body: { skills: [{ name: "alpha", enabled: true }] },
      },
    ]);
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const result = await service.sync();
    assert.deepEqual(result.removed, ["gone-skill"]);
    // readdir 顺序不保证，排序后比较：合法名技能同步到位，非技能名内容原样保留。
    assert.deepEqual((await readdir(resolveServerSkillRoot())).sort(), [
      "Not-A-Valid_Name",
      "alpha",
    ]);
    assert.equal(await readFile(join(foreignDir, "keep.txt"), "utf-8"), "keep");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("软下架：在落盘集但不在注入集 → disabledNames 投影，文件不删", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-soft-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const apiClient = createFakeApiClient([
      { method: "GET", match: /\/me\/skills$/, body: deliverableBody() },
      { method: "GET", match: /\/me\/skills\/state/, body: { skills: [] } },
    ]);
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const result = await service.sync();
    assert.deepEqual(result.disabledNames, ["alpha"]);
    assert.deepEqual(result.removed, []);
    assert.equal(
      await readFile(join(resolveServerSkillRoot(), "alpha", "SKILL.md"), "utf-8"),
      SKILL_MD,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("非法技能名 / 越界附件路径：拒绝落盘并记 errors，不影响其它技能", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-invalid-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const apiClient = createFakeApiClient([
      {
        method: "GET",
        match: /\/me\/skills$/,
        body: {
          skills: [
            {
              name: "Bad_Name",
              title: "x",
              description: "",
              content: "body",
              version: "1",
              files: [],
            },
            {
              name: "alpha",
              title: "Alpha",
              description: "",
              content: SKILL_MD,
              version: "1",
              files: [{ path: "../escape.txt", size: 1, sha256: "x", executable: false }],
            },
          ],
        },
      },
      {
        method: "GET",
        match: /\/me\/skills\/state/,
        body: { skills: [{ name: "alpha", enabled: true }] },
      },
    ]);
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const result = await service.sync();
    assert.deepEqual(result.names, ["alpha"]);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0] ?? "", /非法技能名/);
    assert.match(result.errors[1] ?? "", /附件路径非法/);
    assert.deepEqual(await readdir(join(resolveServerSkillRoot(), "alpha")), ["SKILL.md"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("卸载：服务端确认后删本地；404 也清理残留；5xx 不删本地并抛出", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-uninstall-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const localDir = join(resolveServerSkillRoot(), "alpha");
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, "SKILL.md"), SKILL_MD, "utf-8");

    // 5xx：服务端未确认 → 不删本地，抛错。
    const failing = createServerSkillSyncService({
      apiClient: createFakeApiClient([
        {
          method: "DELETE",
          match: /\/install$/,
          status: 500,
          body: { error: { code: "500", message: "boom" } },
        },
      ]),
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });
    await assert.rejects(() => failing.uninstall("alpha"), /卸载失败/);
    assert.equal(await readFile(join(localDir, "SKILL.md"), "utf-8"), SKILL_MD);

    // 404：服务端已无安装记录 → 仍清理本地残留。
    const alreadyGone = createServerSkillSyncService({
      apiClient: createFakeApiClient([
        {
          method: "DELETE",
          match: /\/install$/,
          status: 404,
          body: { error: { code: "404", message: "gone" } },
        },
      ]),
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });
    await alreadyGone.uninstall("alpha");
    await assert.rejects(() => readFile(join(localDir, "SKILL.md"), "utf-8"), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("未登录：不发起任何请求，skippedNotLoggedIn", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-nologin-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let requested = false;
    const apiClient: ApiClient = {
      async request() {
        requested = true;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(false),
    });

    const result = await service.sync();
    assert.equal(result.skippedNotLoggedIn, true);
    assert.equal(requested, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("syncCatalog：目录+精选写入进程内投影；非法名/重复丢弃；失败保留旧值且零磁盘写", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-catalog-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // 预置本地落盘技能：syncCatalog 无论成败都不该碰它。
    const localDir = join(resolveServerSkillRoot(), "alpha");
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, "SKILL.md"), SKILL_MD, "utf-8");

    let offline = false;
    const apiClient: ApiClient = {
      async request(input, init) {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (offline) {
          return new Response(JSON.stringify({ error: { code: "503", message: "down" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && /\/me\/skills\/catalog/.test(url)) {
          return new Response(
            JSON.stringify({
              items: [
                catalogItem(),
                catalogItem({ id: 2, name: "beta", title: "Beta" }),
                // 非法名（不能安全作目录名）整条丢弃；重复 name 去重取首。
                catalogItem({ id: 3, name: "Bad_Name" }),
                catalogItem({ id: 99, name: "alpha", title: "dup" }),
              ],
              total: 3,
              page: 1,
              pageSize: 24,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "GET" && /\/me\/skills\/featured/.test(url)) {
          return new Response(
            JSON.stringify({ items: [catalogItem({ featured: true })], nonce: "n" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      },
    };
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const ok = await service.syncCatalog();
    assert.equal(ok.offline, false);
    assert.equal(ok.skippedNotLoggedIn, false);
    assert.deepEqual(
      ok.catalog.map((item) => item.name),
      ["alpha", "beta"],
    );
    assert.deepEqual(
      ok.featured.map((item) => item.name),
      ["alpha"],
    );
    // 缺字段兜底：服务端无独立 installEnabled 位 → 与 enabled 同义。
    assert.equal(ok.catalog[0]?.installEnabled, true);
    assert.equal(ok.catalog[0]?.uses, 7);
    assert.deepEqual(
      (await service.getCatalog()).map((item) => item.name),
      ["alpha", "beta"],
    );

    // 拉取失败：投影保留上一次成功值，本地落盘分毫不动。
    offline = true;
    const failed = await service.syncCatalog();
    assert.equal(failed.offline, true);
    assert.equal(failed.authExpired, false);
    assert.match(failed.errors[0] ?? "", /读取技能市场目录失败/);
    assert.deepEqual(
      failed.catalog.map((item) => item.name),
      ["alpha", "beta"],
    );
    assert.equal(await readFile(join(localDir, "SKILL.md"), "utf-8"), SKILL_MD);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test("install：POST 成功后 re-GET 落盘 reconcile；非法名在发请求前拒绝", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-install-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    let installPosts = 0;
    const apiClient = createFakeApiClient([
      {
        method: "POST",
        match: /\/install$/,
        body: { ok: true, affected: ["alpha"], skill: catalogItem({ installed: true }) },
      },
      { method: "GET", match: /\/me\/skills$/, body: deliverableBody() },
      {
        method: "GET",
        match: /\/me\/skills\/state/,
        body: { skills: [{ name: "alpha", enabled: true }] },
      },
    ]);
    const countingClient: ApiClient = {
      async request(input, init) {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && String(input).endsWith("/install")) installPosts += 1;
        return apiClient.request(input, init);
      },
    };
    const service = createServerSkillSyncService({
      apiClient: countingClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    // 非法名：本地直接拒绝，不打服务端（防线 1，与 shared 契约同口径）。
    await assert.rejects(() => service.install("Bad_Name"), /非法技能名/);
    assert.equal(installPosts, 0);

    const result = await service.install("alpha");
    assert.equal(installPosts, 1);
    assert.deepEqual(result.names, ["alpha"]);
    assert.deepEqual(result.errors, []);
    // 写后 re-GET + 落盘 reconcile：文件来自 GET /me/skills，而非本地推算。
    assert.equal(
      await readFile(join(resolveServerSkillRoot(), "alpha", "SKILL.md"), "utf-8"),
      SKILL_MD,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test("setFavorite：true 走 PUT、false 走 DELETE；写后 re-GET 刷新投影，re-GET 失败标注「收藏已生效」", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-favorite-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const favoriteMethods: string[] = [];
    let favorited = false;
    let catalogDown = false;
    const apiClient: ApiClient = {
      async request(input, init) {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "PUT" && url.endsWith("/favorite")) {
          favoriteMethods.push("PUT");
          favorited = true;
          return new Response(JSON.stringify({ ok: true, favorited: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "DELETE" && url.endsWith("/favorite")) {
          favoriteMethods.push("DELETE");
          favorited = false;
          return new Response(JSON.stringify({ ok: true, favorited: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (catalogDown) {
          return new Response(JSON.stringify({ error: { code: "503", message: "down" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && /\/me\/skills\/catalog/.test(url)) {
          return new Response(
            JSON.stringify({
              items: [catalogItem({ favorited })],
              total: 1,
              page: 1,
              pageSize: 24,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "GET" && /\/me\/skills\/featured/.test(url)) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      },
    };
    const service = createServerSkillSyncService({
      apiClient,
      credentials: fakeCredentials(),
      reactorServer: fakeReactorServer(true),
    });

    const added = await service.setFavorite("alpha", true);
    assert.deepEqual(favoriteMethods, ["PUT"]);
    assert.deepEqual(added.errors, []);
    assert.equal((await service.getCatalog())[0]?.favorited, true);

    const removed = await service.setFavorite("alpha", false);
    assert.equal(removed.offline, false);
    assert.deepEqual(favoriteMethods, ["PUT", "DELETE"]);
    assert.equal((await service.getCatalog())[0]?.favorited, false);

    // 写已生效但 re-GET 失败：标 offline + 「收藏已生效」，旧投影不被覆盖、磁盘不动。
    catalogDown = true;
    const degraded = await service.setFavorite("alpha", true);
    assert.equal(degraded.offline, true);
    assert.match(degraded.errors[0] ?? "", /收藏已生效，但读取技能市场目录失败/);
    assert.equal((await service.getCatalog())[0]?.favorited, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});
