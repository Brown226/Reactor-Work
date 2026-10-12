export type InterfaceMode = "office" | "coding" | "review";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // localStorage（zcode-interface-mode）里可能还存着改名前的旧值 "general"/"concise"，
  // 必须映射到新名 office，否则这些存量用户升级后会被归一成 coding，静默丢失选择。
  if (value === "general" || value === "concise") return "office";
  if (value === "office" || value === "coding" || value === "review") return value;
  return "coding";
}
