/**
 * M3 扩展状态快照契约（迁移清单 T3.1–T3.4 数据面）。
 *
 * 四个 pi 扩展都在工具结果的 `details` 里嵌入结构化状态快照，渲染层无需新增
 * sidecar RPC 即可采集：
 *  - @juicesharp/rpiv-todo        工具 `todo`（details = TaskDetails，每次全量 tasks）
 *  - pi-goal-x                    工具 `get_goal`/`create_goal`/`update_goal`（details = GoalStateEntry v3）
 *  - pi-background-tasks          工具 `bg_run`/`bg_run_pi_attested`/`bg_status`/`bg_logs`/`bg_kill`
 *                                 （details = { task | tasks: BgTaskSnapshot }）
 *  - pi-subagents                 工具 `subagent`（details = { mode, runId, results: SingleResult[] }）
 *
 * harvestExtWidgets 是纯函数：client 的 applyEventToSession 在 tool_execution_end
 * 上调用它做增量归并；字段全部防御性读取，坏/缺 details 不抛错。
 */

import type { UiMessage } from "./projector.js";

// ---------------------------------------------------------------------------
// rpiv-todo（源：tool/types.ts Task / TaskStatus）
// ---------------------------------------------------------------------------

export type ExtTodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface ExtTodoTask {
  id: number;
  subject: string;
  status: ExtTodoStatus;
  description?: string;
  activeForm?: string;
  blockedBy?: number[];
}

// ---------------------------------------------------------------------------
// pi-goal-x（源：extensions/goal-record.ts GoalRecord / goal-format.ts goalDetails）
// ---------------------------------------------------------------------------

export interface ExtGoalSnapshot {
  id?: string;
  objective?: string;
  status?: string;
  sisyphus?: boolean;
  pauseReason?: string;
  currentTaskId?: string;
  updatedAt?: string;
  usage?: { tokensUsed?: number; activeSeconds?: number };
}

// ---------------------------------------------------------------------------
// pi-background-tasks（源：core/common.ts TaskStatus / registry snapshot()）
// ---------------------------------------------------------------------------

export interface ExtBgTask {
  id: string;
  name?: string;
  command?: string;
  description?: string;
  status?: "running" | "completed" | "failed" | "killed" | string;
  outputPath?: string;
  startTime?: number;
  endTime?: number | null;
  exitCode?: number | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// pi-subagents（源：shared/types.ts Details / SingleResult）
// ---------------------------------------------------------------------------

export interface ExtSubagentResult {
  index?: number;
  agent?: string;
  task?: string;
  sessionName?: string;
  model?: string;
  exitCode?: number;
  error?: string;
  finalOutput?: string;
  timedOut?: boolean;
  interrupted?: boolean;
}

/** 一次 subagent 工具调用归并成的一条运行记录（按 runId/toolCallId 去重，后写覆盖） */
export interface ExtSubagentRun {
  id: string;
  mode?: string;
  isError: boolean;
  endedAt: number;
  results: ExtSubagentResult[];
}

// ---------------------------------------------------------------------------
// pi-plan-mode（T2.2；源：completion-tool.ts PlanModeCompletionDetails）
// ---------------------------------------------------------------------------

/** plan_mode_complete 工具结果快照：agent 提交计划后 terminate，等待用户决定 */
export interface ExtPlanSnapshot {
  plan: string;
  endedAt: number;
  /** 用户在计划审批面板上作出的决定（留痕；由 store.decidePlan 写入） */
  decision?: "approved" | "rejected";
}

// ---------------------------------------------------------------------------
// 会话级聚合
// ---------------------------------------------------------------------------

export interface ExtWidgets {
  todos: ExtTodoTask[];
  goal: ExtGoalSnapshot | null;
  bgTasks: ExtBgTask[];
  subagents: ExtSubagentRun[];
  plan: ExtPlanSnapshot | null;
}

export function emptyExtWidgets(): ExtWidgets {
  return { todos: [], goal: null, bgTasks: [], subagents: [], plan: null };
}

// ---------------------------------------------------------------------------
// 采集纯函数
// ---------------------------------------------------------------------------

const TODO_TOOLS = new Set(["todo"]);
const GOAL_TOOLS = new Set(["get_goal", "create_goal", "update_goal"]);
const BG_TOOLS = new Set(["bg_run", "bg_run_pi_attested", "bg_status", "bg_logs", "bg_kill"]);
const SUBAGENT_TOOLS = new Set(["subagent"]);
const PLAN_COMPLETE_TOOL = "plan_mode_complete";

/**
 * 从**已投影的消息序列**重建扩展面板状态（回放路径）。
 *
 * ## 为什么需要（真实缺口 2026-09-13）
 * `harvestExtWidgets` 原本只在实时 `tool_execution_end` 事件上被调用
 * （client 的 `applyEventToSession`）。于是下列场景里右侧「任务」面板必然是空的，
 * 哪怕会话文件里明明躺着 todo / 计划 / 目标 / 后台任务 / 子代理的结果
 * （`details` 已随工具块持久化 —— 见 `projector.attachToolResult`）：
 *   · **重开会话**（从磁盘回放）、重载应用、sidecar 回收/丢会话后由 UI 恢复；
 *   · 切分支（`navigateTree` 重灌该分支条目）。
 *
 * ## 为什么“顺序折叠”就是对的
 * 每个扩展返回的都是**全量/可合并快照**：todo 的 `details.tasks` 是任务全量、
 * bg/subagent 按 id upsert、goal/plan 是当前快照。因此按时间顺序折叠每个
 * toolCall 块上的 `result.details`，末态即该会话的最新状态。
 *
 * @param prev 现有 widget 状态；仅用于保留**用户动作**派生的字段（`plan.decision`）。
 */
export function harvestExtWidgetsFromMessages(
  messages: readonly UiMessage[],
  prev: ExtWidgets = emptyExtWidgets(),
): ExtWidgets {
  let widgets = emptyExtWidgets();
  for (const m of messages) {
    if (m.kind !== "assistant" || !m.blocks) continue;
    for (const b of m.blocks) {
      if (b.type !== "toolCall") continue;
      const details = b.result?.details;
      if (details === undefined) continue;
      widgets = harvestExtWidgets(widgets, {
        toolName: b.name,
        toolCallId: b.id,
        isError: b.result?.isError === true,
        details,
      });
    }
  }
  // plan.decision 来自用户点按（store.setPlanDecision），不是消息派生 —— 重算时保留
  const decision = prev.plan?.decision;
  if (decision !== undefined && widgets.plan) {
    widgets = { ...widgets, plan: { ...widgets.plan, decision } };
  }
  return widgets;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseTodoTask(raw: unknown): ExtTodoTask | undefined {
  const r = asRecord(raw);
  if (!r || typeof r.id !== "number" || typeof r.subject !== "string") return undefined;
  const status = r.status === "in_progress" || r.status === "completed" || r.status === "deleted" ? r.status : "pending";
  return {
    id: r.id,
    subject: r.subject,
    status,
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(typeof r.activeForm === "string" ? { activeForm: r.activeForm } : {}),
    ...(Array.isArray(r.blockedBy) ? { blockedBy: r.blockedBy.filter((n): n is number => typeof n === "number") } : {}),
  };
}

function parseGoal(raw: unknown): ExtGoalSnapshot | undefined {
  const r = asRecord(raw);
  if (!r) return undefined; // goal=null 也是合法快照（无目标），由调用方区分
  const usage = asRecord(r.usage);
  return {
    ...(typeof r.id === "string" ? { id: r.id } : {}),
    ...(typeof r.objective === "string" ? { objective: r.objective } : {}),
    ...(typeof r.status === "string" ? { status: r.status } : {}),
    ...(r.sisyphus === true ? { sisyphus: true } : {}),
    ...(typeof r.pauseReason === "string" ? { pauseReason: r.pauseReason } : {}),
    ...(typeof r.currentTaskId === "string" ? { currentTaskId: r.currentTaskId } : {}),
    ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
    ...(usage
      ? {
          usage: {
            ...(typeof usage.tokensUsed === "number" ? { tokensUsed: usage.tokensUsed } : {}),
            ...(typeof usage.activeSeconds === "number" ? { activeSeconds: usage.activeSeconds } : {}),
          },
        }
      : {}),
  };
}

function parseBgTask(raw: unknown): ExtBgTask | undefined {
  const r = asRecord(raw);
  if (!r || typeof r.id !== "string") return undefined;
  return {
    id: r.id,
    ...(typeof r.name === "string" ? { name: r.name } : {}),
    ...(typeof r.command === "string" ? { command: r.command } : {}),
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(typeof r.status === "string" ? { status: r.status } : {}),
    ...(typeof r.outputPath === "string" ? { outputPath: r.outputPath } : {}),
    ...(typeof r.startTime === "number" ? { startTime: r.startTime } : {}),
    ...(typeof r.endTime === "number" || r.endTime === null ? { endTime: r.endTime as number | null } : {}),
    ...(typeof r.exitCode === "number" || r.exitCode === null ? { exitCode: r.exitCode as number | null } : {}),
    ...(typeof r.error === "string" || r.error === null ? { error: r.error as string | null } : {}),
  };
}

function parseSubagentResult(raw: unknown): ExtSubagentResult | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  return {
    ...(typeof r.index === "number" ? { index: r.index } : {}),
    ...(typeof r.agent === "string" ? { agent: r.agent } : {}),
    ...(typeof r.task === "string" ? { task: r.task } : {}),
    ...(typeof r.sessionName === "string" ? { sessionName: r.sessionName } : {}),
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
    ...(typeof r.error === "string" ? { error: r.error } : {}),
    ...(typeof r.finalOutput === "string" ? { finalOutput: r.finalOutput } : {}),
    ...(r.timedOut === true ? { timedOut: true } : {}),
    ...(r.interrupted === true ? { interrupted: true } : {}),
  };
}

export interface ExtToolEventInput {
  toolName: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
}

/**
 * tool_execution_end 增量归并：返回新 ExtWidgets（无变化时原引用返回，
 * 便于调用方浅比较跳过 setState）。
 */
export function harvestExtWidgets(prev: ExtWidgets, ev: ExtToolEventInput): ExtWidgets {
  const toolName = ev.toolName;
  const details = asRecord(ev.details);
  if (!details) return prev;

  // rpiv-todo：details.tasks 是全量快照，直接替换
  if (TODO_TOOLS.has(toolName)) {
    const tasks = Array.isArray(details.tasks) ? details.tasks : undefined;
    if (!tasks) return prev;
    const todos = tasks.map(parseTodoTask).filter((t): t is ExtTodoTask => t !== undefined);
    return { ...prev, todos };
  }

  // pi-goal-x：details.goal = GoalRecord | null
  if (GOAL_TOOLS.has(toolName)) {
    if (!("goal" in details)) return prev;
    const goal = details.goal === null ? null : parseGoal(details.goal) ?? null;
    return { ...prev, goal };
  }

  // pi-background-tasks：details.task 单个 / details.tasks 批量，按 id upsert
  if (BG_TOOLS.has(toolName)) {
    const incoming = [...(asRecord(details.task) ? [details.task] : []), ...(Array.isArray(details.tasks) ? details.tasks : [])]
      .map(parseBgTask)
      .filter((t): t is ExtBgTask => t !== undefined);
    if (incoming.length === 0) return prev;
    const byId = new Map(prev.bgTasks.map((t) => [t.id, t]));
    for (const t of incoming) byId.set(t.id, { ...byId.get(t.id), ...t });
    return { ...prev, bgTasks: [...byId.values()] };
  }

  // pi-subagents：details.results 为本 run 的子代理结果集，按 runId/toolCallId upsert
  if (SUBAGENT_TOOLS.has(toolName)) {
    const results = Array.isArray(details.results) ? details.results : undefined;
    if (!results) return prev;
    const runId = typeof details.runId === "string" && details.runId ? details.runId : (ev.toolCallId ?? `run-${prev.subagents.length}`);
    const parsed = results.map(parseSubagentResult).filter((r): r is ExtSubagentResult => r !== undefined);
    if (parsed.length === 0) return prev;
    const run: ExtSubagentRun = {
      id: runId,
      ...(typeof details.mode === "string" ? { mode: details.mode } : {}),
      isError: ev.isError === true,
      endedAt: Date.now(),
      results: parsed,
    };
    const idx = prev.subagents.findIndex((r) => r.id === run.id);
    const subagents = idx >= 0 ? prev.subagents.map((r, i) => (i === idx ? run : r)) : [...prev.subagents, run];
    return { ...prev, subagents };
  }

  // pi-plan-mode：details = PlanModeCompletionDetails {version:1, source, plan}
  if (toolName === PLAN_COMPLETE_TOOL) {
    if (details.version !== 1 || details.source !== PLAN_COMPLETE_TOOL || typeof details.plan !== "string" || !details.plan.trim()) {
      return prev;
    }
    return { ...prev, plan: { plan: details.plan, endedAt: Date.now() } };
  }

  return prev;
}
