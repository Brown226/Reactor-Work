/**
 * 会话标题生成（清单 #9）—— 移植 pi-web `lib/session-title.ts` 的**纯函数部分**（MIT）。
 *
 * 派生逻辑（shadow Agent / prompt 拼接）留在 sidecar（需要 pi 内核类型）；
 * 这里只放「模型输出 → 可用标题」的清洗规则，可单测、与内核版本解耦。
 */

/** 标题最长字符数（对齐 pi-web `MAX_TITLE_LENGTH`；CJK 按字符计） */
export const SESSION_TITLE_MAX_LENGTH = 80;

/** 标题请求提示词（对齐 pi-web `TITLE_PROMPT`） */
export const SESSION_TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

/** 剥成对包裹符号（引号/书名号/直角引号等） */
function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

/**
 * 模型输出 → 可用标题。
 * 清洗顺序：剥代码围栏 → 尝试 JSON `{title}` → 取首行 → 剥「标题：」前缀 →
 * 剥包裹引号 → 空白归一 → 去尾部句号 → 截断到 80 字符。
 * 结果必须含字母或数字，否则抛错（调用方按失败处理，不落半成品标题）。
 */
export function parseGeneratedSessionTitle(raw: string): string {
  let value = String(raw ?? "").trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1] !== undefined) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // 非法 JSON → 走纯文本清洗
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  const characters = Array.from(value);
  if (characters.length > SESSION_TITLE_MAX_LENGTH) {
    const sliced = characters.slice(0, SESSION_TITLE_MAX_LENGTH).join("").trim();
    value = sliced ?? "";
  }

  if (!/\p{L}|\p{N}/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }
  return value;
}

/** 标题清洗失败（供调用方区分「模型没给可用标题」与其它错误） */
export class SessionTitleError extends Error {}
