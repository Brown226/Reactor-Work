// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web, @/components/tags）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/dialogs/publish-dialog.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  type SquarePublishStatus,
  useDatasetsSquarePublishConfigQuery,
} from "../../../../../../kb-shims/console-services";
import { Button } from "../../../../../ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../../ui/components/ui/dialog";
import { Label } from "../../../../../ui/components/ui/label";
import { Switch } from "../../../../../ui/components/ui/switch";
import { cn } from "../../../../../ui/lib/utils";
import { useEffect, useRef, useState } from "react";

import { TagSelect } from "../../../../../../kb-shims/ui";

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPublishedToSquare?: boolean;
  defaultTagIds?: string[];
  squarePublishStatus?: SquarePublishStatus;
  squareRejectReason?: string | null;
  loading?: boolean;
  onConfirm?: (
    publishToSquare: boolean,
    tagIds?: string[],
    memberJoinApprovalRequired?: boolean,
  ) => void;
  defaultMemberJoinApprovalRequired?: boolean;
}

export function PublishDialog({
  open,
  onOpenChange,
  defaultPublishedToSquare = false,
  defaultTagIds,
  squarePublishStatus = "none",
  squareRejectReason,
  loading = false,
  onConfirm,
  defaultMemberJoinApprovalRequired = true,
}: PublishDialogProps) {
  const configQuery = useDatasetsSquarePublishConfigQuery({ enabled: open });
  const skipReview = configQuery.data?.squarePublishSkipReview === true;
  const [publishToSquare, setPublishToSquare] = useState(defaultPublishedToSquare);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(defaultTagIds ?? []);
  const [memberJoinApprovalRequired, setMemberJoinApprovalRequired] = useState(
    defaultMemberJoinApprovalRequired,
  );
  const [reasonDialogOpen, setReasonDialogOpen] = useState(false);
  const initialPublishedToSquareRef = useRef(defaultPublishedToSquare);
  const isPending = squarePublishStatus === "pending";
  const isRejected = squarePublishStatus === "rejected";
  /** Whether the dialog was opened in "unpublish" mode (already published). */
  const isUnpublishMode = initialPublishedToSquareRef.current === true;
  const canSubmit = true;
  const canResubmit = true;

  useEffect(() => {
    if (open) {
      const initial = defaultPublishedToSquare;
      initialPublishedToSquareRef.current = initial;
      setPublishToSquare(initial);
      setSelectedTagIds(defaultTagIds ?? []);
      setMemberJoinApprovalRequired(defaultMemberJoinApprovalRequired);
    }
  }, [open, defaultPublishedToSquare, defaultTagIds, defaultMemberJoinApprovalRequired]);

  const handleConfirm = () => {
    const initial = initialPublishedToSquareRef.current;
    if (publishToSquare === initial) {
      onOpenChange(false);
      return;
    }
    if (!canSubmit) return;
    onConfirm?.(
      publishToSquare,
      publishToSquare ? selectedTagIds : undefined,
      memberJoinApprovalRequired,
    );
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleResubmit = () => {
    if (!canResubmit) return;
    onConfirm?.(true, selectedTagIds, memberJoinApprovalRequired);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>知识广场发布设置</DialogTitle>
          </DialogHeader>

          <div className="bg-muted/50 mx-4 mt-8 space-y-3 rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">是否发布到知识广场</p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {skipReview
                    ? "确认发布后将直接上架，知识广场将展示此知识库"
                    : "确认发布后需管理员审核，审核通过后知识广场将展示此知识库"}
                </p>
              </div>
              <Switch
                checked={publishToSquare}
                onCheckedChange={setPublishToSquare}
                className="shrink-0"
                disabled={isPending}
              />
            </div>
            {publishToSquare && !isPending && (
              <div
                className={cn(
                  "flex justify-between space-y-2 pt-2",
                  isUnpublishMode && "pointer-events-none opacity-50",
                )}
                aria-disabled={isUnpublishMode || undefined}
              >
                <Label className="text-sm font-medium">
                  分类 <span className="text-muted-foreground text-xs">(可选)</span>
                </Label>

                <TagSelect
                  tagsSource="web"
                  type="dataset"
                  value={selectedTagIds}
                  onChange={setSelectedTagIds}
                  placeholder="搜索分类"
                />
              </div>
            )}
            {publishToSquare && (
              <div
                className={cn(
                  "flex items-start justify-between gap-4 pt-2",
                  isUnpublishMode && "opacity-50",
                )}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">成员加入是否需要确认</p>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    关闭后，访问该知识库的用户可直接加入成为成员，无需创建者审核。
                  </p>
                </div>
                <Switch
                  checked={memberJoinApprovalRequired}
                  onCheckedChange={setMemberJoinApprovalRequired}
                  className="shrink-0"
                  disabled={isUnpublishMode}
                />
              </div>
            )}
            {isPending && (
              <p className="text-muted-foreground text-xs">当前状态：待审核，请等待管理员审核。</p>
            )}
            {isRejected && (
              <div className="space-y-1">
                <p className="text-destructive text-xs">当前状态：审核未通过</p>
                <Button
                  variant="link"
                  size="sm"
                  className="text-destructive h-auto p-0 text-xs"
                  onClick={() => setReasonDialogOpen(true)}
                >
                  查看拒绝原因
                </Button>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 px-4 pt-6 pb-4">
            <Button variant="outline" onClick={handleCancel} disabled={loading}>
              {isPending ? "关闭" : "取消"}
            </Button>
            {isRejected ? (
              <Button onClick={handleResubmit} disabled={loading || !canResubmit}>
                {loading ? "提交中…" : "重新提交"}
              </Button>
            ) : !isPending ? (
              <Button onClick={handleConfirm} disabled={loading || !canSubmit}>
                {loading ? "提交中…" : "确定"}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reasonDialogOpen} onOpenChange={setReasonDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>拒绝原因</DialogTitle>
          </DialogHeader>
          <div className="min-h-[60px] py-2">
            <p className="text-muted-foreground text-sm">
              {squareRejectReason?.trim()
                ? squareRejectReason
                : "暂无具体原因，如有疑问请联系管理员。"}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonDialogOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
