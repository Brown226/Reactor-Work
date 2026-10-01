import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
} from "@zcode/shared";
import type { ICredentialService } from "./credential.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
  type CredentialSafeStorageAdapter,
} from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

/**
 * 凭据存储路径
 *
 * 持久化格式仍是 JSON，value 在写入前加密，读取时自动解密。
 *
 * 加密格式有两个世代（见 credentialCipherProvider.ts）：
 * - v2（`enc:v2:`）：safeStorage（OS 钥匙串）密文。桌面宿主装配时注入
 *   CredentialSafeStorageAdapter —— main 进程直接传 electron.safeStorage；
 *   utility process host 由 main 经 parentPort 代理（Electron 的 utility process
 *   拿不到 safeStorage 模块）。写入一律优先 v2。
 * - v1（`enc:v1:`）：环境推导钥密文。safeStorage 不可用（纯 CLI / web / 钥匙串故障）
 *   时的既定降级；存量 v1 值在读取成功且 safeStorage 可用时惰性迁移为 v2。
 */
const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * v1→v2 惰性迁移：`rawValue` 仍是 v1 密文且 cipher 判定可迁移时，用 v2 密文回写。
 *
 * 回写必须在文件锁内做锁内重读校验：desktop host 与 CLI adapter 是独立进程，
 * 读到的 rawValue 在锁外随时可能被其他进程迁移或重登覆盖；若锁内最新值已不是
 * 当初解密的那份，直接放弃本次迁移（幂等），避免用旧值覆盖新值。
 */
async function migrateToV2IfNeeded(
  key: string,
  rawValue: string,
  plainText: string,
  cipherProvider: CredentialCipherProvider,
): Promise<void> {
  let upgraded: string | null;
  try {
    upgraded = await cipherProvider.upgradeToV2(rawValue, plainText);
  } catch (error) {
    logger.warn(undefined, "credential v1->v2 upgrade check failed; keep v1 value", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!upgraded) {
    return;
  }

  try {
    const credentialsFile = getCredentialsFile();
    let migrated = false;
    await withFileLock(credentialsFile, async () => {
      const latest = await readAll(credentialsFile);
      if (latest[key] !== rawValue) {
        // 已被其他进程迁移/重登：以最新值为准，放弃本次迁移。
        return;
      }
      latest[key] = upgraded;
      await writeAll(credentialsFile, latest);
      migrated = true;
    });
    if (migrated) {
      // key 名（如 oauth:bigmodel:access_token）不是秘密，可以进入生产日志；
      // 明文与密文内容一律不记录。
      logger.info(undefined, "credential migrated to safeStorage format (v1->v2)", { key });
    }
  } catch (error) {
    logger.warn(undefined, "credential v1->v2 lazy migration failed; keep v1 value", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readAll(credentialsFile = getCredentialsFile()): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    const rawValue = JSON.parse(raw);
    const result = credentialRecordSchema.safeParse(rawValue);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

interface CredentialServiceDependencies {
  cipherProvider?: CredentialCipherProvider;
  /** 宿主注入的 safeStorage（OS 钥匙串）能力；缺省时构造 v1 行为的默认 cipher。 */
  safeStorage?: CredentialSafeStorageAdapter | null;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): ICredentialService {
  const cipherProvider =
    dependencies.cipherProvider ?? createCredentialCipherProvider({ safeStorage: dependencies.safeStorage });

  return {
    async load(key: string): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      const creds = await readAll();
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      const plainText = await cipherProvider.decrypt(rawValue);

      // v1→v2 惰性迁移：旧值解密成功且钥匙串可用时顺手重加密回写，让存量凭据
      // 在下一次读取后逐步脱离「环境推导钥」保护，而不需要一次性停机迁移脚本。
      // 迁移是 best-effort：任何失败只记 warn，不影响本次读取结果；下次读取会重试。
      await migrateToV2IfNeeded(validatedKey, rawValue, plainText, cipherProvider);

      return plainText;
    },

    async save(key: string, value: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const encryptedValue = await cipherProvider.encrypt(validatedValue);
      const credentialsFile = getCredentialsFile();
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        creds[validatedKey] = encryptedValue;
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

    async delete(key: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },
  };
}
