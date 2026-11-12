import assert from "node:assert/strict";
import test from "node:test";
import {
  IdentityLoginError,
  createLoginRateLimiter,
  isSessionProtectedPath,
  loginWithIdentity,
} from "../src/web/sessionAuth.js";

test("会话路径：登录、会话查询、server-info 与公开分享不要求会话", () => {
  assert.equal(isSessionProtectedPath("/api/auth/login"), false);
  assert.equal(isSessionProtectedPath("/api/auth/session"), false);
  assert.equal(isSessionProtectedPath("/api/server-info"), false);
  assert.equal(isSessionProtectedPath("/api/space/shared/abc"), false);
  assert.equal(isSessionProtectedPath("/api/user-workspace"), true);
  assert.equal(isSessionProtectedPath("/ws"), true);
  assert.equal(isSessionProtectedPath("/ws/host"), true);
});

test("登录限流：达到上限后阻断，成功后重置，窗口结束后恢复", () => {
  let now = 1_000;
  const limiter = createLoginRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => now,
  });
  assert.equal(limiter.isBlocked("ip|alice"), false);
  limiter.recordFailure("ip|alice");
  limiter.recordFailure("ip|alice");
  assert.equal(limiter.isBlocked("ip|alice"), true);
  assert.equal(limiter.isBlocked("ip|bob"), false);

  limiter.reset("ip|alice");
  assert.equal(limiter.isBlocked("ip|alice"), false);

  limiter.recordFailure("ip|alice");
  limiter.recordFailure("ip|alice");
  now += 60_001;
  assert.equal(limiter.isBlocked("ip|alice"), false);
});

test("identity 登录：只取 uid，不保存 token；401 与非法 uid 分别上抛", async () => {
  const okResponse = new Response(
    JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      user: { uid: "alice", name: "Alice", role: "user", mustChangePassword: true },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const result = await loginWithIdentity(
    "http://identity",
    "alice",
    "secret",
    (async () => okResponse) as typeof fetch,
  );
  assert.equal(result.user.uid, "alice");
  assert.equal(result.user.mustChangePassword, true);
  assert.equal("accessToken" in result, false);

  await assert.rejects(
    () =>
      loginWithIdentity(
        "http://identity",
        "alice",
        "bad",
        (async () =>
          new Response(JSON.stringify({ error: { message: "账号或密码错误" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      ),
    (error: unknown) =>
      error instanceof IdentityLoginError && error.status === 401 && /账号或密码错误/.test(error.message),
  );

  await assert.rejects(
    () =>
      loginWithIdentity(
        "http://identity",
        "alice",
        "ok",
        (async () =>
          new Response(JSON.stringify({ user: { uid: "../etc", name: "x", role: "user" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      ),
    (error: unknown) => error instanceof IdentityLoginError && error.status === 502,
  );
});
