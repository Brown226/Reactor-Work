// Reactor 管理台 · 语义徽标（T2）：shadcn Badge + 视觉规范 v1 语义色
import type { ReactNode } from "react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import type { Role } from "../types";

export type Tone = "success" | "danger" | "warn" | "info" | "accent" | "neutral";

const TONE_CLS: Record<Tone, string> = {
  success: "bg-[var(--success-soft)] text-[var(--success)]",
  danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
  warn: "bg-[var(--warn-soft)] text-[var(--warn)]",
  info: "bg-[var(--info-soft)] text-[var(--info)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent-strong)]",
  neutral: "bg-muted text-muted-foreground",
};

export function ToneBadge({
  tone = "neutral",
  dot,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", TONE_CLS[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </Badge>
  );
}

export const ROLE_TEXT: Record<Role, string> = {
  platform_admin: "平台管理员",
  dept_head: "部门负责人",
  user: "普通用户",
};

const ROLE_CLS: Record<Role, string> = {
  platform_admin: TONE_CLS.accent,
  dept_head: TONE_CLS.info,
  user: TONE_CLS.neutral,
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge variant="outline" className={cn("font-medium", ROLE_CLS[role])}>{ROLE_TEXT[role]}</Badge>;
}
