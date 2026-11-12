/**
 * 用户数据隔离的 Renderer 侧动作：登录/登出后重启应用，让新命名空间生效。
 *
 * 为什么必须重启：数据根按企业用户分命名空间（`docs/已完成/已完成-用户数据隔离-命名空间与切换.md`），
 * scope 由 Main 在 fork Host 时注入；已打开的 tasks-index / db.sqlite 句柄与缓存目录不会
 * 跟着搬，进程内换 scope 只会得到"一半新一半旧"的撕裂视图。
 *
 * marker 已在 Host 侧登录/登出 RPC 返回前同步落盘，所以这里的重启一定读到新 scope。
 *
 * Web / 手机远控没有本地数据根可切（平台服务缺席或非 Electron），直接跳过——
 * 远控看到的是桌面当前登录用户的数据，隔离由桌面侧负责。
 */
import { useCallback } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { useOptionalPlatform } from "./usePlatform.js";

export function useRestartForDataScopeSwitch(): () => Promise<void> {
  const platform = useOptionalPlatform();
  return useCallback(async () => {
    if (!platform) return;
    try {
      await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
    } catch {
      // 重启失败不阻断登录结果：用户手动重启后 marker 仍然指向新 scope，隔离不会失效。
    }
  }, [platform]);
}
