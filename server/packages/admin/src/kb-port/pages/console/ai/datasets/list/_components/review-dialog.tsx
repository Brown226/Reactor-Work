// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/console）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/console/ai/datasets/list/_components/review-dialog.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { ConsoleDatasetItem } from "../../../../../../../kb-shims/console-services";
import {
  useApproveDatasetSquareMutation,
  useRejectDatasetSquareMutation,
} from "../../../../../../../kb-shims/console-services";
import { Button } from "../../../../../../ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../../../ui/components/ui/dialog";
import { Label } from "../../../../../../ui/components/ui/label";
import { Textarea } from "../../../../../../ui/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type ReviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataset: ConsoleDatasetItem | null;
  onSuccess?: () => void;
};

export function ReviewDialog({ open, onOpenChange, dataset, onSuccess }: ReviewDialogProps) {
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const approveMutation = useApproveDatasetSquareMutation({
    onSuccess: () => {
      toast.success("已通过审核");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (e) => toast.error(`审核失败: ${e.message}`),
  });

  const rejectMutation = useRejectDatasetSquareMutation({
    onSuccess: () => {
      toast.success("已拒绝发布");
      onOpenChange(false);
      setShowRejectInput(false);
      setRejectReason("");
      onSuccess?.();
    },
  });

  const handleApprove = () => {
    if (!dataset) return;
    approveMutation.mutate(dataset.id);
  };

  const handleRejectClick = () => {
    setShowRejectInput(true);
  };

  const handleRejectSubmit = () => {
    if (!dataset) return;
    rejectMutation.mutate({ id: dataset.id, reason: rejectReason.trim() || undefined });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setShowRejectInput(false);
      setRejectReason("");
    }
    onOpenChange(next);
  };

  const pending = approveMutation.isPending || rejectMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>审核知识库</DialogTitle>
          <DialogDescription>
            {dataset ? `「${dataset.name}」申请发布到广场，请选择通过或拒绝。` : ""}
          </DialogDescription>
        </DialogHeader>
        {showRejectInput && (
          <div className="grid gap-2 py-2">
            <Label htmlFor="reject-reason">拒绝原因（选填）</Label>
            <Textarea
              id="reject-reason"
              placeholder="请输入拒绝原因"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>
        )}
        <DialogFooter className="gap-2">
          {showRejectInput ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setShowRejectInput(false)}
              >
                返回
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={handleRejectSubmit}
              >
                {rejectMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                确认拒绝
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => handleOpenChange(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={handleRejectClick}
              >
                拒绝
              </Button>
              <Button type="button" disabled={pending} onClick={handleApprove}>
                {approveMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                通过
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
