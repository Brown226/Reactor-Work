/**
 * 桌面端知识库网关的启动与生命周期。
 *
 * ## 为什么单独一个模块
 *
 * `index.ts` 已经 2600+ 行，且启动流程本身很密（启动门禁、窗口恢复、Host 预热）。
 * 把网关的「起 / 停 / 数据目录解析」抽出来，主流程只留一行调用。
 *
 * ## 数据目录
 *
 * Web 端用 `<用户数据根>/knowledge`（`getZCodeDataRootDir()`）。桌面端**不复制
 * 这个值**：Electron 的 `userData` 由主进程用 `app.setPath` 显式指定过
 * （见 index.ts 的 `runtimeUserDataPath`），可能被环境变量覆盖。所以这里
 * 从 `app.getPath("userData")` 推导，保证与桌面端其它用户数据同源。
 *
 * ## 失败处理
 *
 * 网关起不来（端口耗尽 / sidecar 二进制缺失）**不能阻断应用启动** ——
 * 知识库是附加能力，主流程是对话。失败时返回 null，前端拿不到注入值，
 * `kb-api.ts` 会退回相对路径并自然 404，用户看到的是「知识库不可用」而不是
 * 「整个应用打不开」。
 */
import { join } from "node:path";

import { app } from "electron";

import {
  startKnowledgeGateway,
  type KnowledgeGatewayHandle,
} from "@zcode/server";

let handle: KnowledgeGatewayHandle | null = null;
let starting: Promise<KnowledgeGatewayHandle | null> | null = null;

/** 知识库数据根目录：与桌面端其它用户数据同在 `userData` 下。 */
export function resolveKnowledgeDataRoot(): string {
  return join(app.getPath("userData"), "knowledge");
}

/**
 * 启动知识库网关（幂等）。返回 `null` 表示启动失败，调用方应继续启动流程。
 */
export async function ensureKnowledgeGateway(
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<KnowledgeGatewayHandle | null> {
  if (handle) return handle;
  if (starting) return starting;

  starting = (async () => {
    try {
      const dataRoot = resolveKnowledgeDataRoot();
      const started = await startKnowledgeGateway({ dataRoot });
      handle = started;
      logger.info("[knowledge-gateway] 已启动", started.baseUrl, "dataRoot:", dataRoot);
      return started;
    } catch (error) {
      logger.warn("[knowledge-gateway] 启动失败，知识库入口将不可用", error);
      return null;
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/** 当前网关地址；未启动或启动失败返回 undefined。 */
export function getKnowledgeGatewayUrl(): string | undefined {
  return handle?.baseUrl;
}

/** 关停网关。幂等；进程退出时必须调用，否则 sidecar 常驻进程会残留。 */
export async function shutdownKnowledgeGateway(): Promise<void> {
  const current = handle;
  handle = null;
  if (!current) return;
  try {
    await current.close();
  } catch {
    // 关闭失败不抛：进程正在退出，抛出去也没人能处理。
  }
}
