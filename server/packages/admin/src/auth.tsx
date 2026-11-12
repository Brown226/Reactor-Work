// ⚠️ 过渡 shim（T1-2）：旧组件仍从此导入 useAuth/scopeLabel；新代码请用 stores/auth。
// T2 换皮完成后本文件删除。AuthProvider 仅负责启动时水合一次会话。

import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "./stores/auth";

export { scopeLabel, useAuth } from "./stores/auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  const reload = useAuthStore((s) => s.reload);
  useEffect(() => {
    void reload();
  }, [reload]);
  return <>{children}</>;
}
