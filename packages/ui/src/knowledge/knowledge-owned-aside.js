/**
 * 知识库详情页的侧栏折叠同步。
 *
 * EvoFlow 在进入知识库详情时收起它自己的全局左导航（`#app-shell-aside`），
 * 列出列表时恢复。我们**不复用这套**：
 *
 * - Reactor 的侧栏是 `WorkspaceShellLayout` 里的可折叠面板，折叠状态由
 *   它自己的 state / 偏好持有（唯一 owner），不能让一个页面组件直接改
 *   —— 那会形成第二条写入路径（AGENTS.md：避免重复状态和多条写入路径）。
 * - 我们的知识库是**主视图**（`WorkspaceMainView = "knowledge"`），
 *   侧栏本来就不属于页面内部，折叠与否由用户决定。
 *
 * 所以这里保留同名导出但退化为 no-op，调用点（knowledge-owned.jsx）不用改。
 * 如果将来确实想「详情页自动收起侧栏」，应在 Shell 层通过既有折叠 API 实现，
 * 而不是在这里直接 DOM 操作。
 */

/** 进入/离开详情时同步侧栏状态 —— 当前为 no-op，原因见文件头。 */
export function syncKnowledgeAsideForDetail(_inDetail) {
  /* no-op：折叠由 WorkspaceShellLayout 唯一持有 */
}

/** 恢复侧栏先前状态 —— 当前为 no-op。 */
export function restoreKnowledgeAsideFromDetail() {
  /* no-op */
}
