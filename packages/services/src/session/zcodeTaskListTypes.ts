import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind | "all";
  /** host 由存储 owner 确定全部范围，不接受 UI 已打开工作区作为历史目录。 */
  workspaceScopes: ZCodeTaskListWorkspaceScope[] | "host";
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  limit?: number;
  /** 只返回这些会话（例如分享管理按来源会话 ID 解析跳转目标）；空数组返回空结果。 */
  taskIds?: readonly string[];
}

export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}

// ============================================================
// [本地定制] 任务分组视图类型
//
// 上游 v3.18.0 只保留扁平任务列表类型，分组视图契约未开源。
// 整包同步会整段覆盖本文件，勿删。缺失时 ui 的
// WorkspaceGroupedTasksSection / useGroupedTaskView 全部编译失败。
// ============================================================

export type ZCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ZCodeTaskGroup {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZCodeTaskGroup {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ZCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }

export type ZCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: ZCodeTaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    }

export interface ZCodeGroupedTaskView {
  nodes: ZCodeGroupedTaskViewNode[];
}

export interface ZCodeGroupedTaskViewQuery {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface ZCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type ZCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }

export interface ZCodeGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: ZCodeTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: ZCodeGroupedTaskViewStructureMember[];
  topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[];
}

export interface ZCodeGroupedTaskViewOrderInput {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  topLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ZCodeGroupedTaskRef[];
  }>;
}