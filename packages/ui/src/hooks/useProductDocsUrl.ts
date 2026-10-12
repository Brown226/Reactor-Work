import { useReactorServer } from "./useReactorServer.js";
import { resolveProductDocsUrl } from "@/lib/productDocs.js";

/**
 * 产品文档地址：读组织策略的 `productDocsUrl`（服务端下发，平台管理员可改）。
 *
 * 未登录 / 无企业服务端 / 策略未配置 / 值非法 → null，调用方据此提示「尚未配置」，
 * 不跳转、更不跳官方站。产品规则见 docs/已完成/已完成-产品文档入口.md。
 */
export function useProductDocsUrl(): string | null {
  const { overview } = useReactorServer();
  return resolveProductDocsUrl(overview?.productDocsUrl);
}
