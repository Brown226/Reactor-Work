// Reactor 管理台 · 分析栏（复刻 scaffold-master 的 InsightPanel）
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/InsightPanel.vue（93 行）
//   （头部分类 → 标题/状态 → 主读数 + 迷你柱 → 读数块 → 洞察卡 → 关联芯片）
//
// 复刻取舍（为什么不是照搬）：
//   1. GSAP 的 revealCascade 入场 → CSS animation。B1/B2 已定调「不引入额外运行时依赖」；
//      这里用 `animation-delay: var(--i)` 逐条浮现，效果等价、零 JS。
//   2. 原版是 Vue 具名 props + slot；React 这边保留同一套 props 形状，
//      额外支持 `onChip` 回调（原版 emit('chip')），让芯片能真下钻而不是摆设。
//   3. 原版靠 `Icon` 名字传图标；这里图标由调用方以 ReactNode 传入，
//      避免为了 4 个图标维护一张名字表。
//
// 与 Vue 版的一处主动增强：`tiles` 用 CSS grid `auto-fit`，窄屏自动折行；
// 原版靠 `min(360px, 100%)` 定宽，手机上会挤成一行。

import type { ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import type { InsightCard, InsightChip, InsightGroup, InsightTile } from "../lib/dept-insight";

export type { InsightCard, InsightChip, InsightGroup, InsightTile };

export interface InsightPanelProps {
  /** 内容主键：变化时重放入场动画（选中别的节点） */
  contentKey: string;
  kind: string;
  kindIcon?: ReactNode;
  title: string;
  subtitle?: string;
  status?: string;
  metric?: { label: string; value: number | null; unit?: string; bars?: number[] };
  tiles?: InsightTile[];
  insights?: InsightCard[];
  groups?: InsightGroup[];
  onClose?: () => void;
  onChip?: (chip: InsightChip) => void;
  /** 底部附加内容（原版的 slot） */
  children?: ReactNode;
  className?: string;
}

const barMax = (bars: number[]) => Math.max(1, ...bars);

export function InsightPanel({
  contentKey,
  kind,
  kindIcon,
  title,
  subtitle,
  status,
  metric,
  tiles,
  insights,
  groups,
  onClose,
  onChip,
  children,
  className,
}: InsightPanelProps) {
  return (
    <aside className={`ip-panel${className ? ` ${className}` : ""}`} role="region" aria-label={`${title} 的分析`}>
      <header className="ip-head">
        <span className="ip-kind">
          <span className="ip-kind-icon" aria-hidden="true">
            {kindIcon}
          </span>
          {kind}
        </span>
        {onClose && (
          <button type="button" className="ip-close" aria-label="关闭分析" title="关闭分析" onClick={onClose}>
            <X size={13} />
          </button>
        )}
      </header>

      {/* key 变化 ⇒ React 重建子树 ⇒ CSS 动画重播（对应 Vue 版的 contentKey watch） */}
      <div className="ip-body" key={contentKey}>
        <div className="ip-title" style={{ ["--i" as string]: 0 }}>
          <h3>{title}</h3>
          {subtitle && <p className="ip-subtitle">{subtitle}</p>}
          {status && <p className="ip-status">{status}</p>}
        </div>

        {metric && (
          <section className="ip-metric" style={{ ["--i" as string]: 1 }}>
            <span className="ip-metric-label">{metric.label}</span>
            <div className="ip-metric-row">
              <span className="ip-metric-value">
                {metric.value ?? "—"}
                {metric.unit && <small>{metric.unit}</small>}
              </span>
              {Boolean(metric.bars?.length) && (
                <span className="ip-bars" aria-hidden="true">
                  {metric.bars!.map((b, i) => (
                    <i
                      key={i}
                      style={{
                        ["--h" as string]: Math.max(0.08, b / barMax(metric.bars!)),
                        ["--d" as string]: `${120 + i * 28}ms`,
                      }}
                    />
                  ))}
                </span>
              )}
            </div>
          </section>
        )}

        {Boolean(tiles?.length) && (
          <dl className="ip-tiles" style={{ ["--i" as string]: 2 }}>
            {tiles!.map((t) => (
              <div key={t.label}>
                <dt>{t.label}</dt>
                <dd>
                  {t.value ?? "—"}
                  {t.unit && <small>{t.unit}</small>}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {Boolean(insights?.length) && (
          <section className="ip-cards" style={{ ["--i" as string]: 3 }}>
            {insights!.map((c) => (
              <article key={c.title} className={`ip-card tone-${c.tone ?? "info"}`}>
                <h4>{c.title}</h4>
                <p>{c.text}</p>
              </article>
            ))}
          </section>
        )}

        {groups?.map((g, gi) => (
          <section key={g.title} className="ip-group" style={{ ["--i" as string]: 4 + gi }}>
            <h4>
              {g.title}
              <b>{g.chips.length + (g.more ?? 0)}</b>
            </h4>
            <div className="ip-chips">
              {g.chips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`ip-chip${c.tone ? ` tone-${c.tone}` : ""}`}
                  onClick={() => onChip?.(c)}
                  title={c.sub ? `${c.label} · ${c.sub}` : c.label}
                >
                  {c.label}
                  {c.sub && <small>{c.sub}</small>}
                </button>
              ))}
              {Boolean(g.more) && <span className="ip-chip is-more">+{g.more}</span>}
              {g.chips.length === 0 && <span className="ip-faint">暂无</span>}
            </div>
          </section>
        ))}

        {children}
      </div>
    </aside>
  );
}
