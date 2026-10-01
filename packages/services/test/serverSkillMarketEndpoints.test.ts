import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import {
  normalizeServerSkillBundleList,
  normalizeServerSkillDetail,
} from "@zcode/shared";
import { createServerSkillSyncService } from "../src/server-skills/serverSkillSyncService.js";
import { resolveServerSkillRoot } from "../src/server-skills/serverSkillsRoot.js";

/**
 * M2 市场出口（技能详情 `GET /me/skills/:name`、套件 `/me/bundles*`）的行为测试。
 * 覆盖：shared normalize 兜底口径、服务端 404 透传、套件整套安装后的落盘 reconcile。
 * 端点形状事实源：server/packages/server/src/skills/routes.ts（只读参考）。
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

const SKILL_MD = "---\nname: alpha\ndescription: test skill\nallowed-tools: Read Grep\n---\n\nAlpha body\n";

/** `GET /me/skills/:name` 详情响应（对齐服务端 routes：skill + content + allowedTools + files）。 */
function detailBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill: {
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
    },
    content: SKILL_MD,
    allowedTools: ["Read", "Grep"],
    files: [
      { path: "assets/data.bin", size: 12, sha256: "aa", executable: false },
      { path: "docs/readme.txt", size: 5, sha256: "bb", executable: true },
    ],
    filesTotalBytes: 17,
    ...extra,
  };
}

/** 套件摘要（对齐服务端 `GET /me/bundles` 条目）。 */
function bundleSummary(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    name: "office-kit",
    title: "办公套件",
    description: "办公三件套",
    icon: "🧰",
    enabled: true,
    memberCount: 3,
    installedCount: 1,
    allInstalled: false,
    ...extra,
  };
}

test("normalizeServerSkillDetail：字段兜底 + 非法附件 path 丢弃 + filesTotalBytes 缺省按求和", () => {
  const detail = normalizeServerSkillDetail(
    detailBody({
      files: [
        { path: "ok.txt", size: 3, sha256: "aa", executable: false },
        { path: "", size: 9, sha256: "cc", executable: false },
        "not-an-object",
      ],
      filesTotalBytes: undefined,
    }),
  );
  assert.equal(detail.skill?.name, "alpha");
  assert.equal(detail.content, SKILL_MD);
  assert.deepEqual(detail.allowedTools, ["Read", "Grep"]);
  assert.deepEqual(
    detail.files.map((file) => file.path),
    ["ok.txt"],
  );
  assert.equal(detail.filesTotalBytes, 3);
});

test("normalizeServerSkillDetail：畸形响应不抛错，正文缺省为空串（UI 空态）", () => {
  const detail = normalizeServerSkillDetail(null);
  assert.equal(detail.skill, null);
  assert.equal(detail.content, "");
  assert.deepEqual(detail.allowedTools, []);
  assert.deepEqual(detail.files, []);
  assert.equal(detail.filesTotalBytes, 0);
});

test("getDetail：走 GET /me/skills/:name 并归一化；非法技能名在发起请求前拒绝", async () => {
  let detailRequests = 0;
  const apiClient = createFakeApiClient([
    {
      method: "GET",
      match: /\/me\/skills\/alpha$/,
      body: (() => {
        detailRequests += 1;
        return detailBody();
      })(),
    },
  ]);
  const service = createServerSkillSyncService({
    apiClient,
    credentials: fakeCredentials(),
    reactorServer: fakeReactorServer(true),
  });

  const detail = await service.getDetail("alpha");
  assert.equal(detailRequests, 1);
  assert.equal(detail.skill?.title, "Alpha");
  assert.equal(detail.files.length, 2);

  await assert.rejects(service.getDetail("../escape"), /非法技能名/);
  assert.equal(detailRequests, 1, "非法名不得发出任何请求");
});

test("getDetail：服务端 404 原样抛出（技能不存在/不可见）", async () => {
  const apiClient = createFakeApiClient([
    {
      method: "GET",
      match: /\/me\/skills\/alpha$/,
      status: 404,
      body: { error: { code: "404", message: "技能不存在或对你不可见" } },
    },
  ]);
  const service = createServerSkillSyncService({
    apiClient,
    credentials: fakeCredentials(),
    reactorServer: fakeReactorServer(true),
  });
  await assert.rejects(service.getDetail("alpha"), /技能不存在或对你不可见/);
});

test("listBundles：丢非法条目、按 id 去重", async () => {
  const list = normalizeServerSkillBundleList({
    bundles: [
      bundleSummary(),
      bundleSummary({ id: 7 }), // 重复 id 去重
      bundleSummary({ id: 0, name: "bad-id" }), // 非法 id 丢弃
      bundleSummary({ id: 8, name: "" }), // 空 name 丢弃
    ],
  });
  assert.deepEqual(
    list.map((bundle) => bundle.id),
    [7],
  );
});

test("getBundleDetail：成员按 catalog 条目归一化；形状不符抛错", async () => {
  const apiClient = createFakeApiClient([
    {
      method: "GET",
      match: /\/me\/bundles\/7$/,
      body: {
        bundle: {
          ...bundleSummary(),
          members: [
            {
              id: 11,
              name: "alpha",
              title: "Alpha",
              description: "test skill",
              tags: [],
              version: "1.0.0",
              installed: true,
              enabled: true,
            },
            { name: "Bad Name" }, // 非法 name：丢整条
          ],
        },
      },
    },
  ]);
  const service = createServerSkillSyncService({
    apiClient,
    credentials: fakeCredentials(),
    reactorServer: fakeReactorServer(true),
  });

  const detail = await service.getBundleDetail(7);
  assert.equal(detail.title, "办公套件");
  // shared 归一化纪律：非法 name 丢整条（id 缺省兜 0、title 退回 name 都不算非法）。
  assert.deepEqual(
    detail.members.map((member) => member.name),
    ["alpha"],
  );
  assert.equal(detail.members[0]?.installed, true);

  const badClient = createFakeApiClient([
    { method: "GET", match: /\/me\/bundles\/7$/, body: { unexpected: true } },
  ]);
  const badService = createServerSkillSyncService({
    apiClient: badClient,
    credentials: fakeCredentials(),
    reactorServer: fakeReactorServer(true),
  });
  await assert.rejects(badService.getBundleDetail(7), /形状不符/);
});

test("installBundle：POST 套件安装后 re-GET 落盘 reconcile，成员写进 server-skills/", async () => {
  const home = await mkdtemp(join(tmpdir(), "server-skill-bundle-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const apiClient = createFakeApiClient([
      {
        method: "POST",
        match: /\/me\/bundles\/7\/install$/,
        body: { ok: true, affected: ["alpha"] },
      },
      {
        // 落盘集（GET /me/skills$ 不匹配 /state 子路径）：套装安装后 alpha 进入下发集。
        method: "GET",
        match: /\/me\/skills$/,
        body: {
          skills: [
            {
              name: "alpha",
              title: "Alpha",
              description: "test skill",
              content: SKILL_MD,
              version: "1.0.0",
              disableModelInvocation: false,
              files: [],
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

    const result = await service.installBundle(7);
    assert.equal(result.offline, false);
    assert.deepEqual(result.names, ["alpha"]);
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

test("installBundle：非法 id 与未登录在发起请求前拒绝", async () => {
  let postRequests = 0;
  const apiClient: ApiClient = {
    async request(input, init) {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && /\/me\/bundles\/\d+\/install/.test(String(input))) {
        postRequests += 1;
      }
      return new Response(JSON.stringify({ ok: true, affected: [] }), { status: 200 });
    },
  };
  const service = createServerSkillSyncService({
    apiClient,
    credentials: fakeCredentials(),
    reactorServer: fakeReactorServer(true),
  });
  await assert.rejects(service.installBundle(0), /非法套件 id/);
  await assert.rejects(service.installBundle(1.5), /非法套件 id/);
  assert.equal(postRequests, 0);

  const loggedOut = createServerSkillSyncService({
    apiClient,
    credentials: fakeCredentials(),
    reactorServer: fakeReactorServer(false),
  });
  await assert.rejects(loggedOut.installBundle(7), /未登录企业服务端/);
  assert.equal(postRequests, 0, "未登录不得发出安装请求");
});
