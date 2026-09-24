/**
 * 「把我采纳的审查问题改掉」这条指令的组装（纯函数，便于单测）。
 *
 * 组装规则本身是产品行为，值得钉住：模型要能**逐条对上**用户拍过板的问题，并且知道用哪个工具、
 * 用什么力度改。所以指令里给全四样东西——原件路径、规则码 + 行号、一字不改的原文片段、
 * 以及「怎么改」（建议）。
 *
 * 为什么把原文片段与建议分开写：审查结论里的 `suggestion` 往往是**散文**（"删除多余的「、」，
 * 改为「点击"完成"退出安装向导。」"）而不是字面替换串。工具只认字面原文/新文，字面值由模型从
 * 建议里读出来；所以指令必须同时给片段和建议，它才有依据推导新文本。
 */
import type { ReviewMark } from "@/store/reviewMarksStore.js";

/** 同一次请求里涉及的原件（可能跨文件）。 */
export interface ReviewFixGroup {
  sourcePath: string;
  marks: ReviewMark[];
}

/** 按原件分组，保持用户拍板的先后顺序。 */
export function groupReviewMarksBySource(marks: readonly ReviewMark[]): ReviewFixGroup[] {
  const groups: ReviewFixGroup[] = [];
  for (const mark of marks) {
    const sourcePath = mark.sourcePath ?? "";
    let group = groups.find((candidate) => candidate.sourcePath === sourcePath);
    if (!group) {
      group = { sourcePath, marks: [] };
      groups.push(group);
    }
    group.marks.push(mark);
  }
  return groups;
}

function describeMark(mark: ReviewMark, index: number): string[] {
  const lines = [`${index}. ${mark.code}　第 ${mark.line} 行`];
  lines.push(`   原文：${mark.quoted}`);
  const occurrence = mark.matchedOccurrence > 1 ? `（第 ${mark.matchedOccurrence} 次出现）` : "";
  if (occurrence) lines.push(`   位置：同一片段在文中出现多次，取${occurrence}`);
  lines.push(`   问题：${mark.message}`);
  if (mark.suggestion) {
    lines.push(`   改为：${mark.suggestion}`);
  } else {
    lines.push("   改为：按问题描述做最小改动（无法确定时跳过并说明）");
  }
  return lines;
}

/**
 * 组一条完整的修改指令。`marks` 为空时返回 null —— 调用方据此禁用按钮，不要发一条空指令。
 */
export function buildReviewFixPrompt(marks: readonly ReviewMark[]): string | null {
  if (marks.length === 0) return null;
  const groups = groupReviewMarksBySource(marks);
  const lines: string[] = [];
  lines.push(`对已采纳的审查问题做修改，共 ${marks.length} 条。`);
  if (groups.length === 1 && groups[0]!.sourcePath) {
    lines.push(`文件：${groups[0]!.sourcePath}`);
  }
  lines.push("");
  lines.push(
    "要求：逐条用 `docx_patch` 工具在原件上做**最小改动**（只换掉出问题的那几个字），" +
      "保持原有格式——字体、字号、加粗、段落、表格、编号、页眉页脚都不要动，不要重写整份文档；" +
      "默认另存为副本，不要覆盖原件。原文片段找不到、或与建议对不上的条目**跳过并说明**，不要猜。",
  );
  lines.push("");
  let index = 1;
  for (const group of groups) {
    if (groups.length > 1) {
      lines.push(`## ${group.sourcePath || "未标注来源"}`);
    }
    for (const mark of group.marks) {
      lines.push(...describeMark(mark, index));
      index += 1;
    }
  }
  lines.push("");
  lines.push("改完逐条回执：哪条已改、改成什么、哪条跳过及原因。");
  return lines.join("\n");
}
