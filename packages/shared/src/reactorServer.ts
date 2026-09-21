/**
 * 企业服务端（Reactor Server）托管 provider 的**契约常量**。
 *
 * 这个文件是 `@zcode/shared` 的一部分，因为它是**两侧共用的契约**：
 *  - Host 侧（`packages/services/src/reactor-server/`）用它写企业 provider 的配置；
 *  - CLI 侧（`apps/zcode-cli/packages/adapters/src/model/runner.ts`）用它判断
 *    "这个 provider 的鉴权材料必须每次请求向 Host 现场索取"。
 *
 * 为什么需要哨兵值：普通 `api-key` provider 的密钥是静态的、直接来自配置，CLI 不会
 * 走运行时鉴权通路。企业服务端签发的网关令牌**只有 2 小时**（见服务端
 * `REACTOR_GATEWAY_TOKEN_TTL_SECONDS`），落盘就会过期，因此配置里放的是这个哨兵，
 * 真实令牌由 Host 每次请求现场签发。CLI 靠"值等于哨兵"识别它 —— 除了我们自己，
 * 没有任何合法密钥会等于这个字符串。
 */
export const REACTOR_SERVER_API_KEY_SENTINEL = "managed-by-reactor-server";

/** 该 provider 配置是否由企业服务端托管（即需要每次请求现场取鉴权材料）。 */
export function isReactorServerManagedApiKey(apiKey: unknown): boolean {
  return apiKey === REACTOR_SERVER_API_KEY_SENTINEL;
}
