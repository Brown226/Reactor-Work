import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";

/**
 * 凭据密文格式（写入方决定格式，读取方按前缀分派）：
 *
 * - v1（`enc:v1:`）：AES-256-GCM，密钥来自 `ZCODE_CREDENTIAL_SECRET`，未配置时由
 *   「平台 + 家目录 + 用户名」做 sha256 环境推导。推导串对同机同用户的所有进程可见，
 *   因此 v1 是可用性优先的既定降级，不构成保密边界。
 * - v2（`enc:v2:`）：由宿主注入的 safeStorage（OS 钥匙串）直接加密，密钥不出钥匙串。
 *   Agent 进程（zcode-cli）没有 safeStorage 能力，代码层面解不开 v2 —— 这是
 *   「桌面端凭据对 Agent 进程强制隔离」的实现载体；纯 CLI / web 宿主不注入
 *   adapter，继续 v1 行为（同样的既定降级，不是新妥协）。
 */
export const CREDENTIAL_V1_ENCRYPTED_VALUE_PREFIX = "enc:v1:";
export const CREDENTIAL_V2_ENCRYPTED_VALUE_PREFIX = "enc:v2:";

const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

/**
 * safeStorage 能力注入点（宿主装配层提供，services 不 import Electron）。
 *
 * 桌面 main 进程可直接传 `electron.safeStorage`（同步 API，结构兼容本接口）；
 * Electron utility process 宿主拿不到 safeStorage 模块（Electron 41 的 utility
 * process 仅暴露 net / systemPreferences），由 main 经 parentPort 代理成异步实现。
 */
export interface CredentialSafeStorageAdapter {
  isEncryptionAvailable(): boolean | Promise<boolean>;
  encryptString(plainText: string): Buffer | Promise<Buffer>;
  decryptString(encrypted: Buffer): string | Promise<string>;
}

export interface CredentialCipherProvider {
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
  /**
   * v1→v2 惰性迁移判定：`rawValue` 为 v1 旧格式且 v2（safeStorage）可用时，
   * 返回 `plainText` 重加密后的 v2 密文；否则返回 null（无需或无法迁移）。
   */
  upgradeToV2(rawValue: string, plainText: string): string | null | Promise<string | null>;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** 宿主注入的 safeStorage 能力；缺省（纯 CLI / web）时保持 v1 行为。 */
  safeStorage?: CredentialSafeStorageAdapter | null;
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function defaultCredentialSecret(env: NodeJS.ProcessEnv): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = options.env ?? process.env;
  const safeStorage = options.safeStorage ?? null;
  const v1Key = deriveCipherKey(defaultCredentialSecret(env));

  // safeStorage「当前是否可用」。macOS/Linux 钥匙串不可用、或代理通道故障时按
  // false 处理：写入与迁移保持 v1 行为（与宿主不注入 adapter 等价的既定降级）。
  const isSafeStorageReady = async (): Promise<boolean> => {
    if (!safeStorage) {
      return false;
    }
    try {
      return await safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  const encryptWithSafeStorage = async (value: string): Promise<string> => {
    if (!safeStorage) {
      // 仅在 ready 探测通过后才会走到这里；此分支只为类型收窄兜底。
      throw createCredentialDecryptError("safeStorage 能力不可用，无法加密凭据");
    }
    // electron.safeStorage 返回同步 Buffer，main 代理实现返回 Promise；await 兼容两者。
    const encrypted = await safeStorage.encryptString(value);
    return bufferToBase64url(encrypted);
  };

  const encryptWithDerivedKey = (value: string): string => {
    const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
    const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, v1Key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      CREDENTIAL_V1_ENCRYPTED_VALUE_PREFIX,
      bufferToBase64url(iv),
      ".",
      bufferToBase64url(authTag),
      ".",
      bufferToBase64url(encrypted),
    ].join("");
  };

  const decryptWithDerivedKey = (value: string): string => {
    const payload = value.slice(CREDENTIAL_V1_ENCRYPTED_VALUE_PREFIX.length);
    const parts = payload.split(".");
    const [ivRaw, authTagRaw, cipherRaw] = parts;

    if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
      throw createCredentialDecryptError("密文格式非法");
    }

    const iv = base64urlToBuffer(ivRaw);
    const authTag = base64urlToBuffer(authTagRaw);
    const cipherText = base64urlToBuffer(cipherRaw);

    if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
      throw createCredentialDecryptError("IV 长度非法");
    }

    if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
      throw createCredentialDecryptError("AuthTag 长度非法");
    }

    const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, v1Key, iv);
    decipher.setAuthTag(authTag);

    try {
      const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
      return plainText.toString("utf-8");
    } catch {
      throw createCredentialDecryptError("密钥不匹配或密文已损坏");
    }
  };

  return {
    async encrypt(value: string): Promise<string> {
      if (await isSafeStorageReady()) {
        // ready 探测通过后 encryptString 仍失败属于钥匙串真故障：显式失败而不是
        // 静默回退 v1 —— 回退会把秘密重新放回「同机同用户任意进程可推导」的
        // 保护等级，让 v2 边界失效；调用方需要感知后重试。
        const encrypted = await encryptWithSafeStorage(value);
        return `${CREDENTIAL_V2_ENCRYPTED_VALUE_PREFIX}${encrypted}`;
      }
      return encryptWithDerivedKey(value);
    },

    async decrypt(value: string): Promise<string> {
      if (value.startsWith(CREDENTIAL_V2_ENCRYPTED_VALUE_PREFIX)) {
        const payload = value.slice(CREDENTIAL_V2_ENCRYPTED_VALUE_PREFIX.length);
        if (!safeStorage) {
          // 无 safeStorage 的宿主（纯 CLI / web、Agent 进程）读 v2：给可读报错
          // 而不是静默返回密文，避免上层把密文误当令牌使用。
          throw createCredentialDecryptError(
            "凭据由系统钥匙串加密，当前环境无法解密，请在桌面端重新登录",
          );
        }
        try {
          return await safeStorage.decryptString(base64urlToBuffer(payload));
        } catch {
          // 换机器 / 钥匙串条目丢失时必然失败：给可读提示引导重新登录，
          // 不静默删数据（删除是显式操作，留给上层决定）。
          throw createCredentialDecryptError(
            "凭据无法解密（系统钥匙串密钥不可用或已更换），请重新登录",
          );
        }
      }

      if (!value.startsWith(CREDENTIAL_V1_ENCRYPTED_VALUE_PREFIX)) {
        return value;
      }

      return decryptWithDerivedKey(value);
    },

    async upgradeToV2(rawValue: string, plainText: string): Promise<string | null> {
      if (!rawValue.startsWith(CREDENTIAL_V1_ENCRYPTED_VALUE_PREFIX)) {
        return null;
      }
      if (!(await isSafeStorageReady())) {
        return null;
      }
      const encrypted = await encryptWithSafeStorage(plainText);
      return `${CREDENTIAL_V2_ENCRYPTED_VALUE_PREFIX}${encrypted}`;
    },
  };
}
