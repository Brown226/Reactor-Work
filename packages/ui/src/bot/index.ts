/**
 * [本地定制] Agents 集群 —— Reactor 自有的 Bot 形态外壳（DS-Bot 完整前端）。
 *
 * 与上游的关系：`vendor/ds-bot-client/` 是 DS-Bot v0.3.2 的浏览器端视图（96 文件
 * 24k 行，Apache-2.0），原样拷贝、**不要就地修改**；上游升级时整目录覆盖即可。
 * Reactor 侧的适配全部集中在：
 *   - `adapters/primitives.js`  ：顶替 dsh 私有包 `@deepseek-ai/dsh-client-ui-primitives`
 *   - `adapters/botBridge.js`   ：顶替上游的 HTTP + SSE 宿主通信
 *   - `adapters/botStore.ts`    ：把 Reactor 的 Project/Task/Session 服务映射成 DS-Bot 的 roster
 *   - `adapters/rosterSource.ts`：Agent = VirtualProject，话题 = task 的形状转换
 *   - `shell/`                   ：上游 `app/ui/src/` 的窗口壳，移植到 React 主视图内
 *
 * 单一事实源是 Reactor 的项目树与会话服务；本目录不持有独立的业务状态，
 * 因此不会与侧栏、会话列表产生分叉（AGENTS.md：避免重复状态和多条写入路径）。
 */
export { BotClusterView } from "./BotClusterView.js";
