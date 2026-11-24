export interface CredentialCipher {
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
  needsMigration?(value: string): boolean;
}
export interface SystemCredentialCipher extends CredentialCipher {
  /** 独立 Server 在开放服务前验证安全后端；不返回密钥。 */
  initialize(): Promise<void>;
  /**
   * 数据根复制后，保证目标凭据路径的系统条目能满足复制过去的依赖；不读出密钥。
   * 目标 os 密文只有一个指纹且也出现在本目录文件时，条目必须是这把密钥；目标没有 os 密文、
   * 但目标与本目录的 credential-source 都是 os 时，条目只需存在且合法；其他情况不访问系统库。
   * 目标条目已满足时直接成功，不加载本目录密钥；目标条目缺失时登记本目录密钥，
   * 本目录密钥不可用或目标已登记另一把密钥时以 CREDENTIAL_SECURE_STORAGE_UNAVAILABLE 拒绝，不覆盖。
   * `targetKeyStore` 只供测试替换目标条目。
   *
   * 修复原因（ZCT-2120723935487688704）：系统条目按凭据文件路径区分，切换数据存储路径
   * 只复制 credentials.json 与 credential-source；新根没有条目，来源又固定为 os，
   * 启动后既解不开原凭据也不能生成新密钥，用户掉登录且无法重新登录。
   */
  shareKeyWithCopiedCredentials(
    targetFilePath: string,
    targetKeyStore?: CredentialKeyStore,
  ): Promise<void>;
}
/** 仅后端可持有；不得通过 RPC 暴露系统密钥。 */
export interface CredentialKeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}
export interface SystemCredentialCipherOptions {
  filePath: string;
  env?: Readonly<Record<string, string | undefined>>;
  keyStore?: CredentialKeyStore;
}
