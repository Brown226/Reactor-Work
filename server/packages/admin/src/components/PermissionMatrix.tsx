// Reactor 管理台 · 权限矩阵（复刻 scaffold-master 的只读可视化）
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/PermissionMatrix.vue
//   （Vue 3，菜单树 × 角色，可编辑授权 + 级联勾选 + 底部「未保存 N 项」浮条）
//
// 复刻取舍（为什么不是照搬）：
//   Reactor 的权限模型是**固定三角色 + 只读**——角色→权限的映射硬编码在
//   server/src/identity/permissions.ts 的 permissionAllowed()，没有「自由建角色 / 在线授权」接口。
//   所以只保留可迁移的部分：矩阵可视化、行列十字高亮、分组折叠；
//   去掉 draft/save/勾选/浮条（Reactor 没有对应写接口，做了也是假的）。
//
// 行组织：scaffold 用「菜单树」当行；Reactor 没有菜单权限实体，改用**权限码前缀**分组
//   （真实 code 形如 `admin:skills:*:read`，由服务端从路由表扫描生成，见
//   server/src/identity/permissions.ts 的 permissionCodeFor）。

import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { CaretRight, ShieldCheck } from "@phosphor-icons/react";
import { Empty } from "../ui";
import { ROLE_TEXT } from "./reactor";
import { ACTION_LABEL } from "../lib/permission-tree";
import type { Role } from "../types";
import type { PermissionPoint, RolePermissions } from "../services/permissions";

interface Leaf {
  code: string;
  action: string;
  description: string | null;
}
interface Group {
  key: string;
  label: string;
  leaves: Leaf[];
}

/** 按权限码前缀分组：`admin:skills:*:read` → 组 `admin:skills`，叶子 `read` */
function buildGroups(points: PermissionPoint[]): Group[] {
  const map = new Map<string, Leaf[]>();
  for (const point of points) {
    const segs = point.code.split(":");
    const action = segs[segs.length - 1] ?? "";
    // 组取前两段（area:resource），避免「一条路由一个组」把矩阵撑成上百行
    const key = segs.length > 2 ? segs.slice(0, 2).join(":") : point.code;
    const list = map.get(key) ?? [];
    list.push({ code: point.code, action, description: point.description });
    map.set(key, list);
  }
  return [...map.entries()]
    // 组标题优先用 description 里「·」前的中文区名（服务端已算好，如「技能 · 查看（…）」→「技能」），
    // 取不到才回退原始前缀——不在前端另建一张 area→中文 的映射表（会和后端口径漂移）。
    .map(([key, leaves]) => ({
      key,
      label: leaves[0]?.description?.split("·")[0]?.trim() || key,
      leaves: leaves.sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

type CellState = "on" | "off" | "partial";

export function PermissionMatrix({ points, roles }: { points: PermissionPoint[]; roles: RolePermissions[] }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ row: string | null; col: Role | null }>({ row: null, col: null });

  const roleSet = useMemo(() => new Map(roles.map((role) => [role.key, new Set(role.permissions)])), [roles]);
  const groups = useMemo(() => buildGroups(points), [points]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        leaves: group.leaves.filter(
          (leaf) => leaf.code.toLowerCase().includes(q) || (leaf.description ?? "").toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.leaves.length > 0);
  }, [groups, query]);

  const leafOn = (code: string, role: Role) => roleSet.get(role)?.has(code) ?? false;

  /** 组对某角色的聚合态：全有=on / 全无=off / 部分=partial */
  const groupState = (group: Group, role: Role): CellState => {
    const set = roleSet.get(role);
    if (!set) return "off";
    const on = group.leaves.filter((leaf) => set.has(leaf.code)).length;
    if (on === 0) return "off";
    return on === group.leaves.length ? "on" : "partial";
  };

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const totalVisible = filtered.reduce((sum, group) => sum + group.leaves.length, 0);
  const cellClass = (state: CellState, isHover: boolean) =>
    `mx-cell is-${state}${isHover ? " is-col-hover" : ""}`;

  if (points.length === 0) {
    return (
      <Empty
        icon={<ShieldCheck size={22} />}
        title="尚未生成权限点"
        desc="点击右上角「重新扫描权限点」从服务端路由表生成后再看矩阵"
      />
    );
  }

  return (
    <div className="mx-wrap">
      <div className="mx-bar">
        <span className="mx-hint">
          共 {filtered.length} 组 · {totalVisible} 个权限点 · 格子三态：✓ 全授权 / ▣ 部分 / 空 无权限
        </span>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="搜索权限码 / 说明"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="mx-scroll">
        <div
          className="mx-grid"
          style={{ "--mx-cols": roles.length } as CSSProperties}
          onPointerLeave={() => setHover({ row: null, col: null })}
        >
          <div className="mx-corner">权限 × 角色</div>
          {roles.map((role) => (
            <div
              key={role.key}
              className={`mx-role${hover.col === role.key ? " is-hover" : ""}`}
              onPointerEnter={() => setHover((h) => ({ ...h, col: role.key }))}
            >
              <span className="mx-role-name">{ROLE_TEXT[role.key]}</span>
              <span className="mx-role-meta num">{role.permissions.length} 项</span>
            </div>
          ))}

          {filtered.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const rowHovered = hover.row === group.key;
            return (
              <Fragment key={group.key}>
                <button
                  type="button"
                  className={`mx-label is-group${rowHovered ? " is-hover" : ""}`}
                  onClick={() => toggleCollapse(group.key)}
                  aria-expanded={!isCollapsed}
                >
                  <CaretRight size={13} className={`mx-caret${isCollapsed ? "" : " is-open"}`} />
                  <span className="mx-name ellipsis">{group.label}</span>
                  <span className="mx-count num">{group.leaves.length}</span>
                </button>
                {roles.map((role) => {
                  const state = groupState(group, role.key);
                  return (
                    <div
                      key={role.key}
                      className={cellClass(state, hover.col === role.key)}
                      title={`${ROLE_TEXT[role.key]} · ${group.label}`}
                      onPointerEnter={() => setHover({ row: group.key, col: role.key })}
                    >
                      <span className="mx-mark">{state === "on" ? "✓" : state === "partial" ? "▣" : ""}</span>
                    </div>
                  );
                })}

                {!isCollapsed &&
                  group.leaves.map((leaf) => {
                    const leafKey = `${group.key}::${leaf.code}`;
                    const rowHoveredLeaf = hover.row === leafKey;
                    return (
                      <Fragment key={leaf.code}>
                        <div
                          className={`mx-label is-leaf${rowHoveredLeaf ? " is-hover" : ""}`}
                          title={leaf.code}
                          onPointerEnter={() => setHover((h) => ({ ...h, row: leafKey }))}
                        >
                          <span className="mx-act">{ACTION_LABEL[leaf.action] ?? leaf.action}</span>
                          <span className="mx-code mono ellipsis">{leaf.code}</span>
                        </div>
                        {roles.map((role) => (
                          <div
                            key={role.key}
                            className={cellClass(leafOn(leaf.code, role.key) ? "on" : "off", hover.col === role.key)}
                            title={`${ROLE_TEXT[role.key]} · ${leaf.code}`}
                            onPointerEnter={() => setHover({ row: leafKey, col: role.key })}
                          >
                            <span className="mx-mark">{leafOn(leaf.code, role.key) ? "✓" : ""}</span>
                          </div>
                        ))}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
