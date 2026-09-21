/**
 * JSON 抢救管线（W3-③）—— 设计照搬 LeAgent `tools/executor.py`（Apache-2.0）。
 *
 * ## 为什么需要它
 *
 * 模型流式产出的工具参数**经常**是脏 JSON：截断（token 上限）、多余闭合括号、
 * 未转义的内引号（尤其中英混排 `偶尔"忘记"用户`）、尾逗号、裸控制字符、外面裹一层
 * ``` 围栏或解释文字。任一情况直接失败就白烧一整轮 —— 而这些都是**可确定性修复**的。
 *
 * LeAgent 的做法是产出一串**递增修复的候选**，逐个尝试解析，第一个成功者胜出；
 * 另配一个**保守的截断补全**（只补缺失的引号与已隐含的定界符，**不臆造** key/value）。
 *
 * ## 核心纪律：只修「有据可依」的偏差
 *
 * - 尾逗号：只在 `,]`/`,}`（含空白）时删 —— 不是「见到逗号就删」。
 * - 内引号：只在**下一个非空白字符是 `, } ] :` 时**才当字符串终结符，否则补转义。
 * - 截断补全：只补**解析器已隐含要求**的字符，绝不新增键值。
 *
 * 宁可修不好（返回 null 让调用方报错），也不要修错（喂给执行器一个语义变了的对象）。
 *
 * 纯函数、零依赖、可单测。
 */

/** 去掉 BOM 与零宽前缀字符（模型/网关偶发插入） */
export function stripInvisiblePrefix(raw: string): string {
  return raw.replace(/^[\uFEFF\u200B\u200C\u200D\u2060]+/, "");
}

/** 去掉外层 markdown 代码围栏（```json ... ```） */
export function stripCodeFence(raw: string): string {
  const text = stripInvisiblePrefix(raw).trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return m ? stripInvisiblePrefix(m[1] ?? "").trim() : text;
}

/**
 * 删除对象/数组终结符**之前**的多余逗号（字符串内的逗号不动）。
 *
 * 例：`{"a":1,"b":2,}` → `{"a":1,"b":2}`
 */
export function repairTrailingCommas(raw: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (j < raw.length && (raw[j] === "}" || raw[j] === "]")) continue; // 丢弃该逗号
    }
    out.push(ch);
  }
  return out.join("");
}

/**
 * 转义字符串内出现的**裸控制字符**（`\n` `\r` `\t` 等）。
 *
 * 模型常在字符串值里直接换行，JSON 规范不允许。
 */
export function escapeControlCharsInStrings(raw: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        out.push(ch);
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out.push(ch);
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out.push(ch);
        inString = false;
        continue;
      }
      if (ch === "\n") {
        out.push("\\n");
        continue;
      }
      if (ch === "\r") {
        out.push("\\r");
        continue;
      }
      if (ch === "\t") {
        out.push("\\t");
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        out.push(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
        continue;
      }
      out.push(ch);
      continue;
    }
    out.push(ch);
    if (ch === '"') inString = true;
  }
  return out.join("");
}

/**
 * 判断某位置的引号是否**很可能**是字符串终结符。
 *
 * 依据：其后第一个非空白字符是 `,` `}` `]` `:`（或已到末尾）→ 终结；
 * 否则说明这是正文里的引号（如 `偶尔"忘记"用户`），应补转义。
 */
export function isLikelyStringTerminator(raw: string, quotePos: number): boolean {
  let j = quotePos + 1;
  while (j < raw.length && /[ \t\n\r]/.test(raw[j]!)) j++;
  if (j >= raw.length) return true;
  const c = raw[j]!;
  return c === "," || c === "}" || c === "]" || c === ":";
}

/**
 * 转义字符串值里**未转义的内引号**。
 *
 * 这是中英混排最常踩的坑：`{"text":"他偶尔"忘记"用户"}`。
 * 启发式：字符串内的 `"` 只有在「其后非空白是 `,}] :`」时才算终结符，否则写成 `\"`。
 */
export function escapeUnescapedQuotesInStrings(raw: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (!inString) {
      out.push(ch);
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out.push(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out.push(ch);
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (isLikelyStringTerminator(raw, i)) {
        out.push(ch);
        inString = false;
      } else {
        out.push('\\"');
      }
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

/**
 * 保守补全被**截断**的 JSON 对象/数组。
 *
 * 只做两件事（**不臆造** key/value/逗号）：
 *  ① 若停在字符串中间 → 补一个 `"`；
 *  ② 补上解析器已隐含要求的定界符（按栈逆序）。
 *
 * 已在末尾或无法补全 → 返回 null（交由调用方报错，而不是喂半个对象）。
 */
export function closeTruncatedJson(raw: string): string | null {
  const text = stripInvisiblePrefix(raw).trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return null; // 括号不匹配 → 放弃
      stack.pop();
    }
  }
  if (!inString && stack.length === 0) return null; // 本就完整

  let suffix = "";
  if (inString) {
    if (escaped) suffix += "\\";
    suffix += '"';
  }
  suffix += stack.reverse().join("");
  return text + suffix;
}

/**
 * 取出**前导的完整 JSON 对象**（等价 Python `json.JSONDecoder().raw_decode`）。
 *
 * 注意：本函数不要求「值在串首」—— 会先跳到首个 `{`（模型常在前面写「结果如下：」），
 * 再用括号配平找对象边界（**容忍非括号类的尾部垃圾**，如 `\n以上。`）。
 * 但尾部垃圾里若出现裸 `}`/`]`，说明括号错位，返回 null（交给 BFS 修复）。
 */
export function decodeLeadingObject(raw: string): Record<string, unknown> | null {
  const text = stripInvisiblePrefix(raw).trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  const body = text.slice(start);

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null; // 没有完整对象（可能被截断）

  // 尾部垃圾：允许空白与任意非括号字符（如「\n以上。」）；有裸括号则视为错位
  const rest = body.slice(end).trim();
  if (/[}\]]/.test(rest)) return null;

  try {
    const v = JSON.parse(body.slice(0, end)) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 尝试删掉**少量游离的 `}`/`]`** 使 JSON 可解析（模型常见嵌套打错）。
 *
 * 照 LeAgent `_try_repair_superfluous_closing_delimiter`：从解析错误位置附近
 * 的窗口内逐个试删（BFS，最多 `maxDeletions` 次），避免组合爆炸。
 *
 * 与 `decodeLeadingObject` 的分工：后者处理「对象完整 + 尾部只有括号垃圾」；
 * 本函数处理「括号错位导致整串不可解析」（如 `{"a":1]}]`：第一个 `]` 配错了 `{`）。
 */
export function repairSuperfluousClosingDelimiter(raw: string, maxDeletions = 3): Record<string, unknown> | null {
  const stripped = stripInvisiblePrefix(raw).trim();
  const asObject = (text: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text) as unknown;
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = asObject(stripped);
  if (direct) return direct;

  /** 取 JSON.parse 失败位置（Node 的 SyntaxError 带 position） */
  const errPos = (text: string): number | null => {
    try {
      JSON.parse(text);
      return null;
    } catch (err) {
      const pos = (err as { position?: unknown }).position;
      if (typeof pos === "number") return pos;
      // 兼容老版本：从 message 里抠 "position N"
      const m = /position (\d+)/.exec(String((err as Error).message ?? ""));
      return m ? Number(m[1]) : null;
    }
  };

  const seen = new Set<string>([stripped]);
  const queue: Array<{ text: string; deletions: number }> = [{ text: stripped, deletions: 0 }];
  const WINDOW = 24;
  while (queue.length > 0) {
    const { text, deletions } = queue.shift()!;
    if (deletions >= maxDeletions) continue;
    const pos = errPos(text);
    if (pos === null) continue;
    const lo = Math.max(0, pos - WINDOW);
    const hi = Math.min(text.length, pos + WINDOW + 1);
    for (let i = lo; i < hi; i++) {
      const ch = text[i];
      if (ch !== "}" && ch !== "]") continue;
      const cand = text.slice(0, i) + text.slice(i + 1);
      if (seen.has(cand)) continue;
      seen.add(cand);
      const parsed = asObject(cand);
      if (parsed) return parsed;
      queue.push({ text: cand, deletions: deletions + 1 });
    }
  }
  return null;
}

/**
 * 修复候选序列（**按修复力度递增**）。
 *
 * 调用方依序尝试 `JSON.parse`，第一个成功者胜出。顺序很关键：
 * 先试原文（大多数情况本就合法，避免无谓改写），再逐步增强。
 */
export function candidateJsonTexts(raw: string): string[] {
  const out: string[] = [];
  const add = (v: string): void => {
    if (!out.includes(v)) out.push(v);
  };
  add(raw);
  add(stripInvisiblePrefix(raw).trim());
  const fenced = stripCodeFence(raw);
  add(fenced);
  // 对已有候选逐个施加更强的修复（与 LeAgent 的候选生成顺序一致）
  for (const base of [...out]) {
    add(repairTrailingCommas(base));
    const ctrl = escapeControlCharsInStrings(base);
    add(ctrl);
    add(repairTrailingCommas(ctrl));
    // 引号修复放在控制字符转义**之前**，这样字符串内的裸换行不会让 inString 状态错乱
    const quoted = escapeUnescapedQuotesInStrings(base);
    add(quoted);
    const quotedCtrl = escapeControlCharsInStrings(quoted);
    add(quotedCtrl);
    add(repairTrailingCommas(quoted));
    add(repairTrailingCommas(quotedCtrl));
  }
  return out;
}

/** 解析结果：值 + 用了哪种手段（供日志/审计） */
export interface SalvageOutcome {
  value: Record<string, unknown>;
  /** 命中的修复方式（`raw` = 原文即合法） */
  strategy:
    | "raw"
    | "fence"
    | "trailing_comma"
    | "control_chars"
    | "quotes"
    | "truncation"
    | "trailing_junk"
    | "stray_delimiter"
    | "prose_around"
    | "prose_truncation";
}

/**
 * 抢救一个 JSON 对象（一站式入口）。
 *
 * 顺序：候选修复 → 截断补全 → 丢弃尾部多余闭合符。
 * 全部失败 → null（**绝不返回半个对象**）。
 */
export function salvageJsonObject(raw: unknown): SalvageOutcome | null {
  if (typeof raw !== "string") {
    // 已经是对象（某些 SDK 会预解析）→ 直接返回
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      return { value: raw as Record<string, unknown>, strategy: "raw" };
    }
    return null;
  }
  const text = raw.trim();
  if (text === "") return null;

  // ① 原文即合法（最常见，避免无谓改写）
  try {
    const v = JSON.parse(text) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return { value: v as Record<string, unknown>, strategy: "raw" };
  } catch {
    /* 继续修 */
  }

  // ② 候选序列（围栏/尾逗号/控制字符/内引号）
  const candidates = candidateJsonTexts(raw);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const strategy: SalvageOutcome["strategy"] = c === stripCodeFence(raw) && c !== text ? "fence" : "trailing_comma";
        return { value: v as Record<string, unknown>, strategy };
      }
    } catch {
      /* 试下一个 */
    }
  }

  // ③ 丢弃尾部多余闭合符（模型嵌套打错）；失败则试「删少量游离括号」（BFS）
  const leading = decodeLeadingObject(text);
  if (leading !== null) return { value: leading, strategy: "trailing_junk" };
  const repaired = repairSuperfluousClosingDelimiter(text);
  if (repaired !== null) return { value: repaired, strategy: "stray_delimiter" };

  // ③b 前后夹解释文字：先截到首个 `{` 再重试（「这是结果：{...}」/「{...}\n以上。」）
  const firstBrace = text.indexOf("{");
  if (firstBrace > 0) {
    const fromBrace = text.slice(firstBrace);
    const lead2 = decodeLeadingObject(fromBrace) ?? repairSuperfluousClosingDelimiter(fromBrace);
    if (lead2 !== null) return { value: lead2, strategy: "prose_around" };
    const closed2 = closeTruncatedJson(fromBrace);
    if (closed2 !== null) {
      try {
        const v = JSON.parse(closed2) as unknown;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          return { value: v as Record<string, unknown>, strategy: "prose_truncation" };
        }
      } catch {
        /* 继续 */
      }
    }
  }

  // ④ 截断补全（**保守**：只补引号与已隐含的定界符）
  for (const c of [text, stripCodeFence(raw)]) {
    const closed = closeTruncatedJson(c);
    if (closed === null) continue;
    try {
      const v = JSON.parse(closed) as unknown;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return { value: v as Record<string, unknown>, strategy: "truncation" };
      }
    } catch {
      /* 试下一个 */
    }
  }

  return null;
}
