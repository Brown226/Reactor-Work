/**
 * GenUI 契约（D4 决策后实施，第一刀）—— **kind 目录与节点类型**。
 *
 * 设计来源：LeAgent `services/gen_ui/schema.py`（Apache-2.0）。
 * 但**刻意只取子集**（master-plan §8 红线：「只取前端有渲染分支的子集」）：
 * LeAgent 的 kind 枚举有 **70 项**，其中 3D/摄像头/任意 HTML 嵌入类在企业内控产品里
 * 等于自开沙箱与合规口子，交互表单类缺「动作回传」通道（用户点了没人接）。
 *
 * ## 本文件是**单一事实源**
 *
 * 「合法的 kind / 每种 kind 允许哪些 prop / 是否可带 children」只在这里定义一次，
 * 三处消费：
 *  1. `normalizeUiTree`（把模型发来的扁平 prop 归位）；
 *  2. `emit_ui_tree` 工具（生成给模型的写法说明 —— 目录即文档，不会与校验漂移）；
 *  3. 前端渲染器（按 kind 分派，未登记即不可能出现）。
 *
 * ⚠️ **已登记 = 渲染得出来**。这是本层最硬的一条不变式：不接受「先登记、渲染待补」
 * ——那会让模型发出一个用户看到空白的东西。补新 kind 必须同时补渲染分支与探针。
 */

// ---------------------------------------------------------------------------
// 规模上限（我们的取值，LeAgent 在调用点传入）
// ---------------------------------------------------------------------------

export const GENUI_LIMITS = {
  /** 树最大深度（含 root 为第 1 层） */
  maxDepth: 12,
  /** 节点总数上限 */
  maxNodes: 400,
  /** 单个文本/代码字段字符上限（防一次塞进整本书） */
  maxTextChars: 20_000,
} as const;

/** 协议版本（照 LeAgent `schemaVersion:"1"`） */
export const GENUI_SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// kind 目录
// ---------------------------------------------------------------------------

/** 子节点约束 */
export type GenUiChildrenRule =
  /** 不允许子节点（叶子） */
  | "none"
  /** 任意个 */
  | "many";

export interface GenUiKindSpec {
  /** 允许的 prop 名（`normalizeUiTree` 只把**这里列出**的扁平键搬进 `props`） */
  readonly props: readonly string[];
  readonly children: GenUiChildrenRule;
  /** 一句话说明（会进工具描述，供模型照写） */
  readonly description: string;
}

/**
 * 已登记的 kind —— **第一刀 11 个 + 第二刀 16 个 = 27 个**。
 *
 * 第一刀（端到端打通）选的是：布局骨架 + 复用既有渲染器（`Markdown`/`CodeBlock`）
 * + 最小数据展示（`Stat`）+ 最常见强调块（`Callout`）。
 * 第二刀补上「可用的办公面板」与「产物形态」：分区与滚动、指标族、表格（接 W3 引擎）、
 * 卡片/告警、以及 `HtmlFrame`（见下）。
 *
 * ## `HtmlFrame` 为何**保留**（原红线曾判不做）
 *
 * 用户明确需要「任意 HTML」（自绘图表、交互 demo）。经**真窗口实测**后保留，并配沙箱约束：
 *  - `sandbox="allow-scripts"`（**不给** `allow-same-origin`）→ 唯一不透明源：
 *    实测父级 `contentDocument === null`（读不到子内容），而子级能正常渲染与执行脚本；
 *    加 `allow-same-origin` 或去掉 sandbox 后父级即可读取 —— 反证隔离正由该属性提供。
 *  - 因此它**不能**碰父级 DOM / localStorage / cookie，也无法把内容读回宿主。
 *
 * ⚠️ **实测到的功能边界（模型与用户都该知道）**：`srcdoc` 帧**继承父级 CSP**
 * （`default-src 'self'`），因此**外链图片与 CDN 脚本会被拦下**，只能用内联
 * HTML/CSS/JS 与 `data:` 资源。即：**离线可用的任意 HTML**。
 * 若将来要用 CDN 图表库，需要放宽 CSP —— 那是**安全决策**，不在此处偷偷做。
 */
export const GENUI_KINDS = {
  // —— 布局 ——
  Stack: {
    props: ["gap", "align", "justify", "padding"],
    children: "many",
    description: "竖排容器（默认布局）：子节点自上而下",
  },
  Grid: {
    props: ["columns", "gap", "minChildWidth"],
    children: "many",
    description: "网格容器：columns 为 1–6 列",
  },
  Row: {
    props: ["gap", "align", "justify", "padding"],
    children: "many",
    description: "横排容器：子节点自左向右",
  },
  Spacer: {
    props: ["size"],
    children: "none",
    description: "竖向留白：size 为像素数",
  },
  Divider: {
    props: [],
    children: "none",
    description: "分隔线",
  },
  // —— 排版 ——
  Heading: {
    props: ["value", "level"],
    children: "none",
    description: "标题：value 为文本、level 为 1–6（缺省 2）",
  },
  Text: {
    props: ["value", "size", "tone"],
    children: "none",
    description: "正文段落：tone 可为 default|muted|strong",
  },
  // —— 复用既有渲染器 ——
  Markdown: {
    props: ["content"],
    children: "none",
    description: "Markdown 富文本（支持 GFM 表格/任务列表与 KaTeX 公式）",
  },
  CodeBlock: {
    props: ["code", "language"],
    children: "none",
    description: "代码块：code 为源码、language 为高亮语言（缺省 text）",
  },
  // —— 数据展示 ——
  Stat: {
    props: ["label", "value", "unit", "delta", "trend", "hint"],
    children: "none",
    description: "单个指标：label 名称、value 数值（字符串）、可选 unit/delta/trend(up|down|flat)",
  },
  // —— 提示 ——
  Callout: {
    props: ["variant", "title", "message"],
    children: "none",
    description: "强调块：variant 为 info|note|tip|success|warning|danger",
  },

  // ===================== 第二刀（16 个） =====================
  // —— 分区与滚动 ——
  ScrollArea: {
    props: ["maxHeight", "padding"],
    children: "many",
    description: "可滚动区域：maxHeight 为像素上限，超出滚动而不是撑长页面",
  },
  Tabs: {
    props: ["defaultTab"],
    children: "many",
    description: "标签页容器：子节点必须是 TabItem；defaultTab 为默认选中的标签名",
  },
  TabItem: {
    props: ["label"],
    children: "many",
    description: "标签页的一项：label 为标签名（只在 Tabs 内使用）",
  },
  SectionHeader: {
    props: ["value", "hint"],
    children: "none",
    description: "分区标题：value 为主标题、hint 为右侧浅色补充",
  },
  // —— 数据展示 ——
  KeyValueList: {
    props: ["items", "columns"],
    children: "none",
    description: "键值清单：items 为 [{key, value}] 数组（如元信息、字段一览）",
  },
  MetricCard: {
    props: ["label", "value", "unit", "delta", "trend", "hint"],
    children: "none",
    description: "指标卡片：带卡片外壳的单个指标（props 同 Stat），适合并排展示",
  },
  KpiBoard: {
    props: ["items", "columns"],
    children: "none",
    description: "KPI 看板：items 为 [{label, value, unit, delta, trend}] 数组，自动排成网格",
  },
  Progress: {
    props: ["value", "max", "label"],
    children: "none",
    description: "进度条：value/max（缺省 max=100），可选 label",
  },
  Badge: {
    props: ["value", "tone"],
    children: "none",
    description: "徽标：value 为短文本，tone 为 neutral|info|success|warning|danger",
  },
  Tag: {
    props: ["label", "tone"],
    children: "none",
    description: "标签：label 为短文本（props 同 Badge）",
  },
  // —— 表格（接 W3 共享表格引擎） ——
  Table: {
    props: ["header", "rows", "caption", "align"],
    children: "many",
    description:
      "表格：header 为表头字符串数组、rows 为二维数组——数字会自动千分位、涨跌列自动染涨跌色、合计行自动加粗（由共享表格引擎决定）；也接受 children 形式的 TableRow/TableCell（会被归一上提）",
  },
  TableRow: {
    props: [],
    children: "many",
    description: "表格行（只在 Table 的 children 形态里使用，会被归一上提为 rows）",
  },
  TableCell: {
    props: ["value"],
    children: "none",
    description: "单元格（只在 Table 的 children 形态里使用）",
  },
  // —— 卡片与告警 ——
  Card: {
    props: ["title", "subtitle"],
    children: "many",
    description: "卡片容器：title/subtitle 为可选标题，children 为卡片内容",
  },
  Alert: {
    props: ["variant", "title", "message"],
    children: "none",
    description: "告警条：variant 为 info|success|warning|danger（比 Callout 更醒目、常用于结论）",
  },
  // ===================== 第三刀（产物与导出） =====================
  SlideDeck: {
    props: ["title", "aspect"],
    children: "many",
    description: "幻灯片组：子节点必须是 Slide；导出 pptx/文档时按页切分",
  },
  Slide: {
    props: ["title", "layout"],
    children: "many",
    description: "一页幻灯片：title 为页标题，layout 为 cover|title-content|two-column（缺省 title-content）",
  },
  ImageGallery: {
    props: ["items", "columns"],
    children: "none",
    description: "图片画廊：items 为 [{src, alt, caption}] 数组（src 用 data: 或同源路径——外链图片会被安全策略拦下）",
  },
  FeatureGrid: {
    props: ["items", "columns"],
    children: "none",
    description: "特性/要点网格：items 为 [{title, description}] 数组",
  },
  // —— 任意 HTML（沙箱内，见上方说明） ——
  HtmlFrame: {
    props: ["html", "height", "title"],
    children: "none",
    description:
      "内嵌一段 HTML（在沙箱 iframe 中渲染）：可用内联 HTML/CSS/JS 与 data: 资源（自绘图表、交互 demo）。⚠️ 外链图片与 CDN 脚本会被内容安全策略拦下，只能离线自包含；height 为像素高度（缺省 240）",
  },
} as const satisfies Record<string, GenUiKindSpec>;

/** 已登记的 kind（**唯一合法集合**） */
export type GenUiKind = keyof typeof GENUI_KINDS;

/** 全部已登记 kind 名（顺序即目录顺序，供文档与分派使用） */
export const GENUI_KIND_NAMES = Object.keys(GENUI_KINDS) as readonly GenUiKind[];

/**
 * **已批准的目标集合**（26 个，见 D4 决策）：第一刀 11 个之后要补的 15 个。
 *
 * 单独列出来的用途：① 让「红线」可核对（只有这 26 个在计划内）；
 * ② 防止有人「顺手」把 3D/摄像头/任意 HTML 嵌入加进来（它们**不在**本表里）。
 */
export const GENUI_TARGET_KINDS_NOT_YET: readonly string[] = [];
// 三刀全部落地：11（第一刀）+ 16（第二刀）+ 4（第三刀）= **31 个 kind**。
// 注：D4 原写「限 26」，实际为 31 —— 差异来自 ① 用户要求保留 `HtmlFrame`（+1）
// ② `Table` 家族按「输入形态」计了 `TableRow`/`TableCell` 两个（+2）
// ③ 第三刀 4 个。详见 docs/参考项目调研/来源分配-唯一台账.md 的变更记录。

/** 明确**不做**的 kind 及其理由（红线可核对；不要「顺手」加） */
export const GENUI_EXCLUDED_KINDS: Readonly<Record<string, string>> = {
  // —— 一、3D / 摄像头 / 任意 HTML 嵌入：无场景 + 企业内控下的沙箱与合规风险 ——
  Model3D: "3D 模型渲染：Reactor 无此场景，且需引入 3D 运行时（体积大）",
  LiveCamera: "调用摄像头：无场景，且采集设备画面属隐私面，内网产品不应默认持有",
  ThreeJsFrame: "内嵌 3D 画布：无场景，且等于在产物里开一个可执行渲染面",
  HostedCanvasFrame: "托管画布嵌入：等于允许产物加载远端可执行内容，内控下不可接受",
  // ⚠️ `HtmlFrame` 曾在此列（「任意 HTML 嵌入」）—— 用户明确需要，已**移出并实现**：
  //    配 `sandbox="allow-scripts"`（不给 allow-same-origin），真窗口实测隔离有效；
  //    且 srcdoc 继承父级 CSP → 外链资源被拦，等价于「离线自包含的任意 HTML」。
  Video: "视频播放：与办公产物无关，且带来外部资源加载与编码面",
  // —— 二、交互表单：缺「动作回传」通道（用户点了没人接） ——
  Form: "表单容器：缺动作回传通道，提交后无人接收，等于假交互",
  Input: "单行输入：缺动作回传通道，用户输入无法回到 Agent",
  Textarea: "多行输入：缺动作回传通道（同上）",
  NumberInput: "数字输入：缺动作回传通道（同上）",
  Select: "下拉选择：缺动作回传通道（同上）",
  Switch: "开关：缺动作回传通道（同上）",
  Slider: "滑块：缺动作回传通道（同上）",
  FileInput: "文件选择：缺动作回传通道，且涉及本地文件读取边界",
  Chip: "可交互标签：缺动作回传通道",
  ChipGroup: "标签组：缺动作回传通道",
  Button: "按钮：缺动作回传通道，点了没有任何效果",
  InteractiveButton: "交互按钮：缺动作回传通道（同上）",
  ToggleButton: "切换按钮：缺动作回传通道（同上）",
  LinkButton: "外链按钮：需 URL 白名单与点击沙箱策略，另立决策后再做",
  // —— 三、LeAgent 自身的开发期工具 ——
  DesignSurface: "LeAgent 的设计期画布工具，非终端用户产物形态",
  JsonDebug: "LeAgent 的调试用 JSON 展示，不应出现在用户产物里",
  // —— 四、其特定业务 ——
  WeatherCard: "天气卡片：LeAgent 的特定业务卡片，Reactor 无对应数据源",
  // —— 五、卡片变体：Card 足以表达，避免维护负担 ——
  ProfileCard: "人物卡片变体：Card + 内容块即可表达，避免每变体一条渲染/导出/探针",
  MediaCard: "媒体卡片变体：Card + Image/Markdown 即可表达",
  AlertCard: "告警卡片变体：Alert（第二刀）已覆盖语义",
  TimelineCard: "时间线卡片：LeAgent 特定业务形态，Card + 列表即可表达",
  QuoteCard: "引用卡片变体：Callout 已覆盖语义",
  DataCard: "数据卡片变体：Stat/MetricCard（第二刀）已覆盖语义",
  // —— 六、需新增依赖或首期收益不足 ——
  Chart: "图表：client 当前无图表库，新增依赖需过体积与内网审计；首期先用 Image/Markdown 表达",
  Accordion: "折叠面板：纯 CSS 可后补，首期收益不足",
  AccordionItem: "折叠项：随 Accordion 一起后补",
  Avatar: "头像：无用户头像数据源，先不做",
  AspectBox: "等比容器：纯 CSS 可后补",
  Skeleton: "占位骨架：面板是即时渲染的，用不到流式骨架",
  Stepper: "步骤条：LeAgent 特定流程形态，首期收益不足",
  Icon: "图标：lucide 可用，但图标集需先定白名单（否则任意图标名渲染成空白）",
};

// ---------------------------------------------------------------------------
// 节点与树
// ---------------------------------------------------------------------------

/** 一个 UI 节点（规范化**之后**的形态：一定有 `nodeId` 与 `kind`） */
export interface GenUiNode {
  readonly nodeId: string;
  readonly kind: GenUiKind;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly GenUiNode[];
}

/** 一棵 UI 树（规范化后的信封形态） */
export interface GenUiTree {
  readonly schemaVersion: string;
  readonly root: GenUiNode;
}

/** 归一的结论（供工具/日志诊断：模型哪里写歪了、我们怎么修的） */
export interface NormalizeReport {
  /** 把 `{kind,...}` 裸根包成 `{schemaVersion, root}` */
  readonly wrappedBareRoot: boolean;
  /** 补了 `schemaVersion` */
  readonly filledSchemaVersion: boolean;
  /** `type` → `kind` 次数（模型爱用 React 风格） */
  readonly coercedTypeToKind: number;
  /** 把节点级扁平键搬进 `props` 的次数 */
  readonly liftedFlatProps: number;
  /** 数值 token（`md`/`12px`）转数字次数 */
  readonly coercedNumberTokens: number;
  /** prop 别名归一（`text`→`value` 等）次数 */
  readonly renamedProps: number;
  /** 自动补 nodeId 次数 */
  readonly generatedNodeIds: number;
  /** 被规整为数组的 children 次数（模型给了单个对象） */
  readonly coercedChildren: number;
  /** 未知 kind 被丢弃的节点数（连子树一起丢） */
  readonly droppedUnknownKind: number;
  /**
   * 目录里**未登记**的 prop 名（形如 `Stat.totallyBogus`）。
   *
   * 这些键**不会被丢掉**（留在 `props` 里交给渲染端忽略），但**必须被记录** ——
   * 否则就是「静默吞掉模型的错误」。LeAgent 的原话是「不静默吸收任意垃圾」。
   */
  readonly unknownProps: readonly string[];
  /** 因深度上限被截断而丢弃的节点数 */
  readonly truncatedByDepth: number;
  /**
   * 说明性备注 —— **只放「模型该知道的事」**，与上面的计数分工明确：
   *
   *  - **计数**（`coercedNumberTokens` / `generatedNodeIds` / `liftedFlatProps` / `renamedProps`…）
   *    是**良性容错**：`gap:"md"→12`、补 nodeId、平铺 prop 归位。我们照做即可，不必回报 ——
   *    每条都写进回执会把回执变成噪声（模型每轮都被无关修正信息挤占注意力）。
   *  - **notes** 只放**改变了含义或丢了内容**的事：丢弃未登记 kind、深度/节点截断、
   *    文本截断、未登记 prop。这些模型**必须知道**，否则会以为自己的产物完整生效了。
   *
   * 划这条线的理由：回执是给模型的**反馈通道**，噪声化的反馈等于没有反馈。
   */
  readonly notes: readonly string[];
}

export interface NormalizeResult {
  readonly tree: GenUiTree;
  readonly report: NormalizeReport;
}
