/**
 * [本地定制] Agents 集群的运行时 store —— DS-Bot 的 `state` / `chat` / 动作端点实现。
 *
 * 为什么不是「再写一套 bot 服务」：
 * - Agent 的身份与组织 = Reactor 的 VirtualProject（已有：名字、roots、置顶、软删除）
 * - 话题 = 该项目下的 task（已有：ZCodeTaskService，含持久化、恢复、流式）
 * - 人格字段（头像/底色/角色）在 localStorage（见 rosterSource），不属于 Host 事实
 *
 * 本文件只做**形状转换 + 事件桥**：把 Reactor 的项目树/任务/流式事件，
 * 翻译成 DS-Bot 视图认识的 roster / chat / feed 形状。它不持有一份独立的业务状态，
 * 因此不会和侧栏、会话列表产生分叉。
 */
import type { IProjectService } from "@/project-sidebar/contract.js";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import { buildRoster, savePersona, type DsBotRoster, type RosterTask } from "./rosterSource.js";

type FeedListener = (event: string, data: unknown) => void;

/** DS-Bot 的 chat 端点返回形状（见 vendor/ds-bot-client 的 chat 分页用法）。 */
export interface DsBotChatPage {
  sessionId: string;
  items: unknown[];
  cursor: string | null;
}

export interface BotStoreDeps {
  projectService: IProjectService;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 读该工作区下的全部会话（含组织字段）。 */
  listTasks(): Promise<RosterTask[]>;
  /** 新建一个空会话并返回 id（用于「新话题」）。 */
  createTask(input: { projectId: string; title?: string }): Promise<string>;
  /** 向某个会话发送一条用户消息。 */
  sendMessage(input: { taskId: string; text: string }): Promise<void>;
  /** 读取某个会话的消息流（已转成 DS-Bot 的 item 形状）。 */
  readChat(input: { taskId: string; cursor?: string }): Promise<DsBotChatPage>;
  /** 当前可用模型。 */
  listModels(): Promise<{ ref: string; label?: string }[]>;
  defaultModel(): string | null;
  /**
   * 群聊（DS-Bot 的 room）的宿主实现 = Reactor 的 TaskGroupService。
   * 一个 room 对应一个 TaskGroup；成员（每个 Bot 在该群的会话）是 group 下的 task。
   */
  taskGroupService: {
    /** Reactor 的 TaskGroupStructure：groups + members + order。 */
    read(): Promise<{
      groups: Array<{ id: string; title: string }>;
      members: Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number }>;
    }>;
    save(input: { id?: string; title?: string }): Promise<{ id: string; title: string }>;
    ungroup(id: string): Promise<void>;
    /** 把一个 task 登记进某个 group（群聊成员落库的唯一入口）。 */
    admit(input: {
      tasks: Array<{
        hostId: string;
        workspacePath: string;
        workspaceIdentity?: string;
        taskId: string;
      }>;
      placement?: {
        task: {
          hostId: string;
          workspacePath: string;
          workspaceIdentity?: string;
          taskId: string;
        };
        groupId: string | null;
        creationId: string;
      };
    }): Promise<void>;
  };
  /**
   * 模型供应商视图（DS-Bot 的 Models 设置页）。
   * Reactor 侧就是 providerSettingsService.getView()；这里抽成端口，
   * 是为了让 botStore 不直接依赖 services 的装配细节，便于测试替身。
   */
  listProviders(): Promise<
    Array<{
      providerId: string;
      providerName?: string;
      needsKey?: boolean;
      models: Array<{ modelId: string; label?: string }>;
    }>
  >;
}

const PREFS_KEY = "reactor-bot-prefs-v1";

/**
 * 每个会话已下发的最后一条消息 key（见 readChat 的增量语义）。
 * 只在 store 生命周期内有效：刷新后重新全量拉一次，不会丢历史。
 */
const chatCursors = new Map<string, string>();

/** 消息在 DS-Bot item 形状里的稳定 key：有 id 用 id，否则退回 时间+文本。 */
function itemKeyOf(item: { id?: string; time?: number; text?: string }): string {
  return item.id ? `id:${item.id}` : `t:${item.time ?? 0}:${item.text ?? ""}`;
}

function lastKeyOf(items: Array<{ id?: string; time?: number; text?: string }>): string {
  return items.length > 0 ? itemKeyOf(items[items.length - 1]!) : "";
}

/** seen 之后的所有条目（按 key 顺序，seen 为空则全量）。 */
function afterSeen<T extends { id?: string; time?: number; text?: string }>(
  items: T[],
  seen: string,
): T[] {
  if (!seen) return items;
  const index = items.findIndex((item) => itemKeyOf(item) === seen);
  return index === -1 ? items : items.slice(index + 1);
}

function readPrefs(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writePrefs(value: Record<string, unknown>): void {
  try {
    localStorage?.setItem(PREFS_KEY, JSON.stringify(value));
  } catch {
    /* 配额满：偏好退回默认。 */
  }
}

/**
 * 单个工作区的 Agents 集群 store。
 *
 * 生命周期由视图层持有（`useBotStore`），不是模块级单例：不同工作区各有自己的
 * 花名册，跨工作区共用一份会出现「A 项目的 Agent 出现在 B 项目侧栏」。
 */
export function createBotStore(deps: BotStoreDeps) {
  const listeners = new Set<FeedListener>();
  let cached: DsBotRoster | null = null;
  let inflight: Promise<DsBotRoster> | null = null;

  const emit = (event: string, data: unknown) => {
    for (const listener of listeners) listener(event, data);
  };

  async function loadRoster(): Promise<DsBotRoster> {
    const [tree, models, structure] = await Promise.all([
      deps.projectService.readTree(),
      deps.listModels().catch(() => [] as { ref: string; label?: string }[]),
      deps.taskGroupService
        .read()
        .catch(() => ({ groups: [], members: [] }) as Awaited<ReturnType<typeof deps.taskGroupService.read>>),
    ]);
    const roster = buildRoster({
      projects: tree.projects,
      tasks: tree.tasks,
      models,
      defaultModel: deps.defaultModel(),
      prefs: readPrefs(),
    });

    // 群聊：TaskGroup → DS-Bot 的 room。
    // 成员从 structure.members 取：每个成员在群里有一个 task，其 projectId 即成员 Bot。
    const projectIds = new Set(roster.bots.map((bot) => bot.id));
    const rooms = (structure.groups ?? []).map((group) => {
      const rows = (structure.members ?? [])
        .filter((row) => row.groupId === group.id)
        .slice()
        .sort((left, right) => left.sortOrder - right.sortOrder);
      const parts = rows.map((row) => row.taskId);
      const members = [
        ...new Set(
          tree.tasks
            .filter((task) => parts.includes(task.taskId) && task.projectId !== null)
            .map((task) => task.projectId as string)
            .filter((projectId) => projectIds.has(projectId)),
        ),
      ];
      return {
        id: group.id,
        name: group.title,
        sessionId: parts[0] ?? group.id,
        ownParts: [],
        parts,
        createdAt: Date.now(),
        members,
        named: true,
        notice: "",
        preview: "",
      };
    });
    const roomsById = Object.fromEntries(rooms.map((room) => [room.id, room]));
    return { ...roster, rooms, roomsById };
  }

  return {
    subscribe(listener: FeedListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** DS-Bot 的 `state` 端点。`since` / `models` / `locale` 参数上游用于增量，这里忽略。 */
    async readState(): Promise<DsBotRoster> {
      if (cached) return cached;
      if (inflight) return inflight;
      inflight = loadRoster()
        .then((roster) => {
          cached = roster;
          return roster;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },

    /** 丢掉缓存并通知视图重拉（新建/删除 Agent、会话标题变化等）。 */
    invalidate(reason = "revision") {
      cached = null;
      emit(reason, {});
      emit("hello", {});
    },

    /**
     * DS-Bot 的 `chat` 端点：一个话题的消息分页。
     *
     * 增量语义（关键）：Reactor 没有把 v4 流式传输接到这里，所以回复不会主动推过来。
     * 做法是「轮询补齐」——每个会话记住已下发的最后一条消息 id，之后每次调用只返回
     * 新增部分，并把它们以 `message` 事件广播出去。DS-Bot 的 chat.js 对 `message`
     * 的处理是「追加到当前列表」，正好匹配；`stream` 事件让活动行显示「正在回复」。
     *
     * cursor 为空 = 首屏（全量）；之后由调用方周期性重拉（见 start() 的轮询）。
     */
    async readChat(payload: { botId?: string; cursor?: string } | null): Promise<DsBotChatPage> {
      const taskId = payload?.botId;
      if (!taskId) return { sessionId: "", items: [], cursor: null };
      const page = await deps.readChat({ taskId, ...(payload?.cursor ? { cursor: payload.cursor } : {}) });
      const items = page.items ?? [];
      const seen = chatCursors.get(taskId);
      const firstScreen = payload?.cursor === undefined || payload.cursor === null || payload.cursor === "";

      if (firstScreen || seen === undefined) {
        // 首屏：全量下发，只记进度，不广播（避免把历史当成新消息刷未读）。
        if (items.length > 0) chatCursors.set(taskId, lastKeyOf(items));
        return { sessionId: taskId, items, cursor: null };
      }

      // 增量屏：从 seen 之后开始，逐条广播。
      const fresh = items.filter((item) => itemKeyOf(item) !== seen && afterSeen(items, seen));
      for (const item of fresh) {
        emit("message", { sessionId: taskId, item });
        // 助手回复进行中：给活动行一个「正在回复」的信号。Reactor 的消息是完成态
        // 快照，没有 phase，所以这里只在新增助手消息时发一次。
        if (item.kind === "bot") emit("stream", { sessionId: taskId, phase: "done", text: item.text });
      }
      if (fresh.length > 0) chatCursors.set(taskId, lastKeyOf(items));
      return { sessionId: taskId, items: fresh, cursor: null };
    },

    /** DS-Bot 的 `send` 端点。 */
    async send(payload: { botId?: string; text?: string } | null) {
      const taskId = payload?.botId;
      const text = payload?.text?.trim();
      if (!taskId || !text) return { ok: false };
      await deps.sendMessage({ taskId, text });
      // 立即回显用户消息（不等轮询）。给它一个稳定 key 并记进 cursor，
      // 这样随后的轮询拉到同一条时不会重复广播。
      const optimistic = { kind: "user" as const, text, time: Date.now(), id: `local-${Date.now()}` };
      chatCursors.set(taskId, itemKeyOf(optimistic));
      emit("message", { sessionId: taskId, item: optimistic });
      return { ok: true };
    },

    /** 新建 Agent = 新建虚拟项目（单 root，名字即角色名）。 */
    async createBot(payload: {
      name?: string;
      avatar?: string;
      color?: string;
      instructions?: string;
      role?: string;
    } | null) {
      const name = payload?.name?.trim();
      if (!name) throw Object.assign(new Error("Agent 名称不能为空"), { code: "bot/invalid" });
      const project = await deps.projectService.saveProject({
        name,
        roots: [deps.workspacePath],
        primaryRoot: deps.workspacePath,
      });
      savePersona(project.id, {
        ...(payload?.avatar ? { avatar: payload.avatar } : {}),
        ...(payload?.color ? { color: payload.color } : {}),
        ...(payload?.role ? { role: payload.role } : {}),
        ...(payload?.instructions ? { instructions: payload.instructions } : {}),
      });
      this.invalidate();
      return project;
    },

    /** 改 Agent：名字走项目，其余写人格缓存。 */
    async updateBot(payload: {
      botId?: string;
      patch?: {
        name?: string;
        avatar?: string;
        color?: string;
        role?: string;
        instructions?: string;
        pinned?: boolean;
      };
    } | null) {
      const botId = payload?.botId;
      const patch = payload?.patch ?? {};
      if (!botId) throw Object.assign(new Error("缺少 Agent id"), { code: "bot/invalid" });
      if (patch.name !== undefined || patch.pinned !== undefined) {
        await deps.projectService.saveProject({
          id: botId,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        });
      }
      const persona = {
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      };
      if (Object.keys(persona).length > 0) savePersona(botId, persona);
      this.invalidate();
      return { ok: true };
    },

    /** 删 Agent = 软删项目（任务与会话保留，可恢复；与 Reactor 侧栏行为一致）。 */
    async deleteBot(payload: { botId?: string } | null) {
      if (!payload?.botId) throw Object.assign(new Error("缺少 Agent id"), { code: "bot/invalid" });
      await deps.projectService.deleteProject(payload.botId);
      this.invalidate();
      return { ok: true };
    },

    /** 设定主 Agent（顶栏卡片）。当前只记偏好，不改变项目归属。 */
    async setMain(payload: { botId?: string } | null) {
      const prefs = { ...readPrefs(), mainBotId: payload?.botId ?? null };
      writePrefs(prefs);
      this.invalidate();
      return { ok: true };
    },

    async setPrefs(payload: { prefs?: Record<string, unknown> } | null) {
      writePrefs({ ...readPrefs(), ...payload?.prefs });
      this.invalidate();
      return readPrefs();
    },

    /**
     * 建群聊 = 建一个 TaskGroup，并把每个成员的会话挂进去。
     *
     * DS-Bot 的语义：admin 是群主，members 是其他 Bot，每人一个 hidden group session。
     * Reactor 的对应物：一个 TaskGroup + 每个成员一个 task（taskGroupService.admit）。
     * 第一版不做「管理员代答 / 顺序发言 / Goal」这些协作策略（那需要 Agent 间的
     * 调度运行时），但**群本身、成员、群内会话**是真实可用的。
     */
    async createRoom(payload: { members?: string[]; admin?: string; name?: string } | null) {
      const memberIds = payload?.members ?? [];
      const adminId = payload?.admin;
      if (memberIds.length < 2) {
        throw Object.assign(new Error("群聊至少需要两个 Agent"), { code: "bot/invalid" });
      }
      const group = await deps.taskGroupService.save({
        title: payload?.name?.trim() || memberIds.length + " 个 Agent 的群聊",
      });
      // 每个成员建一个空会话，作为它在群里的发言位。
      const sessions = [];
      for (const botId of memberIds) {
        const taskId = await deps.createTask({ projectId: botId });
        sessions.push({ botId, taskId });
        await deps.taskGroupService.admit({
          tasks: [
            {
              hostId: "local",
              workspacePath: deps.workspacePath,
              ...(deps.workspaceIdentity ? { workspaceIdentity: deps.workspaceIdentity } : {}),
              taskId,
            },
          ],
          placement: {
            task: {
              hostId: "local",
              workspacePath: deps.workspacePath,
              ...(deps.workspaceIdentity ? { workspaceIdentity: deps.workspaceIdentity } : {}),
              taskId,
            },
            groupId: group.id,
            creationId: `room-${group.id}`,
          },
        });
      }
      const byBot = Object.fromEntries(sessions.map((item) => [item.botId, item.taskId]));
      this.invalidate();
      return {
        id: group.id,
        name: group.title,
        sessionId: sessions[0]?.taskId ?? group.id,
        ownParts: [],
        parts: sessions.map((item) => item.taskId),
        createdAt: Date.now(),
        admin: adminId,
        members: memberIds,
        memberSessions: byBot,
        // `named` 表示用户是否显式命名（DS-Bot 据此决定是否自动跟随成员名）。
        named: Boolean(payload?.name?.trim()),
        notice: "",
        preview: "",
      };
    },

    /** 改名 / 置顶群：Reactor 的 TaskGroup 只有 title，其余字段忽略。 */
    async updateRoom(payload: { id?: string; patch?: { name?: string; pinned?: boolean } } | null) {
      const id = payload?.id;
      if (!id) throw Object.assign(new Error("缺少群 id"), { code: "bot/invalid" });
      const name = payload?.patch?.name;
      if (name === undefined) return { ok: true };
      await deps.taskGroupService.save({ id, title: name.trim() || id });
      this.invalidate();
      return { ok: true };
    },

    /** 解散群 = ungroup。Reactor 侧只解除组织关系，不删会话（与侧栏行为一致）。 */
    async deleteRoom(payload: { id?: string } | null) {
      const id = payload?.id;
      if (!id) throw Object.assign(new Error("缺少群 id"), { code: "bot/invalid" });
      await deps.taskGroupService.ungroup(id);
      this.invalidate();
      return { ok: true };
    },
    async saveSection() {
      throw Object.assign(new Error("Reactor 暂未支持侧栏分组"), { code: "bot/unsupported" });
    },
    async orderSections() {
      throw Object.assign(new Error("Reactor 暂未支持侧栏分组"), { code: "bot/unsupported" });
    },
    async deleteSection() {
      throw Object.assign(new Error("Reactor 暂未支持侧栏分组"), { code: "bot/unsupported" });
    },

    async models() {
      // DS-Bot 的 Models 页读的是 { models, defaultModel }，models 每项含
      // ref / label / needsKey / reasoning。Reactor 的 ModelSelectionView 提供
      // providerId + modelId，这里拼成 DS-Bot 的 ref 形态（`provider/model`）。
      const providers = await deps.listProviders();
      const models = providers.flatMap((provider) =>
        provider.models.map((model) => ({
          ref: `${provider.providerId}/${model.modelId}`,
          label: model.label ?? model.modelId,
          provider: provider.providerId,
          needsKey: provider.needsKey === true,
        })),
      );
      return { models, defaultModel: deps.defaultModel() };
    },

    async providers() {
      const providers = await deps.listProviders();
      return {
        providers: providers.map((provider) => ({
          id: provider.providerId,
          name: provider.providerName ?? provider.providerId,
          needsKey: provider.needsKey === true,
          models: provider.models.map((model) => ({
            id: model.modelId,
            name: model.label ?? model.modelId,
          })),
        })),
      };
    },

    async efforts() {
      // 思考强度由 Reactor 的模型选择器统一管理，Bot 视图不需要自己的档位表。
      return { efforts: [] };
    },

    /**
     * 工作区与文件夹。
     * DS-Bot 的 General 页用它显示「团队工作区」；Reactor 的对应物就是当前工作区，
     * 所以原样返回当前路径，不伪造多选。
     */
    async folders() {
      return { team: deps.workspacePath };
    },
    async folderList() {
      return { folders: [] };
    },
    async folderPick() {
      throw Object.assign(new Error("Reactor 请用侧栏的项目入口选择文件夹"), {
        code: "bot/unsupported",
      });
    },

    async runStats() {
      // 首版不聚合用量维度：Reactor 的用量统计在设置页，不按 Bot 拆分。
      return { sessionStats: {}, tokenUsage: {}, contextPressure: {} };
    },
    async usage() {
      return { byBot: [], byModel: [], byDay: [] };
    },

    async schedules() {
      // 定时任务：Reactor 的自动化中心在侧栏「自动化」入口，Bot 视图不重复一份。
      return { schedules: [] };
    },
    async scheduleCreate() {
      throw Object.assign(new Error("请在侧栏「自动化」里创建"), { code: "bot/unsupported" });
    },
    async scheduleDelete() {
      throw Object.assign(new Error("请在侧栏「自动化」里删除"), { code: "bot/unsupported" });
    },

    async diagnostics() {
      return { lines: [] };
    },
    async diagnosticsLog() {
      return { lines: [] };
    },
    async diagnosticsClear() {
      return { ok: true };
    },

    async repoStars() {
      return { stars: null };
    },
  };
}

export type BotStore = ReturnType<typeof createBotStore>;

/** 供 botBridge 使用的当前 store；由视图在挂载时登记。 */
let current: BotStore | null = null;

export const botStore = {
  register(store: BotStore | null) {
    current = store;
  },
  readState: () => requireStore().readState(),
  readChat: (payload: Parameters<BotStore["readChat"]>[0]) => requireStore().readChat(payload),
  send: (payload: Parameters<BotStore["send"]>[0]) => requireStore().send(payload),
  createBot: (payload: Parameters<BotStore["createBot"]>[0]) => requireStore().createBot(payload),
  updateBot: (payload: Parameters<BotStore["updateBot"]>[0]) => requireStore().updateBot(payload),
  deleteBot: (payload: Parameters<BotStore["deleteBot"]>[0]) => requireStore().deleteBot(payload),
  setMain: (payload: Parameters<BotStore["setMain"]>[0]) => requireStore().setMain(payload),
  setPrefs: (payload: Parameters<BotStore["setPrefs"]>[0]) => requireStore().setPrefs(payload),
  createRoom: () => requireStore().createRoom(),
  updateRoom: () => requireStore().updateRoom(),
  deleteRoom: () => requireStore().deleteRoom(),
  saveSection: () => requireStore().saveSection(),
  orderSections: () => requireStore().orderSections(),
  deleteSection: () => requireStore().deleteSection(),
  models: () => requireStore().models(),
  providers: () => requireStore().providers(),
  efforts: () => requireStore().efforts(),
  folders: () => requireStore().folders(),
  folderList: () => requireStore().folderList(),
  folderPick: () => requireStore().folderPick(),
  schedules: () => requireStore().schedules(),
  scheduleCreate: () => requireStore().scheduleCreate(),
  scheduleDelete: () => requireStore().scheduleDelete(),
  diagnostics: () => requireStore().diagnostics(),
  diagnosticsLog: () => requireStore().diagnosticsLog(),
  diagnosticsClear: () => requireStore().diagnosticsClear(),
  repoStars: () => requireStore().repoStars(),
  // 这两个端点上游带 payload（botId / 时间范围），Reactor 首版不区分维度，
  // 收下参数但不使用，避免 Parameters<无参方法> 退化成空元组。
  runStats: (_payload?: unknown) => requireStore().runStats(),
  usage: (_payload?: unknown) => requireStore().usage(),
  subscribe(listener: FeedListener) {
    return requireStore().subscribe(listener);
  },
};

function requireStore(): BotStore {
  if (!current) {
    throw Object.assign(new Error("Agents 集群尚未就绪"), { code: "bot/not-found" });
  }
  return current;
}

export type { DsBotRoster, ProjectTree };
