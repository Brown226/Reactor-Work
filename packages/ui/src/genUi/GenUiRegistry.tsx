import type { GenUiNode, GenUiTreeV1 } from "@zcode/shared";

/**
 * GenUI 节点渲染（P0）：kind → 组件纯映射。
 * 未知 kind 一律 JsonDebug 折叠降级；禁止 dangerouslySetInnerHTML。
 */

function str(v: unknown): string {
  return typeof v === "string" ? v : v != null ? String(v) : "";
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function JsonDebugNode({ node }: { node: GenUiNode }) {
  return (
    <details className="rounded-lg border border-border bg-surface p-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        未识别节点 {str(node.kind) || "(empty)"}
      </summary>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-[11px]">
        {JSON.stringify(node, null, 2)}
      </pre>
    </details>
  );
}

function SectionHeaderNode({ node }: { node: GenUiNode }) {
  const p = node.props ?? {};
  return (
    <div className="mb-2">
      {str(p.eyebrow) ? (
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
          {str(p.eyebrow)}
        </p>
      ) : null}
      {str(p.title) ? <h3 className="text-base font-semibold">{str(p.title)}</h3> : null}
      {str(p.description) ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{str(p.description)}</p>
      ) : null}
    </div>
  );
}

function MetricCardNode({ node }: { node: GenUiNode }) {
  const p = node.props ?? {};
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-xs text-muted-foreground">{str(p.label)}</div>
      <div className="mt-1 text-2xl font-semibold">
        {str(p.value)}
        {str(p.unit) ? <span className="ml-1 text-sm font-normal">{str(p.unit)}</span> : null}
      </div>
      {str(p.delta) ? <div className="mt-1 text-xs text-muted-foreground">{str(p.delta)}</div> : null}
    </div>
  );
}

function KpiBoardNode({
  node,
  renderChild,
}: {
  node: GenUiNode;
  renderChild: (child: GenUiNode) => React.ReactNode;
}) {
  const columns = Math.min(4, Math.max(1, num(node.props?.columns, 3)));
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
    </div>
  );
}

function WeatherCardNode({ node, renderChild }: { node: GenUiNode; renderChild: (c: GenUiNode) => React.ReactNode }) {
  const p = node.props ?? {};
  const forecast = Array.isArray(p.forecast) ? (p.forecast as Array<Record<string, unknown>>) : [];
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-sky-500 to-blue-700 p-4 text-white">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm opacity-90">{str(p.city) || "—"}</div>
          <div className="text-4xl font-semibold">{str(p.temp) || "—"}°</div>
          <div className="mt-1 text-sm opacity-90">{str(p.condition)}</div>
        </div>
        {str(p.icon) ? <div className="text-3xl">{str(p.icon)}</div> : null}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
        {forecast.map((day, index) => (
          <div key={index} className="rounded-lg bg-white/10 py-2">
            <div className="opacity-80">{str(day.label)}</div>
            <div className="mt-1 font-medium">{str(day.temp)}</div>
          </div>
        ))}
      </div>
      {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
    </div>
  );
}

function StepperNode({
  node,
  renderChild,
}: {
  node: GenUiNode;
  renderChild: (c: GenUiNode) => React.ReactNode;
}) {
  const p = node.props ?? {};
  const steps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : [];
  const current = num(p.current, 0);
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "active" : "todo";
        return (
          <li key={index} className="flex items-start gap-2">
            <span
              className={[
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                state === "done"
                  ? "bg-primary text-primary-foreground"
                  : state === "active"
                    ? "border border-primary text-primary"
                    : "border border-border text-muted-foreground",
              ].join(" ")}
            >
              {index + 1}
            </span>
            <div>
              <div className="text-sm font-medium">{str(step.title)}</div>
              {str(step.description) ? (
                <div className="text-xs text-muted-foreground">{str(step.description)}</div>
              ) : null}
            </div>
          </li>
        );
      })}
      {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
    </ol>
  );
}

function AlertNode({ node }: { node: GenUiNode }) {
  const p = node.props ?? {};
  const tone = str(p.tone) || "info";
  const toneClass =
    tone === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
        : "border-border bg-surface text-foreground";
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${toneClass}`}>{str(p.text)}</div>
  );
}

export interface GenUiActionEvent {
  actionId?: string;
  formValues?: Record<string, unknown>;
}

function ButtonNode({
  node,
  onAction,
}: {
  node: GenUiNode;
  onAction?: (event: GenUiActionEvent) => void;
}) {
  const p = node.props ?? {};
  return (
    <button
      type="button"
      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
      onClick={() => onAction?.({ actionId: str(p.actionId) || undefined })}
    >
      {str(p.label) || "Action"}
    </button>
  );
}

function FormNode({
  node,
  renderChild,
  onAction,
}: {
  node: GenUiNode;
  renderChild: (c: GenUiNode) => React.ReactNode;
  onAction?: (event: GenUiActionEvent) => void;
}) {
  const formId = str(node.props?.formId);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values: Record<string, unknown> = {};
        for (const el of Array.from(form.elements)) {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          if (!input.name) continue;
          values[input.name] = "value" in input ? input.value : "";
        }
        onAction?.({ actionId: "submit", formValues: { formId, ...values } });
      }}
    >
      {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
    </form>
  );
}

function InputNode({ node, multiline }: { node: GenUiNode; multiline?: boolean }) {
  const p = node.props ?? {};
  const shared = {
    name: str(p.name),
    placeholder: str(p.placeholder),
    defaultValue: str(p.value),
    className:
      "w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none",
  };
  return multiline ? <textarea {...shared} rows={3} /> : <input {...shared} />;
}

export function GenUiTreeView({
  tree,
  onAction,
}: {
  tree: GenUiTreeV1;
  onAction?: (event: GenUiActionEvent) => void;
}) {
  const renderChild = (node: GenUiNode): React.ReactNode => {
    switch (node.kind) {
      case "Stack":
        return (
          <div key={node.nodeId} className="flex flex-col gap-2">
            {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
          </div>
        );
      case "Row":
        return (
          <div key={node.nodeId} className="flex flex-wrap items-center gap-2">
            {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
          </div>
        );
      case "Grid":
        return (
          <div
            key={node.nodeId}
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, num(node.props?.columns, 2)))}, minmax(0, 1fr))`,
            }}
          >
            {(node.children ?? []).map((child: GenUiNode) => renderChild(child))}
          </div>
        );
      case "SectionHeader":
        return <SectionHeaderNode key={node.nodeId} node={node} />;
      case "Text":
        return (
          <p key={node.nodeId} className="text-sm">
            {str(node.props?.text)}
          </p>
        );
      case "Heading":
        return (
          <h4 key={node.nodeId} className="text-base font-semibold">
            {str(node.props?.text)}
          </h4>
        );
      case "MetricCard":
        return <MetricCardNode key={node.nodeId} node={node} />;
      case "KpiBoard":
        return <KpiBoardNode key={node.nodeId} node={node} renderChild={renderChild} />;
      case "WeatherCard":
        return <WeatherCardNode key={node.nodeId} node={node} renderChild={renderChild} />;
      case "Stepper":
        return <StepperNode key={node.nodeId} node={node} renderChild={renderChild} />;
      case "Image":
        return (
          <img
            key={node.nodeId}
            src={str(node.props?.src)}
            alt={str(node.props?.alt) || ""}
            className="max-h-80 rounded-lg border border-border object-contain"
          />
        );
      case "Alert":
      case "Callout":
        return <AlertNode key={node.nodeId} node={node} />;
      case "Button":
      case "InteractiveButton":
        return <ButtonNode key={node.nodeId} node={node} onAction={onAction} />;
      case "Form":
        return (
          <FormNode key={node.nodeId} node={node} renderChild={renderChild} onAction={onAction} />
        );
      case "Input":
        return <InputNode key={node.nodeId} node={node} />;
      case "Textarea":
        return <InputNode key={node.nodeId} node={node} multiline />;
      case "NumberInput":
        return (
          <input
            key={node.nodeId}
            type="number"
            name={str(node.props?.name)}
            placeholder={str(node.props?.placeholder)}
            defaultValue={str(node.props?.value)}
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
        );
      default:
        return <JsonDebugNode key={node.nodeId} node={node} />;
    }
  };

  return <div className="gen-ui-tree flex flex-col gap-2">{renderChild(tree.root)}</div>;
}
