// 规划中模块的优雅空态页（不做 mock，忠于后端分期）

import { PageHead } from "../ui";
import type { Icon } from "@phosphor-icons/react";
import { ClockCounterClockwise } from "@phosphor-icons/react";

export function Planned({
  title,
  desc,
  phase,
  items,
}: {
  title: string;
  desc: string;
  phase: string;
  items: Array<{ name: string; note: string; icon?: Icon }>;
}) {
  return (
    <div>
      <PageHead title={title} desc={desc} />
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>规划与依赖</h3>
            <div className="sub">该模块尚未开始开发，界面与数据均未接入，避免展示误导性的 mock</div>
          </div>
          <span className="scopechip">
            <ClockCounterClockwise size={13} /> {phase}
          </span>
        </div>
      </div>
      <div className="grid-cards">
        {items.map((it) => (
          <div key={it.name} className="plancard">
            {it.icon ? <div className="ic"><it.icon size={17} weight="duotone" /></div> : null}
            <div className="t">{it.name}</div>
            <div className="s">{it.note}</div>
            <span className="p">
              <ClockCounterClockwise size={12} /> {phase} · 待建设
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
