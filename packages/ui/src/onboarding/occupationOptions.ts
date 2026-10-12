import { Code2, FileSearch2, PanelsTopLeft } from "lucide-react";

/**
 * 界面模式图标：coding / office / review。
 *
 * review 只出现在主面板胶囊（见 docs/已完成/已完成-interface-mode.md 第 2 节），
 * 但图标仍收在这里，保证同一模式在全应用只有一套视觉标识。
 */
export const modeOptionIcons = {
  coding: Code2,
  office: PanelsTopLeft,
  review: FileSearch2,
} as const;
