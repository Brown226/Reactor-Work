// Reactor 管理台 · 薄 UI 层（纯 CSS，视觉规范 §3 组件语法）

import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle,
  Info,
  PlusCircle,
  Warning,
  X,
  XCircle,
} from "@phosphor-icons/react";
import type { Role } from "./types";

/* ---------- Toast（事件驱动，轻量） ---------- */
export type ToastKind = "ok" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}
type Listener = (t: ToastItem) => void;
let seq = 0;
const listeners = new Set<Listener>();
function notify(kind: ToastKind, text: string): void {
  const t = { id: ++seq, kind, text };
  listeners.forEach((l) => l(t));
}
export const toast = {
  ok: (m: string) => notify("ok", m),
  error: (m: string) => notify("error", m),
  info: (m: string) => notify("info", m),
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const on = (t: ToastItem) => {
      setItems((p) => [...p, t]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== t.id)), 3200);
    };
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  const Icon = (k: ToastKind) =>
    k === "ok" ? <CheckCircle size={15} /> : k === "error" ? <XCircle size={15} /> : <Info size={15} />;
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "ok" ? "success" : t.kind}`}>
          {Icon(t.kind)}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- 按钮 ---------- */
type BtnVariant = "primary" | "ghost" | "danger";
export function Button({
  variant = "ghost",
  size,
  icon,
  children,
  ...rest
}: {
  variant?: BtnVariant;
  size?: "sm";
  icon?: ReactNode;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`btn btn-${variant}${size ? ` btn-${size}` : ""}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/* ---------- 徽标 ---------- */
type Tone = "success" | "danger" | "warn" | "info" | "accent" | "neutral";
export function Badge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export const ROLE_TEXT: Record<Role, string> = {
  platform_admin: "平台管理员",
  dept_head: "部门负责人",
  user: "普通用户",
};
export const ROLE_TONE: Record<Role, string> = {
  platform_admin: "badge-role-admin",
  dept_head: "badge-role-head",
  user: "badge-role-user",
};
export function RoleBadge({ role }: { role: Role }) {
  return <span className={`badge ${ROLE_TONE[role]}`}>{ROLE_TEXT[role]}</span>;
}

/* ---------- 表单 ---------- */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/* ---------- 头像（首字） ---------- */
export function Initial({ name, size = 26 }: { name: string; size?: number }) {
  const ch = (name || "?").slice(0, 1);
  return (
    <span className="ava" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {ch}
    </span>
  );
}

/* ---------- 弹窗（居中模态；原右侧抽屉已统一改为居中） ---------- */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return (
    <>
      <div className="mask" onClick={onClose} />
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-label={String(title)}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

/* ---------- 空态 / 加载 ---------- */
export function Empty({ icon, title, desc, children }: { icon?: ReactNode; title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <PlusCircle size={26} />}
      <div className="t">{title}</div>
      {desc && <div className="s">{desc}</div>}
      {children}
    </div>
  );
}

export function SkeletonRows({ n = 6 }: { n?: number }) {
  return (
    <div style={{ padding: "12px 16px" }}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 34, marginBottom: 10 }} />
      ))}
    </div>
  );
}

/* ---------- 页面标题 ---------- */

/**
 * 数据范围（**只表达「你能看到多少数据」，不表达权限角色**）。
 *
 * 为什么把它从 `string` 收紧成联合类型（2026-09-19 用户口径：
 * 「删除掉右上角这个『范围：仅平台管理员』，以后都不许加这个，没有必要」）：
 * 旧接口收任意字符串，于是那个位置被塞进了**权限说明**——「仅平台管理员」不是数据范围，
 * 它既不随数据变、也对用户没有指导意义，纯噪音。
 * 收紧成枚举后，想把权限角色塞进来会直接**编译不过**，不需要靠人去记得别加。
 *
 * `all` 是默认态，**不渲染**（天天显示等于没信息）；只有真的受限（部门/本人）才提示。
 */
export type DataScope = "all" | "dept" | "self";

/** 数据范围徽标的文案（只在这里维护；改文案不动调用点） */
const DATA_SCOPE_TEXT: Record<Exclude<DataScope, "all">, string> = {
  dept: "本部门及以下",
  self: "仅本人（你自己的数据）",
};

export function PageHead({
  title,
  desc,
  right,
  scope,
}: {
  title: string;
  desc?: string;
  right?: ReactNode;
  /** 数据范围：仅 `dept` / `self` 会显示徽标，`all`（默认态）与省略都不显示 */
  scope?: DataScope;
}) {
  // 参数保留（调用点一行不用改），当前故意不渲染 —— `void` 显式声明"就是不用"，
  // 否则 noUnusedParameters 会把它们当成漏用的变量报错。
  void title;
  void desc;
  return (
    <div className="page-head">
      {/* 标题与说明**不再渲染**：顶部栏的 `.crumb` 已经显示页面标题（并已放大加粗），
          这里再来一份就是每页重复两次、白占内容区首屏空间（用户口径：删掉下方那份）。
          `title`/`desc` 参数**保留** —— 调用点一行都不用改，哪天真需要页内大标题也能一键恢复。 */}
      <div className="right">
        {scope !== undefined && scope !== "all" ? (
          <span className="scopechip">
            <Warning size={12} /> 范围：{DATA_SCOPE_TEXT[scope]}
          </span>
        ) : null}
        {right}
      </div>
    </div>
  );
}
