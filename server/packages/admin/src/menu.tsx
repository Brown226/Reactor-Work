// 管理台导航配置：13 模块 → 分组；元素=真实页或规划态(Planned)
// T1-3：可见性改为「服务端 /me/nav 下发的 key 集合」驱动（角色映射在服务端），
// 本表仍保留 roles 字段作为 /me/nav 不可用时的本地兜底。

import type { ReactNode } from "react";
import type { Icon } from "@phosphor-icons/react";
import {
  BookOpen,
  ChartBar,
  ChartLineUp,
  ClockCounterClockwise,
  Database,
  Gauge,
  Package,
  Plug,
  PuzzlePiece,
  Robot,
  ShieldCheck,
  Stack,
  UserCircle,
  UsersThree,
  Wrench,
} from "@phosphor-icons/react";
import type { Role } from "./types";
import { Account } from "./pages/Account";
import { Agents } from "./pages/Agents";
import { Audit } from "./pages/Audit";
import DashboardPage from "./pages/DashboardPage";
import KbDatasetsPage from "./pages/KbDatasetsPage";
import { OrgUsers } from "./pages/OrgUsers";
import { Planned } from "./pages/planned";
import { ModelsAndProviders } from "./pages/ModelsAndProviders";
import { Roles } from "./pages/Roles";
import { Skills } from "./pages/Skills";
import { SkillBundles } from "./pages/SkillBundles";
import { SyncLogs } from "./pages/SyncLogs";
import { Usage } from "./pages/Usage";

export interface NavItem {
  key: string;
  path: string;
  title: string;
  icon: Icon;
  roles: Role[];
  el: ReactNode;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const A: Role[] = ["platform_admin"];
const AH: Role[] = ["platform_admin", "dept_head"];
const ALL: Role[] = ["platform_admin", "dept_head", "user"];

export const NAV: NavGroup[] = [
  {
    label: "运营",
    items: [
      { key: "overview", path: "/", title: "运营总览", icon: Gauge, roles: AH, el: <DashboardPage /> },
    ],
  },
  {
    label: "组织与权限",
    items: [
      // D1：用户管理（表）与组织管理（树）合并为一页「组织与用户」（左树右表）。
      // 菜单 key 从 "users"/"org" 合为 "org-users"，服务端 /me/nav 必须同步改 ——
      // 只改一边的话页面永不显示（t187 对这个跨包契约做双向断言）。
      { key: "org-users", path: "/org", title: "组织与用户", icon: UsersThree, roles: AH, el: <OrgUsers /> },
      { key: "roles", path: "/roles", title: "角色与权限", icon: ShieldCheck, roles: AH, el: <Roles /> },
    ],
  },
  {
    label: "模型与网关",
    items: [
      // 2026-09-19：模型供应商与模型管理**合并为「模型与供应商」一页**（三级布局：
      // 板块 → 供应商配置 → 模型列表）。旧 `/models` 路由保留为**重定向**（见 console.tsx），
      // 服务端 /me/nav 也同步去掉了 "models" key —— 漏改一边 t187 的双向断言会红。
      {
        key: "providers",
        path: "/providers",
        title: "模型与供应商",
        icon: Stack,
        roles: A,
        el: <ModelsAndProviders />,
      },
      {
        key: "usage",
        path: "/usage",
        title: "用量与额度",
        icon: ChartLineUp,
        roles: A,
        el: <Usage />,
      },
    ],
  },
  {
    label: "内容与能力",
    items: [
      {
        key: "kb",
        path: "/kb",
        title: "知识库",
        icon: Database,
        roles: A,
        el: <KbDatasetsPage />,
      },
      {
        key: "skills",
        path: "/skills",
        title: "Skills 技能",
        icon: BookOpen,
        roles: A,
        el: <Skills />,
      },
      {
        key: "skill-bundles",
        path: "/skill-bundles",
        title: "Skills 套件",
        icon: Package,
        roles: A,
        el: <SkillBundles />,
      },
      {
        key: "agents",
        path: "/agents",
        title: "Agent 数字人",
        icon: Robot,
        roles: A,
        el: <Agents />,
      },
      {
        key: "tools",
        path: "/tools",
        title: "工具管理",
        icon: Wrench,
        roles: A,
        el: (
          <Planned
            title="工具管理"
            desc="统一工具目录（内置 + MCP + 连接器 + Agent）作为授权实体；会话类型工具隔离。"
            phase="第 4 批"
            items={[
              { name: "工具目录", note: "office/编码/浏览器/检索 + 扩展源" },
              { name: "授权", note: "角色×工具 / 部门范围" },
            ]}
          />
        ),
      },
    ],
  },
  {
    label: "扩展与接入",
    items: [
      {
        key: "mcp",
        path: "/mcp",
        title: "MCP 服务",
        icon: Plug,
        roles: A,
        el: (
          <Planned
            title="MCP 服务管理"
            desc="MCP Server 注册/工具白名单/密钥托管；配置与白名单下发端侧（G5 受 M7 出网约束）。"
            phase="第 5 批"
            items={[
              { name: "MCP 注册", note: "stdio/http/sse + 连通测试(list_tools)" },
              { name: "白名单", note: "暴露工具 + 授权部门" },
            ]}
          />
        ),
      },
      {
        key: "apps",
        path: "/apps",
        title: "第三方应用",
        icon: PuzzlePiece,
        roles: A,
        el: (
          <Planned
            title="第三方应用"
            desc="开放平台 API 应用（对外授 key）+ 外部连接器（对内供 Agent 调用）两类。"
            phase="第 5 批"
            items={[
              { name: "开放 API 应用", note: "app_key/secret/能力 scopes/配额/审计" },
              { name: "外部连接器", note: "连接器动作 → 工具目录" },
            ]}
          />
        ),
      },
    ],
  },
  {
    label: "系统",
    items: [
      { key: "synclogs", path: "/sync-logs", title: "同步日志", icon: ClockCounterClockwise, roles: A, el: <SyncLogs /> },
      {
        key: "audit",
        path: "/audit",
        title: "审计与报表",
        icon: ChartBar,
        roles: AH,
        el: <Audit />,
      },
      { key: "account", path: "/account", title: "个人中心", icon: UserCircle, roles: ALL, el: <Account /> },
    ],
  },
];

/** 本前端认识的导航 key（用于认出「服务端比前端旧」的漂移） */
const KNOWN_KEYS = new Set(NAV.flatMap((g) => g.items.map((i) => i.key)));

/**
 * 计算当前可见导航：
 * - `keys`（来自服务端 /me/nav）存在时以它为准；
 * - 否则回退本地角色映射（服务端不可达时的兜底）。
 */
export function navFor(role: Role, keys?: string[] | null): NavGroup[] {
  /*
   * 服务端下发了**本前端已不认识的 key** ⇒ 几乎总是「常驻身份服务还跑着旧产物」：
   * `/me/nav` 的 key 改过（如 2026-09-19 的 users/org → org-users）但进程没重启。
   * 症状极具误导性：**前端菜单静默少一项**，代码怎么查都是对的（t187 双向断言也是绿的，
   * 因为源码已经对齐——不一致的是内存里那个旧进程）。这里只在 dev 提醒一句，
   * 不给用户的生产控制台打日志，也不改变过滤行为（key 集合仍是唯一权威）。
   */
  if (import.meta.env?.DEV && keys && keys.length > 0) {
    const stale = keys.filter((k) => !KNOWN_KEYS.has(k));
    if (stale.length > 0) {
      console.warn(`[管理台菜单] 服务端 /me/nav 下发了本前端不认识的 key：${stale.join("、")} —— 常驻身份服务可能是旧产物（改过 /me/nav 后要重启 identity），请重启后再刷新`);
    }
  }
  const byKeys = keys && keys.length > 0 ? (it: NavItem) => keys.includes(it.key) : (it: NavItem) => it.roles.includes(role);
  return NAV.map((g) => ({ ...g, items: g.items.filter(byKeys) })).filter((g) => g.items.length > 0);
}

export function findItem(path: string): NavItem | null {
  for (const g of NAV) {
    for (const i of g.items) if (i.path === path) return i;
  }
  return null;
}
