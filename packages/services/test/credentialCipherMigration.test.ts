import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import type { CredentialSafeStorageAdapter } from "../src/credential/providers/credentialCipherProvider.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  isCredentialDecryptError,
} from "@zcode/shared";

/**
 * 凭据加密 v1（环境推导钥）→ v2（safeStorage/OS 钥匙串）迁移语义。
 *
 * 注入 fake safeStorage（可逆编码代替真加密），不依赖 Electron：
 * - fake 密文格式 `fake-b64:<base64url(plain)>`，与 v2 前缀拼接后仍可解回明文；
 * - 解密失败场景由 forceDecryptFailure 打开，模拟换机器 / 钥匙串条目丢失。
 */
function createFakeSafeStorage(
  options: { available?: boolean; forceDecryptFailure?: boolean } = {},
): CredentialSafeStorageAdapter & { calls: { encrypt: number; decrypt: number; available: number } } {
  const calls = { encrypt: 0, decrypt: 0, available: 0 };
  return {
    calls,
    isEncryptionAvailable(): boolean {
      calls.available += 1;
      return options.available ?? true;
    },
    encryptString(plainText: string): Buffer {
      calls.encrypt += 1;
      return Buffer.from(`fake-b64:${Buffer.from(plainText, "utf-8").toString("base64url")}`);
    },
    decryptString(encrypted: Buffer): string {
      calls.decrypt += 1;
      if (options.forceDecryptFailure) {
        throw new Error("simulated keychain entry missing");
      }
      const raw = encrypted.toString("utf-8");
      assert.ok(raw.startsWith("fake-b64:"), "fake ciphertext must come from this fake");
      return Buffer.from(raw.slice("fake-b64:".length), "base64url").toString("utf-8");
    },
  };
}

async function setupCredentialsDir(): Promise<{ dir: string; file: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-credential-cipher-"));
  setDataBaseDir(dir);
  const file = join(getAppConfigDir(), "credentials.json");
  await mkdir(getAppConfigDir(), { recursive: true });
  return {
    dir,
    file,
    async dispose() {
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("provider without safeStorage keeps v1 behavior (established fallback)", async () => {
  const provider = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "test-secret" } });

  const encrypted = await provider.encrypt("plain-token");
  assert.ok(encrypted.startsWith("enc:v1:"), "expected v1 prefix");
  assert.equal(await provider.decrypt(encrypted), "plain-token");
  // v1 且无 safeStorage：无需迁移。
  assert.equal(await provider.upgradeToV2(encrypted, "plain-token"), null);
});

test("provider with available safeStorage writes v2 and decrypts it back", async () => {
  const safeStorage = createFakeSafeStorage();
  const provider = createCredentialCipherProvider({
    env: { ZCODE_CREDENTIAL_SECRET: "test-secret" },
    safeStorage,
  });

  const encrypted = await provider.encrypt("plain-token");
  assert.ok(encrypted.startsWith("enc:v2:"), "expected v2 prefix");
  assert.equal(safeStorage.calls.encrypt, 1);
  assert.equal(await provider.decrypt(encrypted), "plain-token");
  assert.equal(safeStorage.calls.decrypt, 1);
  // v2 密文不需要迁移。
  assert.equal(await provider.upgradeToV2(encrypted, "plain-token"), null);
});

test("provider with unavailable safeStorage keeps v1 (keychain down is the established fallback)", async () => {
  const safeStorage = createFakeSafeStorage({ available: false });
  const provider = createCredentialCipherProvider({ safeStorage });

  const encrypted = await provider.encrypt("plain-token");
  assert.ok(encrypted.startsWith("enc:v1:"), "unavailable keychain must fall back to v1");
  assert.equal(await provider.decrypt(encrypted), "plain-token");
  assert.equal(await provider.upgradeToV2(encrypted, "plain-token"), null);
  // isEncryptionAvailable=false 时不应触碰 encryptString。
  assert.equal(safeStorage.calls.encrypt, 0);
});

test("reading a legacy v1 value with available safeStorage lazily rewrites it as v2", async () => {
  const env = await setupCredentialsDir();
  try {
    // 1) 旧版服务（无 safeStorage）写入 v1。
    const legacyService = createCredentialService({
      cipherProvider: createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "k" } }),
    });
    await legacyService.save("oauth:bigmodel:access_token", "legacy-token");
    const before = JSON.parse(await readFile(env.file, "utf-8"));
    assert.ok(before["oauth:bigmodel:access_token"].startsWith("enc:v1:"));

    // 2) 新版服务（fake safeStorage 可用、同一 v1 推导钥）读取：返回明文，同时文件被改写为 v2。
    const safeStorage = createFakeSafeStorage();
    const migratedService = createCredentialService({
      cipherProvider: createCredentialCipherProvider({
        env: { ZCODE_CREDENTIAL_SECRET: "k" },
        safeStorage,
      }),
    });
    const loaded = await migratedService.load("oauth:bigmodel:access_token");
    assert.equal(loaded, "legacy-token");

    const after = JSON.parse(await readFile(env.file, "utf-8"));
    assert.ok(
      after["oauth:bigmodel:access_token"].startsWith("enc:v2:"),
      "lazy migration must rewrite v1 as v2",
    );
    assert.notEqual(after["oauth:bigmodel:access_token"], before["oauth:bigmodel:access_token"]);
    assert.ok(safeStorage.calls.encrypt >= 1);

    // 3) 迁移后的值可以继续解密（roundtrip），且再次读取不再触发迁移。
    assert.equal(await migratedService.load("oauth:bigmodel:access_token"), "legacy-token");
  } finally {
    await env.dispose();
  }
});

test("reading a legacy v1 value without usable safeStorage keeps v1 and does not fail", async () => {
  const env = await setupCredentialsDir();
  try {
    const legacyService = createCredentialService({
      cipherProvider: createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "k" } }),
    });
    await legacyService.save("oauth:bigmodel:access_token", "legacy-token");

    const safeStorage = createFakeSafeStorage({ available: false });
    // 读写两侧使用同一 v1 推导密钥（真实场景：同机同用户的同一推导串）。
    const service = createCredentialService({
      cipherProvider: createCredentialCipherProvider({
        env: { ZCODE_CREDENTIAL_SECRET: "k" },
        safeStorage,
      }),
    });
    assert.equal(await service.load("oauth:bigmodel:access_token"), "legacy-token");

    const after = JSON.parse(await readFile(env.file, "utf-8"));
    assert.ok(
      after["oauth:bigmodel:access_token"].startsWith("enc:v1:"),
      "unavailable keychain must not migrate",
    );
  } finally {
    await env.dispose();
  }
});

test("v2 decrypt failure yields a readable re-login error instead of deleting data", async () => {
  const env = await setupCredentialsDir();
  try {
    const safeStorage = createFakeSafeStorage();
    const writer = createCredentialService({ safeStorage });
    await writer.save("oauth:bigmodel:access_token", "token-a");

    // 模拟换机器 / 钥匙串条目丢失：decryptString 直接失败。
    const brokenService = createCredentialService({
      safeStorage: createFakeSafeStorage({ forceDecryptFailure: true }),
    });
    await assert.rejects(
      () => brokenService.load("oauth:bigmodel:access_token"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, CREDENTIAL_DECRYPT_ERROR_CODE);
        assert.ok(isCredentialDecryptError(error));
        assert.ok(/重新登录/.test((error as Error).message));
        return true;
      },
    );

    // 数据不被静默删除。
    const after = JSON.parse(await readFile(env.file, "utf-8"));
    assert.ok(after["oauth:bigmodel:access_token"].startsWith("enc:v2:"));
  } finally {
    await env.dispose();
  }
});

test("v1 and v2 ciphertexts coexist and are both readable by a safeStorage host", async () => {
  const env = await setupCredentialsDir();
  try {
    const envK = { ZCODE_CREDENTIAL_SECRET: "k" };
    const legacyProvider = createCredentialCipherProvider({ env: envK });
    const v1Value = await legacyProvider.encrypt("v1-secret");
    const v2Value = await createCredentialCipherProvider({
      env: envK,
      safeStorage: createFakeSafeStorage(),
    }).encrypt("v2-secret");

    // 直接落盘构造双格式并存（save 只接受明文，不能用来塞密文）。
    await writeFile(
      env.file,
      `${JSON.stringify(
        {
          "oauth:zai:access_token": v2Value,
          zcodejwttoken: v1Value,
        },
        null,
        2,
      )}\n`,
    );

    const service = createCredentialService({
      cipherProvider: createCredentialCipherProvider({
        env: envK,
        safeStorage: createFakeSafeStorage(),
      }),
    });

    assert.equal(await service.load("oauth:zai:access_token"), "v2-secret");
    assert.equal(await service.load("zcodejwttoken"), "v1-secret");

    // 两次读取各自触发惰性迁移后，文件内全部收敛为 v2。
    const stored = JSON.parse(await readFile(env.file, "utf-8"));
    assert.ok(stored["oauth:zai:access_token"].startsWith("enc:v2:"));
    assert.ok(stored["zcodejwttoken"].startsWith("enc:v2:"));
  } finally {
    await env.dispose();
  }
});

test("a host without safeStorage fails readable (not crash) when reading v2", async () => {
  const env = await setupCredentialsDir();
  try {
    const writer = createCredentialService({ safeStorage: createFakeSafeStorage() });
    await writer.save("oauth:bigmodel:access_token", "token-a");

    const plainHost = createCredentialService({
      cipherProvider: createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "k" } }),
    });
    await assert.rejects(
      () => plainHost.load("oauth:bigmodel:access_token"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, CREDENTIAL_DECRYPT_ERROR_CODE);
        assert.ok(isCredentialDecryptError(error));
        return true;
      },
    );
    assert.ok(JSON.parse(await readFile(env.file, "utf-8"))["oauth:bigmodel:access_token"]);
  } finally {
    await env.dispose();
  }
});
