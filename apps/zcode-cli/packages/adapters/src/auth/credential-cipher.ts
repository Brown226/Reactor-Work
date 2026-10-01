import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";

/**
 * 凭据密文格式与安全边界（如实说明）：
 *
 * - v1（`enc:v1:`）：AES-256-GCM + 环境推导钥（ZCODE_CREDENTIAL_SECRET，或
 *   「平台+家目录+用户名」的 sha256）。Agent 进程持有这份同源推导实现，是历史
 *   妥协；桌面端切到 safeStorage 后，v1 仅作为**遗留兼容路径**保留——用于读取
 *   尚未被惰性迁移的存量凭据，以及非 Electron 场景（纯 CLI/web）的既定降级。
 *   新代码不应把 v1 当作保密手段。
 * - v2（`enc:v2:`）：由桌面端 safeStorage（OS 钥匙串）加密，密钥不出钥匙串。
 *   Agent 进程没有 safeStorage 能力，**代码层面解不开 v2**（decrypt 显式抛错），
 *   这是「桌面端凭据对 Agent 进程隔离」的强制边界，不再只是约定。
 */
const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const SAFE_STORAGE_ENCRYPTED_VALUE_PREFIX = "enc:v2:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

/** 与 packages/shared 的 CREDENTIAL_DECRYPT_ERROR_CODE 保持一致，供上层统一识别。 */
const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED";

export interface ZCodeCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export interface ZCodeCredentialCipherOptions {
  env?: Record<string, string | undefined>;
}

export function createZCodeCredentialCipher(
  options: ZCodeCredentialCipherOptions = {},
): ZCodeCredentialCipher {
  const key = deriveCipherKey(resolveCredentialSecret(options.env ?? process.env));

  return {
    decrypt(value: string): string {
      if (value.startsWith(SAFE_STORAGE_ENCRYPTED_VALUE_PREFIX)) {
        // v2 是桌面端 safeStorage（OS 钥匙串）密文：Agent 进程没有解密能力，显式
        // 抛可读错误而不是返回密文原值（避免上层把密文误当令牌使用），也不崩溃。
        // code 与 shared 的 CREDENTIAL_DECRYPT_ERROR_CODE 对齐，供上层按「解密失败、
        // 需重新登录」的既有路径处理。
        throw Object.assign(
          new Error(
            "Credential decrypt failed: value is encrypted with the desktop OS keychain (enc:v2:); " +
              "the agent process cannot decrypt it. Re-login from the desktop app.",
          ),
          { code: CREDENTIAL_DECRYPT_ERROR_CODE },
        );
      }

      if (!isEncryptedZCodeCredentialValue(value)) {
        return value;
      }

      const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }

      const iv = Buffer.from(ivRaw, "base64url");
      const authTag = Buffer.from(authTagRaw, "base64url");
      const cipherText = Buffer.from(cipherRaw, "base64url");

      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw new Error("Credential decrypt failed: invalid IV length");
      }
      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw new Error("Credential decrypt failed: invalid auth tag length");
      }

      try {
        const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return plainText.toString("utf-8");
      } catch (error) {
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
          cause: error,
        });
      }
    },

    encrypt(value: string): string {
      // Agent 进程没有 safeStorage 能力，只能写 v1（推导钥）；桌面端持有 v2 解密
      // 能力，可正常读取这里写入的 v1 值。CLI 直接登录写入的凭据因此仍走遗留路径。
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        ENCRYPTED_VALUE_PREFIX,
        iv.toString("base64url"),
        ".",
        authTag.toString("base64url"),
        ".",
        encrypted.toString("base64url"),
      ].join("");
    },
  };
}

export function isEncryptedZCodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function resolveCredentialSecret(env: Record<string, string | undefined>): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Some packaged or sandboxed runtimes cannot resolve OS user info.
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}
