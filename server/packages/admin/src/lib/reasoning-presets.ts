/**
 * 推理档位预设与按模型特征的推断（纯函数，**不引任何页面/组件/服务**）。
 *
 * ## 为什么要有这个模块
 *
 * 2026-10-13 上线时，「推理档位」是两个自由文本框：一个填逗号分隔的档位可选值，
 * 一个填 CEL 表达式把档位写进请求体。它假设管理员既知道上游认哪个参数名、又会写 CEL
 * —— 实际没人填得对，于是桌面端要么不展示思考档位，要么带上游不认的参数直接 400
 * （用户反馈的「打开思考后无法正常对话」）。
 *
 * 本模块把「档位集合 + 请求体映射」捆成**一个语义化选项**，管理员只点一下；
 * 存储格式不变（仍是 `params.reasoning_levels` + `params.reasoning_map`），
 * 所以服务端契约、桌面端消费逻辑都零改动。
 *
 * ## 关于"智能检测"的边界（重要，不要过度承诺）
 *
 * 这里做的是**按模型 id/显示名做保守匹配 + 预填**，不是真的去探测上游支持什么：
 * 探测需要发真实请求、花 token，且结果随上游版本变化，做成隐式自动行为风险更大。
 * 预填值管理员看得见、能改，配完还可用模型行上的「测试」按钮发一次真实调用验证
 * —— 那条链路本来就在（`testModel`），正好补上"猜错了怎么办"。
 *
 * 因此推断规则只收**上游公开且稳定**的参数约定；匹配不上一律落到
 * 「思考开关（不传参）」这个安全缺省：宁可功能降级，也不能让桌面端
 * 带上游不认的参数直接 400。
 */

/** 一个推理档位预设：档位可选值集合 + 档位到请求体的 CEL 映射。 */
export interface ReasoningPreset {
  readonly key: string;
  readonly label: string;
  /** 档位可选值，按语义强度从低到高；空数组 = 桌面端不展示思考档位 */
  readonly levels: readonly string[];
  /** 档位 → 请求体的受限 CEL 表达式；"{}" = 不往请求体写任何字段 */
  readonly map: string;
  /** 界面上的说明：这个预设适合谁、有什么后果 */
  readonly hint: string;
}

/** 自定义入口的 key（不在 REASONING_PRESETS 里，由界面单独处理）。 */
export const REASONING_CUSTOM_KEY = "custom";

/**
 * 预设表。
 *
 * 档位顺序**有意义**（桌面端按语义强度从低到高展示，默认取最后一项），
 * 所以这里把 disabled 放最前；新增预设时不要随意重排。
 */
export const REASONING_PRESETS: readonly ReasoningPreset[] = [
  {
    key: "off",
    label: "不支持思考",
    levels: [],
    map: "{}",
    hint: "桌面端不展示思考档位。模型确实没有推理能力时选这个。",
  },
  {
    key: "toggle-only",
    label: "思考开关（不往上游传参）",
    levels: ["disabled", "enabled"],
    map: "{}",
    hint: "最安全：档位只作端侧状态，请求体不加任何字段。确定不了上游参数名时先用这个。",
  },
  {
    key: "effort",
    label: "思考强度 · reasoning_effort",
    levels: ["disabled", "low", "medium", "high"],
    map: 'reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}',
    hint: "按强度传参的模型（OpenAI o 系列、StepFun 等）。选 disabled 时不发该字段。",
  },
  {
    key: "thinking-bool",
    label: "思考开关 · thinking（智谱 GLM）",
    levels: ["disabled", "enabled"],
    map: 'reasoningLevel == "disabled" ? {} : {"thinking": {"type": "enabled"}}',
    hint: "智谱 GLM 系列：thinking 是对象而非布尔，写成布尔上游会报错。",
  },
  {
    key: "enable-thinking",
    label: "思考开关 · enable_thinking（通义千问）",
    levels: ["disabled", "enabled"],
    map: 'reasoningLevel == "disabled" ? {} : {"enable_thinking": true}',
    hint: "通义千问 Qwen 系列：enable_thinking 为布尔。",
  },
];

/** 按 key 取预设；找不到返回 undefined（调用方需处理自定义态）。 */
export function findReasoningPreset(key: string): ReasoningPreset | undefined {
  return REASONING_PRESETS.find((preset) => preset.key === key);
}

/** 反查：给定 levels + map，返回命中的预设 key；都不中则视为自定义。 */
export function matchReasoningPreset(
  levels: readonly string[] | null | undefined,
  map: string | null | undefined,
): string {
  const normalizedLevels = levels ?? [];
  const normalizedMap = map ?? "{}";
  const hit = REASONING_PRESETS.find(
    (preset) =>
      preset.levels.length === normalizedLevels.length &&
      preset.levels.every((level, index) => level === normalizedLevels[index]) &&
      preset.map === normalizedMap,
  );
  return hit ? hit.key : REASONING_CUSTOM_KEY;
}

/**
 * 推断入参：只取推断真正用到的几个字段，不引 `AdminModel`
 * （那样会把 services/http 链拖进这个纯函数模块，探针就跑不起来了）。
 */
export interface ReasoningModelHint {
  readonly model: string;
  readonly displayName?: string | null;
  readonly reasoningLevels?: readonly string[] | null;
  readonly reasoningMap?: string | null;
}

/**
 * 按模型特征推断建议的推理预设 key。
 *
 * 两种输入：
 * 1. **已配置过** —— 反查预设，命中就直接选中该项（让管理员看到自己配的是哪个预设）；
 *    不中说明是非标准写法，落自定义并保留原值（绝不静默改写别人的配置）。
 * 2. **未配置** —— 按模型 id/显示名做保守匹配，匹配不上落安全缺省 `toggle-only`。
 *
 * 返回值只是**预填建议**：界面照常展示、管理员可改，猜错的后果由「测试」按钮兜住。
 */
export function suggestReasoningPreset(model: ReasoningModelHint): string {
  const levels = model.reasoningLevels ?? [];
  if (levels.length > 0) {
    return matchReasoningPreset(levels, model.reasoningMap ?? "{}");
  }

  const haystack = `${model.model} ${model.displayName ?? ""}`.toLowerCase();

  /*
   * 智谱 GLM：thinking 是对象。放前面是因为它的形态最特殊（写成布尔会直接 400），
   * 一旦漏判成布尔型后果最明显。
   */
  if (/\bglm-|zhipu|智谱/.test(haystack)) return "thinking-bool";
  // 通义千问：enable_thinking 布尔
  if (/\bqwen|qwq|通义/.test(haystack)) return "enable-thinking";
  /*
   * 按强度传参的一族：OpenAI o 系列、以及命名里直接带 reasoning/think/reasoner 的。
   * 这是最常见的约定，放在通用匹配的最后一段。
   * `o[1-9]` 不带尾边界，才能命中 o4-mini 这类带后缀的名字。
   */
  if (/\bo[1-9]|reasoning|reasoner|think/i.test(haystack)) {
    return "effort";
  }

  // 匹配不上：安全缺省。宁可只留个 UI 开关，也不要发上游不认的参数。
  return "toggle-only";
}
