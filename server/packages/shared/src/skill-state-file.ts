/**
 * 技能启用状态文件契约（`<userData>/skills/.reactor-skills-state.json`）。
 *
 * ## 为什么需要这个文件（而不是走 RPC 参数）
 * 技能启停是**会话级**的内核过滤（不动磁盘文件），而 pi 的服务是在"会话创建 / reload"时
 * 组装的。若把有效集合当作 `new_session` 的参数传，就得新增 RPC 字段，并且"改了启停"还要
 * 重新创建会话来生效；改成一个**单写者文件**（主进程写、sidecar 读）后：
 *  - 不加任何 RPC 参数；
 *  - 现有 `reload` 即可让改动当个会话生效；
 *  - 主进程是唯一写者，不会出现两个上游各写一半。
 *
 * ## 形状
 * ```jsonc
 * { "version": 1, "generatedAt": "2026-09-13T…",
 *   "defaultAllow": ["a","b"],                       // 全局启用集合（空串工作区）
 *   "workspaces": { "e:/work/x": ["a"] },             // 该工作区**整体替换** defaultAllow
 *   "notes": { "a": { "disableModelInvocation": true } } }
 * ```
 * 解析/取值都必须是**容错**的：文件坏、字段缺、版本不认识 ⇒ 当作"没有约束"（`null`），
 * 宁可多给技能也不要把用户技能全灭掉。
 */

export interface SkillsStateFile {
  version: 1;
  generatedAt: string;
  /** 全局启用集合（未按工作区覆盖时使用） */
  defaultAllow: string[];
  /** 按工作区的**整体替换**集合（键由 normalizeWorkspaceKey 归一） */
  workspaces: Record<string, string[]>;
  /** 供斜杠面板/详情展示的每技能注记 */
  notes: Record<string, { disableModelInvocation: boolean }>;
}

export const SKILLS_STATE_FILE = ".reactor-skills-state.json";
export const SKILLS_STATE_VERSION = 1;

/** 该工作区的启用集合；文件不可用/无约束时返回 null（= 不过滤） */
export function resolveAllow(
  state: SkillsStateFile | null | undefined,
  workspaceKey: string,
): string[] | null {
  if (!state) return null;
  const key = workspaceKey.trim();
  if (key && Object.prototype.hasOwnProperty.call(state.workspaces, key)) {
    const list = state.workspaces[key];
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : null;
  }
  if (Array.isArray(state.defaultAllow)) {
    return state.defaultAllow.filter((n): n is string => typeof n === "string");
  }
  return null;
}

/** 容错解析（坏文件/旧版本 → null） */
export function parseSkillsStateFile(raw: unknown): SkillsStateFile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== SKILLS_STATE_VERSION) return null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.length > 0) : [];
  const workspaces: Record<string, string[]> = {};
  if (o.workspaces && typeof o.workspaces === "object") {
    for (const [k, v] of Object.entries(o.workspaces as Record<string, unknown>)) {
      if (typeof k === "string" && k.length > 0) workspaces[k] = strList(v);
    }
  }
  const notes: Record<string, { disableModelInvocation: boolean }> = {};
  if (o.notes && typeof o.notes === "object") {
    for (const [k, v] of Object.entries(o.notes as Record<string, unknown>)) {
      if (typeof k !== "string" || !v || typeof v !== "object") continue;
      notes[k] = { disableModelInvocation: (v as { disableModelInvocation?: unknown }).disableModelInvocation === true };
    }
  }
  return {
    version: SKILLS_STATE_VERSION,
    generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : new Date().toISOString(),
    defaultAllow: strList(o.defaultAllow),
    workspaces,
    notes,
  };
}
