/**
 * 技能/Agent 写操作回执的兜底归一化。
 *
 * 单独成文件：`reactorServerClient.ts` 受 `max-lines` 约束，这两段是纯函数、
 * 不依赖请求器，搬出来各自可读（语义与原先逐行一致）。
 */
import {
  normalizeServerSkillCatalogItem,
  type ServerAgentMutationResult,
  type ServerSkillInstallResult,
} from "@zcode/shared";

/** 技能写操作返回按 shared 契约兜底：缺 `affected` 时退回目标名；`skill` 缺失时留 null（由 re-GET 补）。 */
export function toSkillMutationResult(data: unknown, name: string): ServerSkillInstallResult {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const affected = Array.isArray(record.affected)
    ? record.affected.filter((entry): entry is string => typeof entry === "string")
    : [];
  const skill = normalizeServerSkillCatalogItem(record.skill);
  return {
    ok: true,
    affected: affected.length > 0 ? affected : [name],
    skill,
  };
}

/** 写操作返回按 shared 契约兜底：服务端保证 `{ok, affected[...]}`，缺项时退回目标名。 */
export function toAgentMutationResult(data: unknown, name: string): ServerAgentMutationResult {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const affected = Array.isArray(record.affected)
    ? record.affected.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ok: true,
    affected: affected.length > 0 ? affected : [name],
    ...(record.created !== undefined ? { created: record.created === true } : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled === true } : {}),
    ...(record.favorited !== undefined ? { favorited: record.favorited === true } : {}),
  };
}
