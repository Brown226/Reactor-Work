// 管理台 · 授权范围选择器（技能与套件共用）
//
// 为什么要单独抽出来：技能与套件的授权模型**完全一致**（all/role/dept/user 四选一），
// 两页各写一份必然漂移 —— 改了角色文案或部门树渲染，另一页就悄悄不一致。
// 这里只负责"把 scope 画出来、把改动回传"，校验（空角色/空部门报错）仍留给调用方
// （因为报错文案要带业务词：「按角色下发需至少选一个角色」）。

import type { SkillScope, SkillScopeKind } from "../services/skills";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { Role } from "../types";

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: "平台管理员",
  dept_head: "部门负责人",
  user: "普通用户",
};

export const SCOPE_LABELS: Record<SkillScopeKind, string> = {
  all: "全公司",
  role: "按角色",
  dept: "按部门",
  user: "按账号",
};

/** 授权范围的可读文案（列表页展示用，与表单选项同一套词） */
export function scopeLabel(scope: SkillScope): string {
  if (scope.kind === "all") return "全公司";
  if (scope.kind === "role") return scope.roles.map((r) => ROLE_LABELS[r]).join("、") || "按角色（空）";
  if (scope.kind === "dept") return `${scope.deptIds.length} 个部门`;
  return scope.uids.join("、") || "按账号（空）";
}

export interface ScopePickerProps {
  value: SkillScope;
  onChange: (next: SkillScope) => void;
  /** 扁平化的部门列表（id + path） */
  depts: Array<{ id: number; path: string }>;
  /** 账号输入的原始字符串（受控：允许中途出现逗号/空格，提交前才切分） */
  uidsText: string;
  onUidsChange: (raw: string) => void;
}

export function ScopePicker(props: ScopePickerProps): React.ReactElement {
  const { value } = props;
  return (
    <>
      <div className="grid gap-1.5">
        <Label>授权范围</Label>
        <Select
          value={value.kind}
          onValueChange={(kind) => props.onChange({ ...value, kind: kind as SkillScopeKind })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SCOPE_LABELS) as SkillScopeKind[]).map((kind) => (
              <SelectItem key={kind} value={kind}>{SCOPE_LABELS[kind]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {value.kind === "role" ? (
        <div className="flex flex-wrap gap-4">
          {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
            <label key={role} className="flex items-center gap-2" style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={value.roles.includes(role)}
                onChange={(e) =>
                  props.onChange({
                    ...value,
                    roles: e.target.checked ? [...value.roles, role] : value.roles.filter((r) => r !== role),
                  })
                }
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      ) : null}

      {value.kind === "dept" ? (
        <div className="grid gap-1.5">
          <Label>选择部门</Label>
          <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}>
            {props.depts.length === 0 ? (
              <div className="cell-sub">暂无部门（先同步 AD 或建部门）</div>
            ) : (
              props.depts.map((dept) => (
                <label key={dept.id} className="flex items-center gap-2" style={{ fontSize: 12.5, padding: "2px 0" }}>
                  <input
                    type="checkbox"
                    checked={value.deptIds.includes(dept.id)}
                    onChange={(e) =>
                      props.onChange({
                        ...value,
                        deptIds: e.target.checked
                          ? [...value.deptIds, dept.id]
                          : value.deptIds.filter((id) => id !== dept.id),
                      })
                    }
                  />
                  {dept.path}
                </label>
              ))
            )}
          </div>
        </div>
      ) : null}

      {value.kind === "user" ? (
        <div className="grid gap-1.5">
          <Label htmlFor="scope-uids">账号（逗号或空格分隔）</Label>
          <Input
            id="scope-uids"
            value={props.uidsText}
            placeholder="zhangsan, lisi"
            onChange={(e) => props.onUidsChange(e.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}
