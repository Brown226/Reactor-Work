export type InterfaceMode = "office" | "coding" | "review";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

/**
 * 白名单关闭时的默认可用档：**不含编程档**。
 *
 * 编程模式受服务端受众控制（见 `docs/未完成-编程模式权限-方案-v1.md`），未拿到策略时
 * 一律按「只开放办公/审查」处理 —— 这是「未授权看不到编程模式」的客户端起点，
 * 与 `@zcode/shared` 的 `DEFAULT_REACTOR_DESKTOP_POLICY.allowedInterfaceModes` 同口径。
 */
export const DEFAULT_AVAILABLE_INTERFACE_MODES: readonly InterfaceMode[] = ["office", "review"];

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // localStorage（zcode-interface-mode）里可能还存着改名前的旧值 "general"/"concise"，
  // 必须映射到新名 office，否则这些存量用户升级后会被归一成 coding，静默丢失选择。
  if (value === "general" || value === "concise") return "office";
  if (value === "office" || value === "coding" || value === "review") return value;
  return "coding";
}

/**
 * 归一化服务端下发的「可用界面模式」集合（`allowedInterfaceModes`）。
 *
 * 纯函数（无副作用），便于 `npx tsx --test` 覆盖 —— 它决定用户能见到哪些档，
 * 算错会让受限用户莫名看到编程模式、或把所有人锁死在办公档。
 *
 * 规则：
 * - 非数组 / 解析不出任何合法档 → 回落白名单关闭默认（**绝不放大可见性**）；
 * - 只保留词表内取值并去重、保持服务端顺序。
 */
export function normalizeAvailableInterfaceModes(value: unknown): InterfaceMode[] {
  if (!Array.isArray(value)) return [...DEFAULT_AVAILABLE_INTERFACE_MODES];
  const seen = new Set<InterfaceMode>();
  const result: InterfaceMode[] = [];
  for (const item of value) {
    if (item === "office" || item === "coding" || item === "review") {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result.length > 0 ? result : [...DEFAULT_AVAILABLE_INTERFACE_MODES];
}

/**
 * 从「当前档」与「可用档集合」求一个**必然可用**的档：
 * 当前档在集合内则原样保留；否则优先落 `office`（办公档逃生口），再退而取集合首项。
 *
 * 为什么优先 office 而不是集合首项：未授权编程的存量用户本地多半存着 `coding`，
 * 兜底到办公档最符合产品语义（受限用户落到最保守的可用形态）。
 */
export function resolveAvailableInterfaceMode(
  current: InterfaceMode,
  available: readonly InterfaceMode[],
): InterfaceMode {
  if (available.includes(current)) return current;
  if (available.includes("office")) return "office";
  return available[0] ?? "office";
}
