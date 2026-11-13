/**
 * [本地定制] Agents 集群的宿主数据层 —— DS-Bot 视图数据源，接 Reactor 的服务。
 *
 * 设计要点（为什么长这样）：
 *
 * 1. **单一事实源是 Reactor 的 ProjectService + ZCodeTaskService**，不是新表。
 *    Agent = 一个 VirtualProject（有名字、roots、置顶），话题 = 该项目下的一个 task。
 *    这样「创建 Agent」就是建项目，「和 Agent 对话」就是选中它名下的会话——
 *    全部复用已有能力，不引入第二份组织状态（AGENTS.md：避免重复状态与多条写入路径）。
 *
 * 2. **人格字段（头像 / 底色 / 角色名）放 localStorage**，因为它们目前不属于
 *    Host 事实，也不需要跨设备同步。等产品形态确认后再考虑升级成 Host 表。
 *
 * 3. **对外形状严格照抄 DS-Bot 的 `state` 端点**（`EMPTY_ROSTER` 的形状），
 *    这样 96 个视图文件一行都不用改。映射发生在本文件，视图只认 DS-Bot 的形状。
 */
import type { VirtualProject } from "@/project-sidebar/contract.js";

/** DS-Bot 的 roster 形状（见 vendor/ds-bot-client/sources.js 的 EMPTY_ROSTER）。 */
export interface DsBotRoster {
  revision: number;
  mainBotId: string | null;
  mainBotIds: string[];
  bots: DsBot[];
  rooms: DsBotRoom[];
  agents: unknown[];
  sections: unknown[];
  exchangeTurns: Record<string, unknown>;
  questions: Record<string, unknown>;
  btwCards: Record<string, unknown>;
  sideChats: Record<string, unknown>;
  learning: Record<string, unknown>;
  secrets: unknown[];
  capabilities: unknown[];
  capabilityStatuses: Record<string, unknown>;
  secretRequests: Record<string, unknown>;
  models: DsBotModel[];
  defaultModel: string | null;
  modelsKey: string | null;
  prefs: Record<string, unknown>;
  byId: Record<string, DsBot>;
  roomsById: Record<string, DsBotRoom>;
  agentsById: Record<string, unknown>;
  agentOf: Record<string, string>;
  ready: boolean;
}

/** DS-Bot 的 Bot 形状里视图真正会读的字段（其余按需补）。 */
export interface DsBot {
  id: string;
  name: string;
  role?: string;
  sessionId: string;
  parts: string[];
  createdAt: number;
  pinned?: boolean;
  hidden?: boolean;
  model?: string;
  /** 头像：emoji 或图片 URL，DS-Bot 的 mark.js 两种都认。 */
  avatar?: string;
  color?: string;
  instructions?: string;
}

export interface DsBotRoom {
  id: string;
  name: string;
  sessionId: string;
  ownParts: string[];
  parts: string[];
  createdAt: number;
  pinned?: boolean;
  hidden?: boolean;
  preview?: string;
}

export interface DsBotModel {
  ref: string;
  label?: string;
  needsKey?: boolean;
}

/** 本地的人格缓存：projectId → 头像/底色/角色名。 */
const PERSONA_KEY = "reactor-bot-persona-v1";

interface Persona {
  avatar?: string;
  color?: string;
  role?: string;
  instructions?: string;
}

function readPersonas(): Record<string, Persona> {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(PERSONA_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writePersonas(value: Record<string, Persona>): void {
  try {
    localStorage?.setItem(PERSONA_KEY, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私模式：人格退回默认，不影响会话本身。
  }
}

/** 未设人格时的默认头像：按 projectId 稳定取一个 emoji + 底色。 */
const DEFAULT_AVATARS = ["🧠", "📖", "⚙️", "📈", "🌐", "📊", "🎬", "🌱", "🎞️", "📐", "🛰️", "📜"];
const DEFAULT_COLORS = ["blue", "green", "amber", "violet", "rose", "slate", "cyan"];

function hashOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** ProjectTree.tasks 的元素形状（= ZCodeTaskMeta + 组织字段）。 */
export interface RosterTask {
  taskId: string;
  projectId: string | null;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
}

/**
 * 把 Reactor 的项目树 + 任务列表映射成 DS-Bot 的 roster。
 *
 * @param projects 该工作区的虚拟项目（= Agent 花名册）
 * @param tasks    该项目树下的任务（= 话题）
 */
export function buildRoster(params: {
  projects: VirtualProject[];
  tasks: RosterTask[];
  models: DsBotModel[];
  defaultModel: string | null;
  prefs: Record<string, unknown>;
}): DsBotRoster {
  const personas = readPersonas();
  const tasksByProject = new Map<string, RosterTask[]>();
  for (const task of params.tasks) {
    const projectId = task.projectId;
    if (!projectId) continue;
    const list = tasksByProject.get(projectId) ?? [];
    list.push(task);
    tasksByProject.set(projectId, list);
  }

  const bots: DsBot[] = params.projects
    .filter((project) => !project.deleted)
    .map((project) => {
      const persona = personas[project.id] ?? {};
      const bucket = hashOf(project.id);
      // DS-Bot 的 Bot id 同时是「第一段会话 id」；Reactor 里我们没有这条链，
      // 用项目 id 代替，视图只拿它做索引和选择，不发协议。
      const parts = (tasksByProject.get(project.id) ?? [])
        .slice()
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .map((task) => task.taskId);
      return {
        id: project.id,
        name: project.name,
        role: persona.role ?? "",
        sessionId: parts.at(-1) ?? project.id,
        parts,
        createdAt: project.createdAt,
        pinned: project.pinned,
        model: params.defaultModel ?? undefined,
        avatar: persona.avatar ?? DEFAULT_AVATARS[bucket % DEFAULT_AVATARS.length],
        color: persona.color ?? DEFAULT_COLORS[bucket % DEFAULT_COLORS.length],
        instructions: persona.instructions ?? "",
      };
    });

  const byId = Object.fromEntries(bots.map((bot) => [bot.id, bot]));

  return {
    revision: Date.now(),
    mainBotId: bots[0]?.id ?? null,
    mainBotIds: bots[0] ? [bots[0].id] : [],
    bots,
    rooms: [],
    agents: [],
    sections: [],
    exchangeTurns: {},
    questions: {},
    btwCards: {},
    sideChats: {},
    learning: {},
    secrets: [],
    capabilities: [],
    capabilityStatuses: {},
    secretRequests: {},
    models: params.models,
    defaultModel: params.defaultModel,
    modelsKey: params.models.map((model) => model.ref).join(","),
    prefs: params.prefs,
    byId,
    roomsById: {},
    agentsById: {},
    agentOf: {},
    ready: true,
  };
}

/** 读取人格缓存（供「编辑 Agent」表单回填）。 */
export function readPersona(projectId: string): Persona {
  return readPersonas()[projectId] ?? {};
}

/** 写回人格缓存（不改项目本身）。 */
export function savePersona(projectId: string, patch: Persona): void {
  const all = readPersonas();
  writePersonas({ ...all, [projectId]: { ...all[projectId], ...patch } });
}

export type { Persona };
