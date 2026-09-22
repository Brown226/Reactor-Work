export type InterfaceMode = "office" | "coding" | "review";

/**
 * 首次引导可选的档位子集。
 *
 * 引导是产品定位问卷，只问编程/办公两档；「审查」只能从主面板胶囊进入。
 * 该不对称是有意的（见 docs/interface-mode.md 第 2 节），不要为了让类型统一而补齐。
 */
export type OnboardingInterfaceMode = "office" | "coding";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // localStorage（zcode-interface-mode）里可能还存着改名前的旧值 "general"/"concise"，
  // 必须映射到新名 office，否则这些存量用户升级后会被归一成 coding，静默丢失选择。
  if (value === "general" || value === "concise") return "office";
  if (value === "office" || value === "coding" || value === "review") return value;
  return "coding";
}

/**
 * 把任意档位收窄为引导可记录的子集。
 *
 * 存量用户可能已经停在 review 档（主面板切的），而引导记录 schema 只有 coding/office；
 * 在写入引导记录的边界处收窄，避免为此扩宽服务端 schema。审查档按最接近的
 * 展示语义记为 office（两者都属收敛档位）。
 */
export function toOnboardingInterfaceMode(
  mode: InterfaceMode | null,
): OnboardingInterfaceMode | null {
  if (mode === null) return null;
  return mode === "coding" ? "coding" : "office";
}
