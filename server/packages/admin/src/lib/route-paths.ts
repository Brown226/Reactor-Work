// 管理台的路由路径规则（纯函数，**不引任何页面/组件**）。
//
// 为什么不放在 menu.tsx 里：menu.tsx 为了登记导航会把**每个页面模块**都 import 进来
// （其中 KB 一族还带着 streamdown 链），于是任何只想用一条路径规则的地方 —— 包括探针 ——
// 都会被整棵页面图拖下水。实测：探针在仓库根用 tsx ESM loader 跑时，光 import menu.tsx 就
// 报 ERR_PACKAGE_PATH_NOT_EXPORTED（@streamdown/cjk 只有 import 条件、没有 require 条件）。
// 规则挪到这里，两边（layouts/console.tsx 与探针）都干净。

/**
 * 旧书签兜底（决策 D3）：`/users` 直接重定向到合并页「组织与用户」，
 * **并把原查询串一起带过去** —— 同事分享的 `/users?dept=12&sub=1` 不该在重定向这一步把选中态丢掉。
 */
export function usersRedirectTarget(search: string): string {
  const qs = search.replace(/^\?/, "");
  return `/org${qs ? `?${qs}` : ""}`;
}

/**
 * `2026-09-19` 合并页重定向：**模型管理（/models）已并入「模型与供应商」（/providers）**。
 *
 * 为什么保留这条重定向而不是让 /models 404：同事之间会互相发链接（「你去看下 /models」），
 * 书签与文档里也有。直接 404 会让人以为功能被删了。
 *
 * 顺便把旧的 `?provider=<id>` 过滤参数搬成新页的 `?board=`/`?provider=` 语义：
 * 旧页是按供应商筛选的表格，新页是「板块 → 供应商 → 模型」三级，所以
 * **只透传供应商 id**，板块由新页自己按该供应商的 model_type 推断（不猜、不硬编）。
 */
export function modelsRedirectTarget(search: string): string {
  const qs = search.replace(/^\?/, "");
  return `/providers${qs ? `?${qs}` : ""}`;
}
