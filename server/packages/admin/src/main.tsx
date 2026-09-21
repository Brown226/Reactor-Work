import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/tw.css";
import "./tokens.css";
import "./styles.css";
import { AuthProvider } from "./auth";
import { ConsoleLayout } from "./layouts/console";
import { Toaster } from "./ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setKbQueryClient } from "./kb-shims/data";

// 知识库用户侧页面（pages/datasets 移植件）构建在 react-query 之上 ⇒ 在根上挂 Provider，
// 并把 client 交给 kb-shims 的适配层做缓存失效（setKbQueryClient）。
const kbQueryClient = new QueryClient();
setKbQueryClient(kbQueryClient);

/**
 * 路由前缀：
 *  - 开发期页面在 `/`（vite 5174）→ basename "/"；
 *  - 生产由服务端托管在 `/console` 下（server/src/identity/admin-static.ts）→ basename "/console"，
 *    否则菜单里的绝对路径（/models 等）会直接吃掉子路径、页面渲染为空。
 * 运行时判定，两种形态共用同一份产物。
 */
const BASENAME = typeof window !== "undefined" && window.location.pathname.startsWith("/console") ? "/console" : "/";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={kbQueryClient}>
      <BrowserRouter basename={BASENAME} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ConsoleLayout />
      </BrowserRouter>
      </QueryClientProvider>
      <Toaster />
    </AuthProvider>
  </StrictMode>,
);
