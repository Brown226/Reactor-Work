# analytics（经营分析·内置插件）

产品与经营侧的量化分析技能集，**随安装包内置**（SEA 资产 → 本地插件缓存），不经过
插件市场 CDN 下载；纯 prompt 驱动、零脚本零依赖，内网装完即可用。

## 目录

```
.zcode-plugin/plugin.json        插件清单（version 0.1.0）
LICENSE.txt                      来源与授权说明（上游书面许可 2026-10-09）
skills/
  analyze-data-quality/          数据质量：口径/粒度/新鲜度/来源冲突核查
  design-kpis/                   KPI 框架：主指标/驱动指标/护栏/目标值/度量计划
  metric-diagnostics/             指标诊断：波动归因、双向排除、根因假设排序
  build-dashboard/               看板：BI 平台 / HTML / Streamlit 三种规格（specifications/）
```

## 职责边界

- **财务域归 accounting-and-reporting**（科目映射、底稿审计、台账对账、月结复核、
  报表渲染）；**产品/经营分析归本插件**。`audit-xls` 审财务底稿、
  `analyze-data-quality` 审数据资产，对象不同不重叠。
- **成品交付归四件套**：分析结论要落成 docx/xlsx/pptx/pdf 时走 documents /
  spreadsheets / presentations / pdf 插件，本插件只生产分析本身。
- 上游 data-analytics 的其余 workflow（gather-business-context / build-report /
  visualize-data / product-business-analysis 等）未随包分发，四个 SKILL.md 头部的
  `Modified by ZCode:` 边界说明已收口相关引用。产品规则见
  `docs/未完成-经营分析插件-方案-v1.md`。

## 已知短板与后续项

- 四个 SKILL.md 为上游英文原版 + 边界补丁，中文场景化改写未做；与 research 一样
  保留上游原文避免分叉。
- 上游 report-to-google-doc 等 17 个 Python 脚本未借入（Google 生态链路，内网不
  适用）；如未来要「分析结果一键成档」，走四件套创作层而非复刻上游脚本。
