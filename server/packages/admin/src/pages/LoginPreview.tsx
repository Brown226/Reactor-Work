/**
 * 移植登录页的**验收入口**（整台换皮第 1 步）。
 *
 * 为什么单独包一层：移植来的 `kb-port/pages/login` 是**原文照搬**的，它不知道自己被搬到了哪个作用域。
 * 这一层干三件事：
 *   1. `import "../kb-port/theme/theme.css"` —— 把上游的设计令牌（已作用域化）加载进来；
 *   2. 套 `.reactor-kb-scope` —— 令牌只在**这个子树**内生效，后台其它页面的橙色主题一点不动；
 *   3. 把上游的 named export `LoginPage` 转成我们路由好用的 default。
 *
 * 取数层（登录调什么接口、哪些登录方式没接入）全在 `src/kb-shims/login.tsx`，本文件不碰逻辑。
 *
 * ⚠️ 临时件：它是「让皮能被肉眼验收」的脚手架。等移植登录页正式接管登录流程后，本文件删掉
 * （与 `pages/KbPreview.tsx` 同一处置口径）。
 */
import "../kb-port/theme/theme.css";

import { AlertDialogProvider } from "../kb-port/ui/hooks/use-alert-dialog";
import { LoginPage } from "../kb-port/pages/login";

export default function LoginPreview() {
  return (
    // AlertDialogProvider 是**必需**的：移植来的页面顶层就调 `useAlertDialog()`（例如登录页的
    // 「未登录/账号不存在」提示），而这个 hook 在 provider 外会直接抛错。
    // 它同时负责渲染弹窗宿主 —— 所以不是「可选包裹」，漏了就是白屏。
    <div className="reactor-kb-scope bg-background min-h-screen">
      <AlertDialogProvider>
        <LoginPage />
      </AlertDialogProvider>
    </div>
  );
}
