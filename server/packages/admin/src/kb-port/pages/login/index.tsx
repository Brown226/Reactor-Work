// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/shared, @buildingai/stores）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/login/index.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  getFirstConsoleMenuPath,
  hasConsoleAccess,
  WEB_HOME_PATH,
} from "../../../kb-shims/console-services";
import { useAuthStore, useConfigStore } from "../../../kb-shims/ui";
import SvgIcons from "../../ui/components/svg-icons";
import { Navigate, useSearchParams } from "react-router-dom";

import { LoginForm } from "./_components/login-form";

function isAbsoluteHttpUrl(target: string) {
  return /^https?:\/\//i.test(target);
}

function isConsoleTarget(target: string) {
  if (!target) return false;
  const pathname = isAbsoluteHttpUrl(target) ? new URL(target).pathname : target;
  return pathname === "/console" || pathname.startsWith("/console/");
}

const LoginPage = () => {
  const [searchParams] = useSearchParams();
  const { userInfo } = useAuthStore((state) => state.auth);
  const { isLogin } = useAuthStore((state) => state.authActions);
  const { websiteConfig } = useConfigStore((state) => state.config);
  const redirect = searchParams.get("redirect") ?? "";

  if (isLogin()) {
    if (!userInfo) return null;

    if (!hasConsoleAccess(userInfo)) {
      const target = redirect && !isConsoleTarget(redirect) ? redirect : WEB_HOME_PATH;
      return <Navigate to={target} replace />;
    }

    const target = redirect || getFirstConsoleMenuPath(userInfo.menus ?? []);
    if (isAbsoluteHttpUrl(target)) {
      const url = new URL(target);
      if (url.port && url.pathname.includes("/extension/")) {
        const token = useAuthStore.getState().auth.token;
        if (token) {
          url.searchParams.set("_t", btoa(token));
        }
      }
      window.location.replace(url.toString());
      return null;
    }
    return <Navigate to={target} replace />;
  }
  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <a href="#" className="flex items-center gap-2 self-center font-medium">
          {websiteConfig?.webinfo.logo ? (
            <div className="flex items-center gap-2">
              <img className="h-8" src={websiteConfig?.webinfo.logo} alt="logo" />
              <span className="text-xl font-bold">{websiteConfig?.webinfo.name}</span>
            </div>
          ) : (
            <SvgIcons.buildingaiFull className="h-8" />
          )}
        </a>
        <LoginForm />
      </div>
    </div>
  );
};

export { LoginPage };
