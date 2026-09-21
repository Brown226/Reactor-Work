// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web, @buildingai/stores）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/login/oauth-callback.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { exchangeOAuthCode } from "../../../kb-shims/console-services";
import { useAuthStore } from "../../../kb-shims/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

const OAuthCallbackPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setToken } = useAuthStore((state) => state.authActions);
  const [error, setError] = useState<string | null>(null);

  const code = useMemo(() => searchParams.get("code"), [searchParams]);
  const redirect = useMemo(() => searchParams.get("redirect") || "/", [searchParams]);

  useEffect(() => {
    if (!code) {
      setError("missing_code");
      return;
    }

    let cancelled = false;
    exchangeOAuthCode(code)
      .then((data) => {
        if (cancelled) return;
        setToken(data.token);
        window.history.replaceState(null, "", window.location.pathname);
        navigate(redirect, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        setError("invalid_or_expired_code");
      });

    return () => {
      cancelled = true;
    };
  }, [code, redirect, setToken, navigate]);

  if (error) {
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-6 p-6">
        <p className="text-muted-foreground text-sm">
          {error === "missing_code" ? "缺少授权码" : "授权已失效或已使用，请重新登录"}
        </p>
        <a href="/login" className="text-primary hover:underline">
          返回登录
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-svh flex-col items-center justify-center gap-6 p-6">
      <Loader2 className="text-primary size-10 animate-spin" />
      <p className="text-muted-foreground text-sm">正在登录...</p>
    </div>
  );
};

export { OAuthCallbackPage };
