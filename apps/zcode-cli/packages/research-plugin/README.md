# research（研究·内置插件）

自主研究技能集，**随安装包内置**（SEA 资产 → 本地插件缓存），不经过插件市场 CDN
下载；脚本仅依赖 Python 标准库与免费学术 API（arXiv / Semantic Scholar / OpenAlex /
Crossref），无需 API key，内网装完即可用（按需联网）。

## 目录

```
.zcode-plugin/plugin.json        插件清单（version 0.1.0）
LICENSE.txt                      来源与授权说明（上游书面许可 2026-10-09）
skills/
  super-research/                八模式自主研究路由
    SKILL.md                     契约 → 基线 → TSV 日志 → 不停机循环 → 报告
    references/                  9 篇模式方法论（实验循环/调研/量化/对比/根因/消融/复现/写作/API 速查）
    scripts/                     paper_search / verify_citation / fetch_paper（stdlib-only）
    evals/                       5 个可跑玩具基准 + evals.json
  arxiv/                         论文级工具belt
    SKILL.md + scripts/arxiv.py  检索 / 元数据 / BibTeX / PDF 下载 / 分类日报 / 引用图谱
```

## 职责边界

- **多源检索的唯一 owner** 是 `super-research/scripts/paper_search.py`
  （arXiv+S2+OpenAlex+Crossref 去重）；arXiv 单源的深度操作（bibtex / download /
  new / cites / refs / similar）归 `arxiv/scripts/arxiv.py`，两者不互相替代。
- 只回答「把研究做完」；ZCode 自身使用问题归 zcode-guide，代码/文档评审归
  review-skills。产品规则见 `docs/未完成-研究插件-方案-v1.md`。

## 已知短板与后续项

- 上游 super-research 的 8 个 references 与 evals 为英文原版，中文场景化改写未做；
  与四件套一样保留上游原文，避免分叉。
- 断网环境下脚本按需报可读错误（网络不可达），不静默降级产出残缺证据。
