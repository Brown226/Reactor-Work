// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/constants/shared/status-codes.constant, @buildingai/stores）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/auth/permission-guard.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { BooleanNumber } from "../../../../kb-shims/ui";
import { useAuthStore } from "../../../../kb-shims/ui";
import type { ReactNode } from "react";
import { toast } from "sonner";

export interface PermissionGuardProps {
  children: ReactNode;
  /**
   * Permission code(s) required to render children.
   * Can be a single code or an array of codes.
   * User must have ALL specified permissions (AND logic).
   */
  permissions: string | string[];
  /**
   * If true, user only needs ONE of the specified permissions (OR logic).
   * @default false
   */
  any?: boolean;
  /**
   * If true, children are visible but interactions are blocked with toast.
   * If false, hide children when permission is denied.
   * @default false
   */
  blockOnly?: boolean;
  /**
   * If true, show toast when interaction is blocked.
   * @default true
   */
  showToast?: boolean;
  /**
   * Custom toast message when permission is denied.
   * @default "无权限执行此操作"
   */
  toastMessage?: string;
  /**
   * Fallback content when permission is denied and hidden is true.
   */
  fallback?: ReactNode;
  /**
   * Callback when interaction is blocked due to permission denial.
   */
  onDenied?: () => void;
}

/**
 * Conditionally render or block interactions based on user permissions.
 * Root users bypass all permission checks.
 *
 * By default, children are hidden when permission is denied.
 * Set `blockOnly` to true to show children but block interactions with toast.
 */
export function PermissionGuard({
  children,
  permissions,
  any = false,
  blockOnly = false,
  showToast = true,
  toastMessage = "无权限执行此操作",
  fallback = null,
  onDenied,
}: PermissionGuardProps) {
  const { userInfo } = useAuthStore((state) => state.auth);

  const isRoot = userInfo?.isRoot === BooleanNumber.YES;
  const userPermissions = userInfo?.permissionsCodes ?? [];

  const permissionList = Array.isArray(permissions) ? permissions : [permissions];

  const hasPermission = any
    ? permissionList.some((p) => userPermissions.includes(p))
    : permissionList.every((p) => userPermissions.includes(p));

  const isAllowed = isRoot || hasPermission;

  if (!isAllowed && !blockOnly) {
    return <>{fallback}</>;
  }

  if (!isAllowed) {
    const handleInteraction = (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (showToast) {
        toast.error(toastMessage);
      }
      onDenied?.();
    };

    return (
      <div onClick={handleInteraction} onKeyDown={handleInteraction} className="cursor-not-allowed">
        <div className="pointer-events-none">{children}</div>
      </div>
    );
  }

  return <>{children}</>;
}
