// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/tools/inline-citation.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
"use client";

import {
  InlineCitation as InlineCitationRoot,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationSource,
} from "../../../ui/components/ai-elements/inline-citation";
import { Badge } from "../../../ui/components/ui/badge";
import { HoverCardTrigger } from "../../../ui/components/ui/hover-card";
import { memo, useMemo } from "react";

import type { KnowledgeReferenceItem } from "./knowledge-references";

export interface InlineCitationProps {
  index: number;
  references: KnowledgeReferenceItem[];
}

export const InlineCitation = memo(function InlineCitation({
  index,
  references,
}: InlineCitationProps) {
  const ref = useMemo(() => references.find((r) => r.index === index), [references, index]);

  if (!ref) {
    return <sup className="text-muted-foreground text-[10px]">[{index}]</sup>;
  }

  const title = ref.title || ref.source || "Unknown";
  const url = ref.href ?? ref.sourceUrl;

  return (
    <InlineCitationRoot>
      <InlineCitationCard>
        <HoverCardTrigger asChild>
          <Badge className="ml-1 rounded-full" variant="secondary">
            {index}
          </Badge>
        </HoverCardTrigger>
        <InlineCitationCardBody>
          <InlineCitationCarousel>
            <InlineCitationCarouselHeader>
              <InlineCitationCarouselPrev />
              <InlineCitationCarouselNext />
              <InlineCitationCarouselIndex />
            </InlineCitationCarouselHeader>
            <InlineCitationCarouselContent>
              <InlineCitationCarouselItem>
                <InlineCitationSource description={ref.content} title={title} url={url} />
              </InlineCitationCarouselItem>
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitationRoot>
  );
});
