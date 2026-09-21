// Console 布局（T1-3）：迁移自 BuildingAI layouts/console（Apache-2.0）。
// SidebarProvider + AppSidebar（品牌/分组导航/页脚用户）+ SidebarInset（面包屑顶栏 + 内容路由）。
// 菜单可见性由服务端 /me/nav 下发（services/navApi），本地角色映射仅作兜底。

import { useEffect, useState } from "react";
import { Moon, SignOut, Sun, UserCircle } from "@phosphor-icons/react";
import { Navigate, NavLink as RRNavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { navFor, findItem } from "../menu";
// 规则放独立模块（menu.tsx 会把整棵页面图 import 进来，探针只想用一条路径规则）
import { modelsRedirectTarget, usersRedirectTarget } from "../lib/route-paths";
// 知识库组件样板页（临时验收用）
import { Login } from "../pages/Login";
import KbPreview from "../pages/KbPreview";
// 知识库用户侧（「都搬」批）：广场/我的库 + 库详情
import DatasetsUserIndex from "../kb-port/pages/datasets";
import DatasetDetailPage from "../kb-port/pages/datasets/detail";
import { navApi } from "../services/identity-resources";
import { useAuthStore } from "../stores/auth";
import { ROLE_TEXT } from "../ui";
import { cn } from "../lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";

function useNavKeys(enabled: boolean): string[] | null {
  const [keys, setKeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    navApi
      .keys()
      .then((r) => setKeys(r.keys))
      .catch(() => setKeys(null)); // 服务端不可达 → menu.tsx 本地角色兜底
  }, [enabled]);
  return keys;
}

function AppSidebar({ groups }: { groups: ReturnType<typeof navFor> }) {
  const { user, logout } = useAuthStore();
  const nav = useNavigate();

  return (
    // variant="inset"：对齐上游的悬浮版式（侧栏是一块**带外边距的悬浮面板**，内容区是圆角卡片）。
    // 我们本来就在用 `SidebarInset`，所以这是一个词的事；回退同样是一个词。
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <img className="brand-mark shrink-0" src="/brand/logo-cube.jpg" alt="" width={28} height={28} data-admin-brand-logo="" />
          <div className="brand-name grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden" data-admin-brand-name="">
            Reactor
            <small>数智堆脑 · 管理台</small>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {groups.map((g) => (
          <SidebarGroup key={g.label}>
            <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((it) => (
                  <SidebarMenuItem key={it.key}>
                    <SidebarMenuButton asChild tooltip={it.title}>
                      <RRNavLink to={it.path} className={({ isActive }) => cn("navitem", isActive && "active")}>
                        <it.icon size={16} weight="regular" />
                        <span>{it.title}</span>
                      </RRNavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="userchip">
                  <span className="ava">{user?.name.slice(0, 1) ?? "?"}</span>
                  <span className="meta grid flex-1 text-left leading-tight">
                    <span className="n truncate">{user?.name}</span>
                    <span className="r truncate text-xs">{user ? ROLE_TEXT[user.role] : ""}</span>
                  </span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-44">
                <DropdownMenuItem onClick={() => nav("/account")}>
                  <UserCircle size={15} /> 个人中心
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={logout}>
                  <SignOut size={15} /> 退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(() => localStorage.getItem("reactor.admin.theme") === "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("reactor.admin.theme", dark ? "dark" : "light");
  }, [dark]);
  return (
    <button className="iconbtn" title={dark ? "切换浅色" : "切换深色"} onClick={() => setDark((d) => !d)}>
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/**
 * D3：`/users` 旧书签直接重定向到合并页「组织与用户」，**带上原查询串**
 * （`usersRedirectTarget` 是纯函数，规则由 t198 钉住）。
 * 注意这个路由必须排在 `*` 兵底之前；它不依赖菜单 key，所以普通用户直接输 /users 也能正常落地
 * （被重定向到 /org，而 /org 不在其菜单里 ⇒ 再由 `*` 送到个人中心）。
 */
function UsersRedirect() {
  const location = useLocation();
  return <Navigate to={usersRedirectTarget(location.search)} replace />;
}

/**
 * 2026-09-19：`/models` 旧书签重定向到合并页「模型与供应商」。
 * 与 UsersRedirect 同一条纪律：规则本身在 `lib/route-paths.ts`（纯函数，探针直接钉），
 * 且必须排在 `*` 兜底之前。
 */
function ModelsRedirect() {
  const location = useLocation();
  return <Navigate to={modelsRedirectTarget(location.search)} replace />;
}

export function ConsoleLayout() {
  const { user, loading } = useAuthStore();
  const location = useLocation();
  const navKeys = useNavKeys(Boolean(user));

  if (loading) {
    return (
      <div className="grid h-full place-items-center gap-3">
        <div className="flex flex-col gap-3" style={{ width: 280 }}>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }
  if (!user) return <Login />;

  const groups = navFor(user.role, navKeys);
  const fallback = groups[0]?.items[0]?.path ?? "/account";
  const current = findItem(location.pathname);

  return (
    <SidebarProvider storageKey="reactor-admin-sidebar" className="app h-dvh">
      <AppSidebar groups={groups} />
      <SidebarInset>
        <header className="topbar">
          <SidebarTrigger />
          <div className="crumb">
            <span>{current?.title ?? "Reactor 管理台 · 数智堆脑"}</span>
          </div>
          <div className="spacer" />
          <ThemeToggle />
        </header>
        <div className="content scrollbar">
          <Routes>
            {groups.flatMap((g) => g.items).map((it) => (
              <Route key={it.path} path={it.path} element={it.el} />
            ))}
            {/*
             * 知识库组件样板页（临时验收用，不作为产品功能）：
             * 不走 menu（菜单可见性由服务端 /me/nav 的 key 集合驱动），直接给一个可达 URL 看观感。
             * 正式页（`/kb` → KbDatasetsPage）已于 KB-⑥ 接真数据，本页只剩「组件长相」的参考价值。
             */}
            <Route path="kb-preview" element={<KbPreview />} />
            {/*
             * 知识库用户侧（「都搬」批）：/datasets 是广场+我的库列表，/datasets/:id 是
             * 库详情（上传/文档/成员/对话）。上游的内部跳转写死 /datasets 前缀 ⇒ 路由按同名挂。
             */}
            <Route path="datasets" element={<DatasetsUserIndex />} />
            <Route path="datasets/:id" element={<DatasetDetailPage />} />
            {/* 合并前的旧路径（D3）：用户管理已并入「组织与用户」 */}
            <Route path="users" element={<UsersRedirect />} />
            {/* 2026-09-19 合并：模型管理已并入「模型与供应商」（旧链接/书签不留 404） */}
            <Route path="models" element={<ModelsRedirect />} />
            <Route path="*" element={<Navigate to={fallback} replace />} />
          </Routes>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
