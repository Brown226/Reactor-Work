// Reactor 管理台 · 组织画布（复刻 scaffold-master 的 OrgCanvas 可视化）
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/OrgCanvas.vue
//   （Vue 3 + GSAP：整齐树布局、贝塞尔连线、拖拽平移、Ctrl+滚轮缩放、
//    单击选中 / 双击居中 / 方向键导航、选中路径脉冲、GSAP 分层入场）
//
// 复刻取舍（为什么不是照搬）：
//   1. GSAP → CSS。B1 已定调「不引入额外运行时依赖」；入场用 CSS animation
//      （按 depth 延迟），选中路径用流动虚线（stroke-dashoffset 动画），
//      都是零 JS 的标准技巧，效果等价。
//   2. 数据降维：scaffold 的 Dept 有 {leader, memberCount, status}；Reactor 的
//      DeptNode 只有 {id,name,path,children}。leader 由调用方用 dept_head 反查
//      传入（buildLeaderMap），memberCount 用 subtreeMemberCount 现算，
//      status 无来源 —— 直接省略，不造假数据。
//   3. 布局算法原样复刻（整齐树 + 父居中于子树），抽在 lib/org-layout.ts。
//
// 交互口径（与 Vue 版一致）：
//   - 拖拽空白处平移；Ctrl/⌘+滚轮以指针为中心缩放；普通滚轮平移
//   - 单击节点 = 选中（联动页面 URL ?dept=）；双击 / Enter = 聚焦居中
//   - 方向键在选中节点间移动（上=上级 下=第一个下级 左右=同级相邻）
//   - 节点右下角 −/N = 收起/展开下级
//
// 与 Vue 版的一处有意差异：折叠/展开后**不重新 fit**。Vue 版 watch 节点数变化
// 就重新适应画布，用户手动缩放/平移过的视角会被反复打乱；这里只在视口尺寸
// 变化（ResizeObserver）和树数据首次到达时 fit。
//
// B4（2026-10-19）：右上浮层由「标题 + 两行读数」升级为 scaffold 的 InsightPanel 分析栏
//   （classification → 主读数 + 迷你柱 → 4 个读数块 → 洞察卡 → 下级/同级芯片下钻）。
//   芯片点击走 `focusNode` 聚焦（**有意不触发重新 fit**，否则会把视角打回全图）；
//   关闭分析栏只收起侧栏，不改变选中态。数据装配在 lib/dept-insight.ts。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsOut, Buildings, Graph, List, Minus, Plus } from "@phosphor-icons/react";
import { Button } from "./ui/button";
import { Empty, SkeletonRows } from "../ui";
import { subtreeMemberCount } from "./DeptTree";
import { InsightPanel } from "./InsightPanel";
import { buildDeptInsight, findDeptNode } from "../lib/dept-insight";
import { layoutOrgTree, NODE_H, NODE_W, type LaidNode } from "../lib/org-layout";
import type { DeptNode } from "../types";

const K_MIN = 0.2;
const K_MAX = 2.5;

/** 视图变换：null = 尚未 fit（此时不渲染 layer，避免首帧从左上角飞入） */
interface View {
  x: number;
  y: number;
  k: number;
}

export interface OrgCanvasProps {
  /** null = 还在加载（渲染骨架），而不是「没有部门」 */
  tree: DeptNode[] | null;
  /** 部门 id → 直接归属人数（DeptTree 的徽标同源） */
  members: Map<number, number>;
  /** 部门 id → 负责人姓名列表（buildLeaderMap 产出，可缺省） */
  leaders?: Map<number, string[]>;
  /** 当前选中节点（OrgUsers 页从 URL ?dept= 还原的整节点） */
  selected: DeptNode | null;
  onSelect: (node: DeptNode) => void;
  /** 退出画布视图（浮层面板的「返回组织列表」） */
  onExit: () => void;
}

export function OrgCanvas({ tree, members, leaders, selected, onSelect, onExit }: OrgCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ id: number; lx: number; ly: number } | null>(null);

  /* 分析栏开合：默认展开（选中部门后立刻能看到它的结论）；关闭只收起侧栏，不动选中态 */
  const [insightOpen, setInsightOpen] = useState(true);

  const layout = useMemo(() => (tree ? layoutOrgTree(tree, collapsed) : null), [tree, collapsed]);

  const insight = useMemo(
    () => (selected && tree ? buildDeptInsight(selected, tree, members, leaders) : null),
    [selected, tree, members, leaders],
  );

  /* ── 选中路径：根 → 选中节点的连线全部点亮（link 以子节点 id 标识） ── */
  const activeLinkIds = useMemo(() => {
    const ids = new Set<number>();
    if (!selected || !layout) return ids;
    const parentOf = new Map(layout.nodes.map((n) => [n.dept.id, n.parentId]));
    let cur: number | null | undefined = selected.id;
    while (cur != null) {
      const parent = parentOf.get(cur);
      if (parent == null) break;
      ids.add(cur);
      cur = parent;
    }
    return ids;
  }, [layout, selected]);

  /* ── fit：整个布局缩放到视口内并水平居中 ── */
  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !layout || !layout.width || !el.clientWidth) return;
    const pad = 96;
    const k = Math.min(1.2, Math.max(0.35, Math.min((el.clientWidth - pad * 2) / layout.width, (el.clientHeight - pad * 2.4) / layout.height)));
    setView({ k, x: (el.clientWidth - layout.width * k) / 2, y: Math.max(pad, (el.clientHeight - layout.height * k) / 2) });
  }, [layout]);

  // fit 闭包依赖 layout，而效果触发点（tree 到达 / RO）不依赖 —— 用 ref 拿最新版
  const fitRef = useRef(fit);
  fitRef.current = fit;

  // 树数据首次到达时 fit（之后折叠/展开不动视角，见文件头）
  useEffect(() => {
    fitRef.current();
  }, [tree]);

  /* 视口尺寸变化（窗口缩放、侧栏收起）时重新适应。
     **必须做尺寸去重**：首屏布局要经过几轮微调（字体加载、入场动画、侧栏展开），
     RO 会对每一轮都回调；无脑 fit 会把用户已经缩放/平移好的视角反复打回初始态。
     只有宽高真实变化（≥2px，容忍亚像素抖动）才重新适应。 */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastW = -1;
    let lastH = -1;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (Math.abs(w - lastW) < 2 && Math.abs(h - lastH) < 2) return;
      lastW = w;
      lastH = h;
      fitRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── 滚轮：Ctrl/⌘ = 以指针为中心缩放；普通 = 平移 ──
     React 的 onWheel 在 root 上以 passive 监听，preventDefault 无效，
     必须手动挂原生 listener（{ passive: false }）——否则页面会跟着滚。 */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        if (!v) return v;
        if (e.ctrlKey || e.metaKey) {
          const rect = el.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          const k = Math.min(K_MAX, Math.max(K_MIN, v.k * Math.exp(-e.deltaY * 0.0015)));
          // 以指针为中心：指针下的布局点在缩放前后保持同一屏幕位置
          return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* ── 拖拽平移（节点 / 浮层控件上不启动） ──
     排除区域必须包含 .oc-controls 与 .oc-panel：pointerdown 一旦在容器上
     setPointerCapture，后续 click 的目标会被重定向到容器，浮动按钮的
     onClick 全部收不到（scaffold 原版的 exclude 参数同理，三类都要排）。
     B4 起右上角是分析栏（.ip-panel）——它内部有芯片/关闭/返回按钮，同样必须排除。 */
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".oc-node, .oc-controls, .oc-panel, .ip-panel")) return;
    dragRef.current = { id: e.pointerId, lx: e.clientX, ly: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.lx;
    const dy = e.clientY - d.ly;
    d.lx = e.clientX;
    d.ly = e.clientY;
    if (dx || dy) setView((v) => (v ? { ...v, x: v.x + dx, y: v.y + dy } : v));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  /** 以视口中心为锚缩放（缩放按钮用；按钮上没有指针位置） */
  const zoomAt = (factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const px = el.clientWidth / 2;
    const py = el.clientHeight / 2;
    setView((v) => {
      if (!v) return v;
      const k = Math.min(K_MAX, Math.max(K_MIN, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };

  /** 双击 / Enter：把节点放到视口中心（至少放大到 0.9，细节才看得清） */
  const focusNode = useCallback(
    (id: number) => {
      const el = viewportRef.current;
      const node = layout?.nodes.find((n) => n.dept.id === id);
      if (!el || !node) return;
      setView((v) => {
        if (!v) return v;
        const k = Math.max(v.k, 0.9);
        return { k, x: el.clientWidth / 2 - (node.x + NODE_W / 2) * k, y: el.clientHeight / 2 - (node.y + NODE_H / 2) * k };
      });
    },
    [layout],
  );

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 方向键导航：上=上级 下=第一个下级 左右=同级相邻；Enter=聚焦居中 */
  const onNodeKey = (e: React.KeyboardEvent, node: LaidNode) => {
    if (!layout) return;
    let target: LaidNode | undefined;
    if (e.key === "ArrowUp") target = layout.nodes.find((n) => n.dept.id === node.parentId);
    else if (e.key === "ArrowDown") target = layout.nodes.find((n) => n.parentId === node.dept.id);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const row = layout.nodes.filter((n) => n.depth === node.depth).sort((a, b) => a.x - b.x);
      target = row[row.indexOf(node) + (e.key === "ArrowRight" ? 1 : -1)];
    } else if (e.key === "Enter") {
      focusNode(node.dept.id);
      return;
    } else return;
    e.preventDefault();
    if (!target) return;
    onSelect(target.dept);
    // 选中态变化后节点已在新位置，等一帧再移焦点（scaffold 同款 nextTick 手法）
    requestAnimationFrame(() => viewportRef.current?.querySelector<HTMLElement>(`[data-node="${target?.dept.id}"]`)?.focus());
  };

  if (tree === null) {
    return (
      <div className="panel">
        <SkeletonRows n={8} />
      </div>
    );
  }
  if (tree.length === 0) {
    return (
      <div className="panel">
        <Empty icon={<Graph size={22} />} title="暂无部门" desc="AD 组织同步或手动新建部门后，这里会显示组织画布" />
      </div>
    );
  }
  if (!layout) return null;

  const direct = selected ? members.get(selected.id) ?? 0 : 0;
  const total = selected ? subtreeMemberCount(selected, members) : 0;

  return (
    <div className={`oc-canvas${dragging ? " is-dragging" : ""}`} ref={viewportRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div className="oc-dots" aria-hidden="true" />

      {view && (
        <div
          className="oc-layer"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          }}
        >
          <svg className="oc-links" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.links.map((l) => (
              <path
                key={l.id}
                d={l.d}
                className={`oc-link cat-${(l.branch % 5) + 1}${activeLinkIds.has(l.id) ? " is-active" : ""}`}
                data-depth={l.depth}
                style={{ animationDelay: `${l.depth * 0.18 + 0.1}s` }}
              />
            ))}
          </svg>

          {layout.nodes.map((n) => {
            const isSelected = selected?.id === n.dept.id;
            const leaderList = leaders?.get(n.dept.id);
            const leader = leaderList?.[0] ?? "未设负责人";
            const count = subtreeMemberCount(n.dept, members);
            return (
              <div
                key={n.dept.id}
                role="button"
                tabIndex={0}
                data-node={n.dept.id}
                data-depth={n.depth}
                aria-pressed={isSelected}
                aria-label={`${n.dept.name}，含下级成员 ${count} 人，负责人 ${leader}`}
                className={`oc-node cat-${(n.branch % 5) + 1}${isSelected ? " is-selected" : ""}${n.depth === 0 ? " is-root" : ""}`}
                style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H, animationDelay: `${n.depth * 0.18}s` }}
                onClick={() => onSelect(n.dept)}
                onDoubleClick={() => focusNode(n.dept.id)}
                onKeyDown={(e) => onNodeKey(e, n)}
                title={`${n.dept.path} · 含下级成员 ${count} 人${leaderList && leaderList.length > 1 ? ` · 负责人 ${leaderList.join("、")}` : ""}`}
              >
                <span className="oc-strip" aria-hidden="true" />
                <span className="oc-name">{n.dept.name}</span>
                <span className="oc-meta">
                  <span className="oc-leader">{leader}</span>
                  <span className="oc-count">{count} 人</span>
                </span>
                {n.hasChildren && (
                  <button
                    type="button"
                    className="oc-toggle"
                    aria-label={collapsed.has(n.dept.id) ? "展开下级" : "收起下级"}
                    title={collapsed.has(n.dept.id) ? "展开下级" : "收起下级"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(n.dept.id);
                    }}
                  >
                    {collapsed.has(n.dept.id) ? n.dept.children.length : "−"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 右上分析栏：selected 的变化走 contentKey 重放入场；芯片下钻走 focusNode（不重新 fit） */}
      {insight && insightOpen ? (
        <InsightPanel
          className="oc-insight"
          contentKey={String(insight.title + insight.subtitle)}
          kind={insight.kind}
          kindIcon={<Buildings size={13} />}
          title={insight.title}
          subtitle={insight.subtitle}
          status={insight.status}
          metric={insight.metric}
          tiles={insight.tiles}
          insights={insight.insights}
          groups={insight.groups}
          onClose={() => setInsightOpen(false)}
          onChip={(chip) => {
            // 芯片带 deptId 才能下钻；没有 id 的（理论上不该出现）不装作可点
            const id = (chip as { deptId?: number }).deptId;
            const target = id == null || !tree ? null : findDeptNode(tree, id);
            if (!target) return;
            onSelect(target);
            focusNode(target.id);
          }}
        >
          <div className="ip-foot">
            <Button size="sm" variant="outline" className="gap-1" onClick={onExit}>
              <List size={13} /> 返回组织列表
            </Button>
          </div>
        </InsightPanel>
      ) : (
        <div className="oc-panel">
          <div className="oc-panel-title">组织画布</div>
          <div className="oc-panel-hint">拖拽平移 · Ctrl/⌘+滚轮缩放 · 单击选中 · 双击居中</div>
          <div className="oc-panel-sub">
            {selected ? `已选 ${selected.name} · 直接 ${direct} · 含下级 ${total}` : "未选中部门"}
          </div>
          <div className="ip-foot">
            {insight && (
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setInsightOpen(true)}>
                分析
              </Button>
            )}
            <Button size="sm" variant="outline" className="gap-1" onClick={onExit}>
              <List size={13} /> 返回组织列表
            </Button>
          </div>
        </div>
      )}

      {/* 右下浮动控件：缩放 */}
      <div className="oc-controls" role="group" aria-label="画布缩放">
        <Button size="sm" variant="outline" title="放大" onClick={() => zoomAt(1.2)}>
          <Plus size={14} />
        </Button>
        <Button size="sm" variant="outline" title="缩小" onClick={() => zoomAt(1 / 1.2)}>
          <Minus size={14} />
        </Button>
        <Button size="sm" variant="outline" title="适应画布" onClick={fit}>
          <ArrowsOut size={14} />
        </Button>
      </div>
    </div>
  );
}
