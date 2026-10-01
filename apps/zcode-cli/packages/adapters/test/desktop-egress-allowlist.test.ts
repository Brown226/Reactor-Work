/**
 * P4.3 出网白名单闸 + P4.2b 策略文件读取回归（CLI adapters 侧）。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && npx tsx --test test/desktop-egress-allowlist.test.ts
 *
 * 守的是：
 * ① 名单外域名在**发请求前**被拒（不需要 DNS/网络，纯本地判定）；
 * ② 名单命中 / 名单为空（未配置）时不拦 —— 未配置时行为与接线前完全一致；
 * ③ 白名单只管 `egressPolicy === "public"` 那条信道，不影响其他 HTTP 出口；
 * ④ 策略文件由 Host 写、CLI 只读：文件删除后立刻回到"不限制"，不缓存成第二份真相。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReactorDesktopPolicy, ReactorDesktopPolicySource } from "@zcode/shared";

import { createNodeHttpClientAdapter } from "../src/http/index.js";
import { createDesktopPolicySource } from "../src/policy/desktopPolicySource.js";

function policySource(policy: ReactorDesktopPolicy | null): ReactorDesktopPolicySource {
  return { current: () => policy };
}

function defaultPolicy(overrides: Partial<ReactorDesktopPolicy> = {}): ReactorDesktopPolicy {
  return {
    defaultApprovalMode: "yolo",
    commandBlacklist: [],
    egressAllowlist: [],
    quota: { monthlyTokenLimit: null, alertThresholds: [80, 100] },
    ...overrides,
  };
}

async function expectNoPolicyBlock(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => undefined,
    (error: unknown) => {
      const message = String((error as { message?: unknown })?.message ?? "");
      assert.equal(
        /组织策略/.test(message),
        false,
        `不应被组织出网白名单拒绝，实际错误：${message}`,
      );
    },
  );
}

test("名单外域名：发请求前即被拒，理由为可读中文", async () => {
  const client = createNodeHttpClientAdapter({
    desktopPolicy: policySource(defaultPolicy({ egressAllowlist: ["example.com", "*.corp.test"] })),
  });
  await assert.rejects(
    client.request({ url: "https://blocked.test/secret", method: "GET", egressPolicy: "public" }),
    (error: unknown) => {
      const candidate = error as { code?: string; message?: string };
      assert.equal(candidate.code, "egress_blocked");
      assert.match(String(candidate.message), /组织策略/);
      assert.match(String(candidate.message), /blocked\.test/);
      return true;
    },
  );
});

test("名单命中与空名单：均不被组织策略拒绝", async () => {
  const restricted = createNodeHttpClientAdapter({
    desktopPolicy: policySource(defaultPolicy({ egressAllowlist: ["example.com", "*.corp.test"] })),
  });
  await expectNoPolicyBlock(
    restricted.request({ url: "https://a.corp.test/ok", method: "GET", egressPolicy: "public" }),
  );

  // 空名单 = 不限制（不是全禁）：这里换成私网地址，只会被既有 public-egress 规则拒（不是组织策略）。
  const open = createNodeHttpClientAdapter({ desktopPolicy: policySource(defaultPolicy()) });
  await expectNoPolicyBlock(
    open.request({ url: "https://127.0.0.1/health", method: "GET", egressPolicy: "public" }),
  );
});

test("白名单只管 public egress 信道：其他出口不受影响", async () => {
  const client = createNodeHttpClientAdapter({
    desktopPolicy: policySource(defaultPolicy({ egressAllowlist: ["example.com"] })),
  });
  await expectNoPolicyBlock(
    client.request({ url: "https://127.0.0.1/private", method: "GET" }),
  );
});

test("策略文件：Host 写 → CLI 读；删除后立刻回到不限制", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "desktop-policy.json");
  const source = createDesktopPolicySource({ filePath });

  assert.equal(source.current(), null, "文件不存在 = 不限制");
  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      policy: { defaultApprovalMode: "plan", commandBlacklist: ["shutdown"] },
    })}\n`,
    "utf8",
  );
  const loaded = source.current();
  assert.equal(loaded?.defaultApprovalMode, "plan");
  assert.deepEqual(loaded?.commandBlacklist, ["shutdown"]);
  // 缺字段按默认合并：出网白名单为空 = 不限制。
  assert.deepEqual(loaded?.egressAllowlist, []);

  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      policy: { defaultApprovalMode: "yolo" },
    })}\n`,
    "utf8",
  );
  // 同一进程内看到新内容（按 mtime/size 重读，不缓存成第二份真相）。
  assert.equal(source.current()?.defaultApprovalMode, "yolo");

  await rm(filePath, { force: true });
  assert.equal(source.current(), null, "登出清缓存后不得继续限制");
});

test("策略文件：损坏内容不解释成限制", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "desktop-policy.json");
  const source = createDesktopPolicySource({ filePath });
  await writeFile(filePath, "{ not json", "utf8");
  assert.equal(source.current(), null);
});
