// Package reactor 存放 Reactor 对 MonkeyAI 服务端的专属扩展。
//
// 约束：
//   - 业务逻辑放这里，不污染 internal/identity、internal/proxy 等上游核心包。
//   - 需要被 internal/app 装配的模块实现 extension.Module / extension.Bindings。
//   - 需要成员/分组写入时实现 member.UserWriter / member.GroupWriter，并在
//     cmd/server 的组装处注入，不绕过接口直接写表。
//   - 每个子包在 REACTOR-PATCHES.md 或本包文档中登记用途与回归方式。
package reactor
