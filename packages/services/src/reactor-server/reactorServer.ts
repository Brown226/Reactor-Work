import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 企业服务端（Reactor Server）接入服务。
 *
 * 负责三件事，且**只有它**能写这三处状态（单一所有者）：
 *  1. 企业登录令牌：存 `ICredentialService` 的 `reactor:*` 键（加密落盘），不写窗口 bridge；
 *  2. 企业 provider 条目：经 `IProviderSettingsService` 写 personal overlay，不另起配置文件；
 *  3. 网关请求鉴权材料：内存缓存短期网关令牌，供模型请求**每次现场解析**（见 §设计文档 4.2）。
 *
 * 设计依据：`docs/服务端接线-方案-v1.md`。
 */

/** 企业服务端地址（身份进程，形如 `http://10.0.0.5:8791`）。网关默认取同主机 `:8790`。 */
export interface ReactorServerLoginInput {
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
}

/** 登录后对外暴露的身份信息（不含任何令牌）。 */
export interface ReactorServerUserInfo {
  readonly uid: string;
  readonly name: string;
  readonly role: string;
  readonly deptId: number | null;
  readonly deptPath: string | null;
}

export interface ReactorServerStatus {
  /** 是否已配置服务端地址。 */
  readonly configured: boolean;
  /** 是否处于已登录且令牌有效状态。 */
  readonly loggedIn: boolean;
  readonly serverUrl: string | null;
  /** 网关基址（无尾斜杠），形如 `http://10.0.0.5:8790/v1`。 */
  readonly gatewayBaseUrl: string | null;
  readonly user: ReactorServerUserInfo | null;
  /** 该服务端下发的可用模型 id（仅 chat 板块），来自网关 `/v1/models`。 */
  readonly models: readonly string[];
  /** 登录态失效原因（过期/被吊销/服务端不可达），未失效时为 null。 */
  readonly lastError: string | null;
}

/** 模型请求的鉴权材料：只暴露 apiKey，调用方负责放进请求头。 */
export interface ReactorServerRequestAuth {
  readonly apiKey: string;
}

export interface IReactorServerService {
  getStatus(): Promise<ReactorServerStatus>;
  /** 登录并完成"取网关令牌 + 拉模型目录 + 写企业 provider"三步。 */
  login(input: ReactorServerLoginInput): Promise<ReactorServerStatus>;
  /** 退出：尽力通知服务端吊销 refresh，然后清空本地令牌与企业 provider 的模型清单。 */
  logout(): Promise<void>;
  /** 重新拉取模型目录并写回企业 provider。 */
  syncModels(): Promise<readonly string[]>;
  /**
   * 若该 provider 属于企业服务端，返回**现场解析**的鉴权材料；否则返回 null
   * （调用方继续走原有链路 —— 绝不能在这里静默降级成直连上游）。
   */
  resolveGatewayAuth(providerId: string, modelId: string): Promise<ReactorServerRequestAuth | null>;
}

export const IReactorServerService = createServiceDescriptor<IReactorServerService>(
  ServiceChannels.ReactorServer,
);

/** 企业 provider 的展示名（用户可在设置里看到）。 */
export const REACTOR_SERVER_PROVIDER_NAME = "Reactor 企业服务端";

/**
 * `access.apiKey` 的占位值：真实密钥**从不落盘**，每次模型请求由
 * `resolveGatewayAuth` 现场注入。写占位而不是空串，是为了通过"必填非空"类校验，
 * 同时让看到配置文件的人一眼知道这不是要手填的字段。
 *
 * 该常量定义在 `@zcode/shared`（CLI 侧 `runner.ts` 也用它判断"是否走运行时鉴权"），
 * 这里重新导出，保证服务端与 CLI 用的是同一个字符串。
 */
export { REACTOR_SERVER_API_KEY_SENTINEL as REACTOR_SERVER_API_KEY_PLACEHOLDER } from "@zcode/shared";

/** 凭据键（`ICredentialService`）。命名空间隔离，避免与官方账号的键互相覆盖。 */
export const REACTOR_SERVER_CREDENTIAL_KEYS = {
  serverUrl: "reactor:serverUrl",
  accessToken: "reactor:accessToken",
  refreshToken: "reactor:refreshToken",
  user: "reactor:user",
  providerId: "reactor:providerId",
} as const;
