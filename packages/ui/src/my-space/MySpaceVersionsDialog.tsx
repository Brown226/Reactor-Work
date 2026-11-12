/**
 * 我的空间：历史版本弹窗。
 *
 * 旧版把版本列表常驻在预览下方：不点也占着一行高度，点了又把预览挤掉一截。
 * 改成标题栏的「历史版本」图标打开独立弹窗——列表、大小、恢复都在弹窗里完成，
 * 关闭后详情面板回到纯预览状态。
 */
import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes, spaceClient } from "./spaceClient.js";

interface VersionItem {
  id: string;
  size: number;
  savedAt: string;
}

/** 旧版本目录里的时间戳可能还原失败（历史脏数据），兜底显示「—」而不是 Invalid Date。 */
function formatVersionWhen(savedAt: string): string {
  const t = new Date(savedAt);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleString();
}

export interface MySpaceVersionsDialogProps {
  open: boolean;
  /** 文件显示名，用于弹窗副标题 */
  name: string;
  /** 相对空间根的路径 */
  relPath: string;
  onClose: () => void;
  /** 恢复成功后通知外层刷新列表 */
  onRestored: () => void;
  onError: (e: unknown) => void;
}

export function MySpaceVersionsDialog({
  open,
  name,
  relPath,
  onClose,
  onRestored,
  onError,
}: MySpaceVersionsDialogProps) {
  const { intl } = useZCodeIntl();
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await spaceClient.versions(relPath);
      setVersions(result.items);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError, relPath]);

  // 每次打开都重新拉：换文件、或者刚覆盖上传过，缓存都会过期
  useEffect(() => {
    if (!open) return;
    setVersions(null);
    void load();
  }, [load, open]);

  const restore = async (versionId: string) => {
    setRestoringId(versionId);
    try {
      await spaceClient.restoreVersion(relPath, versionId);
      onRestored();
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <History className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "mySpace.details.versions" })}
            </span>
          </DialogTitle>
          <DialogDescription className="truncate" title={name}>
            {name}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-32 overflow-hidden rounded-lg border border-border">
          {loading || versions === null ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "mySpace.list.loading" })}
            </p>
          ) : versions.length === 0 ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "mySpace.details.versionsEmpty" })}
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-auto">
              {versions.map((version) => (
                <li key={version.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle">
                    {formatVersionWhen(version.savedAt)}
                  </span>
                  <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                    {formatBytes(version.size)}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    disabled={restoringId !== null}
                    onClick={() => void restore(version.id)}
                  >
                    {intl.formatMessage({ id: "mySpace.action.restore" })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button size="lg" variant="ghost" onClick={onClose}>
            {intl.formatMessage({ id: "mySpace.details.close" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
