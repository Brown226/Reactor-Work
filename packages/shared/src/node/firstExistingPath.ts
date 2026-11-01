/**
 * 运行时资产/引擎根解析的公共候选链求值。
 *
 * 背景：同一「显式 env → 安装器资源 → bundled-tools/<platform> → 包内 assets」
 * 候选链模式曾散落 8 处手写循环（file-tools/dwg-tools/ocr-tools 的 assets 解析、
 * server 的 sidecar 解析、services 的 runtimeToolResolver/officeEnginesEnv、
 * providerRuntimeResolver、desktop 的 desktopRuntimeEnv），历史上因候选目录
 * 漂移不同步出过 bug。这里收口「候选求值 + 存在性判定」这一最小公共件：
 * 调用方只声明候选表达式与可选校验谓词，不再各写一遍 existsSync 循环。
 */
import { statSync } from "node:fs";

export interface FirstExistingPathOptions {
  /** 期望的条目形态；缺省时文件/目录都算命中。 */
  kind?: "file" | "directory";
  /** 命中后的内容校验（如「目录下必须有某个标记文件」）；不满足继续试下一候选。 */
  validate?: (path: string) => boolean;
}

/** 逐个求值候选路径，返回第一个存在（且形态/校验匹配）的；全不命中返回 null。 */
export function firstExistingPath(
  candidates: Array<string | null | undefined>,
  options: FirstExistingPathOptions = {},
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stats = statSync(candidate);
      if (options.kind === "file" && !stats.isFile()) continue;
      if (options.kind === "directory" && !stats.isDirectory()) continue;
      if (options.validate && !options.validate(candidate)) continue;
      return candidate;
    } catch {
      // 不存在/不可访问 → 试下一个候选
    }
  }
  return null;
}

/**
 * 目录候选的惯用法：带内容校验时先找强命中，全落后退回仅存在即命中的弱匹配
 * （避免把半成品资产根当完整根用，见 file-tools 的 canvas 判定）。
 */
export function firstExistingDir(
  candidates: Array<string | null | undefined>,
  validate?: (dir: string) => boolean,
): string | null {
  if (!validate) return firstExistingPath(candidates, { kind: "directory" });
  const strong = firstExistingPath(candidates, { kind: "directory", validate });
  if (strong) return strong;
  return firstExistingPath(candidates, { kind: "directory" });
}
