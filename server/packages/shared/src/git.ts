/**
 * Git 结构化只读契约（路线图 3.2）。
 *
 * 语义对齐 pi-web `lib/git-status.ts` / `lib/git-changes.ts`（见对照报告 §2.3）：
 * porcelain v1 `-z` 解析、index/worktree 分栏、rename/copy 原路径、未跟踪文件逐条列出。
 * 服务端（sidecar）负责执行 git 与合成 patch；客户端只消费结构化结果。
 */

export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitStatusFile {
  /** 相对**会话工作区根**的 POSIX 路径（与文件树的相对路径同一坐标系） */
  path: string;
  /** rename/copy 的原路径（同坐标系） */
  originalPath?: string;
  /** `git status --porcelain` 的 XY 两栏原始码 */
  indexStatus: string;
  worktreeStatus: string;
  /** 分类后的状态（渲染徽标用） */
  status: GitFileStatusKind;
  /** 单字母码（M/A/D/R/U/C） */
  code: "M" | "A" | "D" | "R" | "U" | "C";
}

export interface GitStatusResult {
  supported: boolean;
  /** 仓库根（绝对路径；非仓库为 null） */
  repositoryRoot: string | null;
  /** 当前分支名（detached HEAD 为 null） */
  branch: string | null;
  /** 与上游的领先/落后提交数（无上游时为 null） */
  ahead: number | null;
  behind: number | null;
  files: GitStatusFile[];
  /** supported=false 时的原因（非仓库 / 无工作区） */
  reason?: string;
}

export interface GitDiffResult {
  supported: boolean;
  status?: GitFileStatusKind;
  /** unified diff 文本（含 `@@` 块；未跟踪文件由 sidecar 合成 added patch） */
  patch?: string;
  /** supported=false 时的原因（未跟踪文件不可读/二进制/超大/不在仓库内） */
  reason?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601 作者时间 */
  date: string;
  subject: string;
}

export interface GitLogResult {
  supported: boolean;
  entries: GitLogEntry[];
  reason?: string;
}
