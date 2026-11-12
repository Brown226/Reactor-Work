import { normalizeProductDocsUrl } from "@zcode/shared";

/**
 * 产品文档入口统一收口，避免不同菜单跳到不一致的文档站。
 *
 * 地址唯一来源是服务端组织策略的 `productDocsUrl`（随 `GET /desktop/policy` 下发，
 * 平台管理员可改）；未配置（未登录 / 无企业服务端 / 策略缺字段 / 值非法）时返回 null，
 * 调用方据此提示「尚未配置」——不再硬编码任何官方站地址。
 * 产品规则与维护方式见 docs/已完成/已完成-产品文档入口.md。
 */
export function resolveProductDocsUrl(
  serverProductDocsUrl: string | null | undefined,
): string | null {
  return normalizeProductDocsUrl(serverProductDocsUrl);
}
