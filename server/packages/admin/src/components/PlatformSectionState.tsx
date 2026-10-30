// 双平台看板的两种空态（多个区块共用，保证同一件事只有一种说法）。

/**
 * 「没有数据」：配合 coverage.since 说明数据从哪天开始，避免用户把空看板当成故障。
 */
export function SectionEmpty({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="empty" style={{ padding: "16px 0" }}>
      <div className="t">{title}</div>
      {desc ? <div className="s">{desc}</div> : null}
    </div>
  );
}

/**
 * 「接口还没上线」：service 层把 404/501 降级成 null，这里负责说清楚原因。
 * 与 SectionEmpty 分开是因为它们的含义完全不同：一个是没数据，一个是没功能。
 */
export function Unavailable({ section }: { section: string }) {
  return (
    <div className="empty" style={{ padding: "16px 0" }}>
      <div className="t">数据尚未上线</div>
      <div className="s">{section}接口暂未提供（404）；后端上线后本页自动出现数据，前端无需再改。</div>
    </div>
  );
}
