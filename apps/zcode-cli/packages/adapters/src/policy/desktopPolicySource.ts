/**
 * 组织策略（`GET /desktop/policy`）在 **CLI 侧的只读读取点**（P4.2b / P4.3）。
 *
 * 状态所有权：文件由 Host 的 `ReactorPolicyCache` 独占写入
 * （`packages/services/src/reactor-server/reactorPolicyCache.ts`），CLI 只读；
 * 因此这里不做任何写入，也不缓存成第二份真相 —— 只在文件 mtime/size 变化时重读。
 *
 * 复用口径：路径与形状来自 `@zcode/shared` 的 `desktopPolicy.ts`（Host 与 CLI 共用同一契约）；
 * 判定函数（模式交集 / 命令黑名单 / 出网白名单）也在那里，强制点只调用不重写。
 *
 * 缺省语义（P4 文档 §4.3）：文件不存在、内容不可解析、字段缺失 → 视为**不限制**。
 * 这条与「拉取失败保留上一份」并不冲突：失败由 Host 决定（它不改写文件），
 * CLI 侧看到的一律是"当前生效的那一份"。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  REACTOR_DESKTOP_POLICY_FILE_NAME,
  USER_DATA_DIR_NAME,
  parseReactorDesktopPolicyFile,
  type ReactorDesktopPolicy,
  type ReactorDesktopPolicySource,
} from "@zcode/shared";

/** 显式覆盖策略文件路径（测试/多环境用；与 knowledge 缓存的 `REACTOR_KNOWLEDGE_DIR` 同风格）。 */
export const REACTOR_DESKTOP_POLICY_PATH_ENV = "REACTOR_DESKTOP_POLICY_PATH";

/**
 * 用户数据根解析：优先显式数据根，其次 `ZCODE_DATA_BASE_DIR`，最后 homedir。
 * 与 Host 侧 `packages/services/src/paths.ts#getZCodeDataRootDir` 同一优先级
 * （两边必须落在同一份 desktop-policy.json 上）。
 * 原先放在 shared 的 `resolveReactorUserDataRootDir`，但该模块会被渲染层经 barrel 求值、
 * 又要打进沙箱 preload，都不能碰 `node:path` / `process.env` —— 所以 Node 侧各自实现。
 */
function resolveUserDataRootDir(env: Record<string, string | undefined>): string {
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || homedir() || process.cwd();
  return join(base, USER_DATA_DIR_NAME);
}

/** 策略文件路径：显式覆盖 > `{ZCODE_DATA_BASE_DIR|homedir}/.reactor/desktop-policy.json`。 */
export function resolveDesktopPolicyFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[REACTOR_DESKTOP_POLICY_PATH_ENV]?.trim();
  if (override) return override;
  return join(resolveUserDataRootDir(env), REACTOR_DESKTOP_POLICY_FILE_NAME);
}

export interface DesktopPolicySourceOptions {
  /** 覆盖路径（缺省 `resolveDesktopPolicyFilePath()`；测试注入临时文件）。 */
  filePath?: string;
  /** 覆盖环境变量来源（缺省 `process.env`）。 */
  env?: Record<string, string | undefined>;
}

/**
 * 创建只读策略来源。**同步**实现：权限闸与出网闸都在请求热路径上，
 * 不能用异步读盘把一次工具调用拖成两段。
 *
 * 读盘策略：按 `mtimeMs + size` 判定是否需要重读；文件消失/损坏立即回落"不限制"。
 * 这里不做轮询，也不引入 TTL —— 策略变化由文件本身驱动（Host 原子重写）。
 */
export function createDesktopPolicySource(
  options: DesktopPolicySourceOptions = {},
): ReactorDesktopPolicySource {
  const filePath = options.filePath ?? resolveDesktopPolicyFilePath(options.env ?? process.env);
  let signature: string | null = null;
  let cached: ReactorDesktopPolicy | null = null;

  const readCurrent = (): ReactorDesktopPolicy | null => {
    let nextSignature: string;
    try {
      const stat = statSync(filePath);
      nextSignature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // 文件不存在（未登录 / 从未下发）→ 不限制。清掉缓存，避免旧策略在删除后继续生效。
      signature = null;
      cached = null;
      return null;
    }
    if (signature === nextSignature) return cached;
    signature = nextSignature;
    try {
      cached = parseReactorDesktopPolicyFile(JSON.parse(readFileSync(filePath, "utf8")) as unknown)
        ?.policy ?? null;
    } catch {
      cached = null;
    }
    return cached;
  };

  return { current: readCurrent };
}
