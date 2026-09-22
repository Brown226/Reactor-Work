import {
  Code2,
  FileSearch2,
  ShieldCheck,
  PanelsTopLeft,
  PenTool,
  GraduationCap,
  Video,
  Store,
  Megaphone,
  BriefcaseBusiness,
  Rocket,
  Scale,
  Ellipsis,
  type LucideIcon,
} from "lucide-react";

export const occupations = [
  "developer",
  "independent",
  "infrastructure",
  "product",
  "design",
  "student",
  "finance",
  "creator",
  "operations",
  "marketing",
  "legal",
  "other",
] as const;

export type OccupationValue = (typeof occupations)[number];

/**
 * 界面模式图标：coding / office / review。
 *
 * review 只出现在主面板胶囊（首次引导保持两档，见 docs/interface-mode.md 第 2 节），
 * 但图标仍收在这里，保证同一模式在全应用只有一套视觉标识。
 */
export const modeOptionIcons = {
  coding: Code2,
  office: PanelsTopLeft,
  review: FileSearch2,
} as const;

const occupationIcons = [
  Code2,
  Rocket,
  ShieldCheck,
  PanelsTopLeft,
  PenTool,
  GraduationCap,
  BriefcaseBusiness,
  Video,
  Store,
  Megaphone,
  Scale,
  Ellipsis,
];

export function getOccupationIcon(index: number): LucideIcon {
  return occupationIcons[index] ?? Ellipsis;
}
