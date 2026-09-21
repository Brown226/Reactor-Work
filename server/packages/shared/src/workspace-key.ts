/**
 * 工作区键归一 —— 技能「按工作区启停」、技能状态文件、侧栏分组**共用同一口径**。
 *
 * 为什么必须放 shared：这个键会被三处独立计算 ——
 *  ① 桌面端主进程写 `<userData>/skills/.reactor-skills-state.json` 时用它做 map 键；
 *  ② sidecar 在会话创建 / reload 时用它查该工作区的启用集合；
 *  ③ 客户端「我安装的」抽屉显示"仅本工作区"时用它读写服务端状态。
 * 三处只要有一处算法不同，就会出现"我明明在这个工作区停用了，它还在跑"这类幽灵问题。
 *
 * 归一规则（可预测优先，不做魔法）：
 *  - 优先 `projectKey`（sidecar 已解析的 git 根，同一仓库的 worktree 折叠到一起）；
 *    没有则退回 `cwd`。
 *  - 反斜杠 → 正斜杠；去尾部斜杠。
 *  - Windows 盘符路径整串小写（`E:/Work/X` 与 `e:/work/x` 必须算同一个工作区）；
 *    非盘符路径（Linux/macOS）**保持原样**，因为那边大小写敏感，改写会错误合并。
 *  - 空输入 → 空串（调用方据此退化为"全局集合"）。
 */
export function normalizeWorkspaceKey(input: {
  projectKey?: string | null;
  cwd?: string | null;
}): string {
  const raw = (input.projectKey?.trim() || input.cwd?.trim() || "");
  if (!raw) return "";
  const slashed = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  // 仅盘符路径做整串小写；UNC（//server/share）与 POSIX 路径不动
  const isDrivePath = /^[A-Za-z]:\//.test(slashed);
  return isDrivePath ? slashed.toLowerCase() : slashed;
}
