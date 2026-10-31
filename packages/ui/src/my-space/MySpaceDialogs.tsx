/**
 * 我的空间：输入类弹窗。
 *
 * 旧版用 window.prompt / window.confirm：原生弹窗在桌面壳里样式不可控，
 * 也不能带校验与多字段。这里换成产品统一的 Dialog。
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface MySpaceTextDialogProps {
  open: boolean;
  title: string;
  description?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** 允许留空（移动面板的「根目录」语义）；默认不允许。 */
  allowEmpty?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

export function MySpaceTextDialog({
  open,
  title,
  description,
  placeholder,
  initialValue = "",
  confirmLabel,
  allowEmpty = false,
  onCancel,
  onSubmit,
}: MySpaceTextDialogProps) {
  const { intl } = useZCodeIntl();
  const [value, setValue] = useState(initialValue);

  // 每次打开都回到调用方给的初始值：重命名/移动复用同一个弹窗实例，不能带出上一次输入。
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [initialValue, open]);

  const canSubmit = allowEmpty || value.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) onSubmit(value.trim());
            if (event.key === "Escape") onCancel();
          }}
        />
        <DialogFooter>
          <Button size="lg" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "mySpace.dialog.cancel" })}
          </Button>
          <Button size="lg" disabled={!canSubmit} onClick={() => onSubmit(value.trim())}>
            {confirmLabel ?? intl.formatMessage({ id: "mySpace.dialog.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface MySpaceShareDialogProps {
  open: boolean;
  name: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (params: { ttlHours: number; password?: string }) => void;
}

export function MySpaceShareDialog({
  open,
  name,
  busy,
  onCancel,
  onSubmit,
}: MySpaceShareDialogProps) {
  const { intl } = useZCodeIntl();
  const [ttlHours, setTtlHours] = useState(24);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (open) {
      setTtlHours(24);
      setPassword("");
    }
  }, [open]);

  const safeTtl = Number.isFinite(ttlHours)
    ? Math.min(24 * 30, Math.max(1, Math.trunc(ttlHours)))
    : 24;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "mySpace.dialog.share.title" }, { name })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "mySpace.dialog.share.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mySpace.dialog.share.ttl" })}
            <Input
              type="number"
              min={1}
              max={24 * 30}
              value={ttlHours}
              onChange={(event) => setTtlHours(Number(event.currentTarget.value))}
            />
          </label>
          <label className="grid gap-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mySpace.dialog.share.password" })}
            <Input
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSubmit({
                    ttlHours: safeTtl,
                    ...(password.trim() ? { password: password.trim() } : {}),
                  });
                }
              }}
            />
          </label>
        </div>
        <DialogFooter>
          <Button size="lg" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "mySpace.dialog.cancel" })}
          </Button>
          <Button
            size="lg"
            disabled={busy}
            onClick={() =>
              onSubmit({
                ttlHours: safeTtl,
                ...(password.trim() ? { password: password.trim() } : {}),
              })
            }
          >
            {intl.formatMessage({ id: "mySpace.dialog.share.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
