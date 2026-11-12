// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/constants/shared/datasets.constants, @buildingai/services/console, @/components/ask-assistant-ui, @/layouts/console/_components/page-container）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/console/ai/datasets/config/index.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  RETRIEVAL_MODE,
  type RetrievalModeType,
} from "../../../../../constants/datasets.constants";
import {
  type UpdateDatasetsConfigDto,
  useDatasetsConfigQuery,
  useSetDatasetsConfigMutation,
} from "../../../../../../kb-shims/console-services";
import { PermissionGuard } from "../../../../../ui/components/auth/permission-guard";
import { Button } from "../../../../../ui/components/ui/button";
import { Input } from "../../../../../ui/components/ui/input";
import { Label } from "../../../../../ui/components/ui/label";
import { Switch } from "../../../../../ui/components/ui/switch";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ModelSelector } from "../../../../../ask-assistant-ui/index";
import { PageContainer } from "../../../../../../kb-shims/ui";

import {
  buildEmptyRetrievalConfig,
  type RetrievalConfig,
  RetrievalConfigSection,
} from "./retrieval-config";

const DatasetsConfigPage = () => {
  const [initialStorageMb, setInitialStorageMb] = useState(1024);
  const [embeddingModelId, setEmbeddingModelId] = useState("");
  const [textModelId, setTextModelId] = useState("");
  const [squarePublishSkipReview, setSquarePublishSkipReview] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalConfig>(
    buildEmptyRetrievalConfig(RETRIEVAL_MODE.HYBRID),
  );

  const { data, isLoading } = useDatasetsConfigQuery();

  const setConfigMutation = useSetDatasetsConfigMutation({
    onSuccess: () => {
      toast.success("保存成功");
    },
    onError: (e) => {
      toast.error(`保存失败: ${e.message}`);
    },
  });

  useEffect(() => {
    if (!data) return;
    setInitialStorageMb(data.initialStorageMb);
    setEmbeddingModelId(data.embeddingModelId ?? "");
    setTextModelId(data.textModelId ?? "");
    setSquarePublishSkipReview(data.squarePublishSkipReview ?? false);
    const rc = data.defaultRetrievalConfig;
    if (rc) {
      setRetrieval({
        retrievalMode: rc.retrievalMode,
        strategy: rc.strategy ?? "weighted_score",
        topK: rc.topK ?? 3,
        scoreThreshold: rc.scoreThreshold ?? 0.5,
        scoreThresholdEnabled: rc.scoreThresholdEnabled ?? false,
        weightConfig: {
          semanticWeight: rc.weightConfig?.semanticWeight ?? 0.7,
          keywordWeight: rc.weightConfig?.keywordWeight ?? 0.3,
        },
        rerankConfig: {
          enabled: rc.rerankConfig?.enabled ?? false,
          modelId: rc.rerankConfig?.modelId ?? "",
        },
      });
    }
  }, [data]);

  const handleSave = () => {
    if (!embeddingModelId?.trim()) {
      toast.error("请选择 Embedding 模型");
      return;
    }
    const dto: UpdateDatasetsConfigDto = {
      initialStorageMb,
      embeddingModelId: embeddingModelId.trim(),
      textModelId: textModelId.trim() || undefined,
      squarePublishSkipReview,
      defaultRetrievalConfig: {
        retrievalMode: retrieval.retrievalMode as RetrievalModeType,
        strategy: retrieval.strategy,
        topK: retrieval.topK,
        scoreThreshold: retrieval.scoreThreshold,
        scoreThresholdEnabled: retrieval.scoreThresholdEnabled,
        weightConfig: retrieval.weightConfig,
        rerankConfig: retrieval.rerankConfig,
      },
    };
    setConfigMutation.mutate(dto);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="text-muted-foreground">加载中...</span>
      </div>
    );
  }

  return (
    <PageContainer>
      <div className="min-w-0 space-y-6 pb-6">
        <h1 className="text-xl font-semibold">知识库设置</h1>

        <div className="space-y-2">
          <Label>发布到广场免审核</Label>
          <div className="flex items-center gap-2">
            <Switch
              checked={squarePublishSkipReview}
              onCheckedChange={setSquarePublishSkipReview}
            />
            <span className="text-muted-foreground text-sm">
              {squarePublishSkipReview ? "已开启，发布直接上架" : "已关闭，发布需管理员审核"}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Label>知识库初始空间</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={initialStorageMb}
              onChange={(e) => setInitialStorageMb(Number(e.target.value) || 1)}
              className="w-full sm:w-90"
            />
            <span className="text-muted-foreground text-sm">M</span>
          </div>
        </div>

        <div className="space-y-2">
          <Label>
            Embedding 模型 <span className="text-destructive">*</span>
          </Label>
          <ModelSelector
            modelType="text-embedding"
            value={embeddingModelId || undefined}
            onSelect={setEmbeddingModelId}
            placeholder="请选择模型"
            triggerVariant="button"
            className="w-full text-left sm:w-90"
          />
        </div>

        <div className="space-y-2">
          <Label>摘要模型</Label>
          <ModelSelector
            modelType="llm"
            value={textModelId || undefined}
            onSelect={setTextModelId}
            placeholder="请选择模型（可选）"
            triggerVariant="button"
            className="w-full text-left sm:w-90"
          />
          <p className="text-muted-foreground text-sm">
            用户上传知识库文件后，AI 自动生成摘要内容，摘要计费随模型动态计费
          </p>
        </div>

        <RetrievalConfigSection value={retrieval} onChange={setRetrieval} />

        <PermissionGuard permissions="datasets-config:set">
          <div className="bg-background sticky bottom-0 z-2 flex justify-start py-4">
            <Button onClick={handleSave} disabled={setConfigMutation.isPending}>
              {setConfigMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </div>
        </PermissionGuard>
      </div>
    </PageContainer>
  );
};

export default DatasetsConfigPage;
