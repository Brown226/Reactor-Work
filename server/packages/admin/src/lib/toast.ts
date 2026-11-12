// Reactor 管理台 · toast 适配器：统一转发到 ui.tsx 的实现（单一来源）。
//
// ⚠ 2026-09-12 实测踩到的坑：本文件原先是 sonner 适配器，而 main.tsx 挂载的是
// ui.tsx 里自研的 <Toaster /> —— 两套 toast 互不相通，导致 8 个页面
//（Users/Org/Roles/Skills/Agents/Models/Providers/SyncLogs）的**成功/失败提示永远不显示**，
// 保存失败也毫无反馈。现改为转发到已挂载的那一套；sonner 依赖与 components/ui/sonner.tsx
// 目前无人使用，保留仅为日后需要富交互 toast 时参考。
export { toast, Toaster } from "../ui";
