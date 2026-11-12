# pdf（PDF·内置插件）

PDF 排版制作技能（报告 / 简历 / 海报 / 封面的排版与渲染输出），**随安装包内置**
（SEA 资产 → 本地插件缓存），不经过插件市场 CDN 下载；内网环境装完即可用。

## 为什么从市场插件改为仓库内置

部署环境为内外网隔离的公司内网：市场 seed 走 `cdn-zcode.z.ai`，断网时四件套会退化为
不可用。本插件与其余三个办公插件（documents / presentations / spreadsheets）一并 fork
进 `apps/zcode-cli/packages/*-plugin`，并登记进
`packages/cli/scripts/sea-official-plugin-assets.mjs` 的 `officialSeaPlugins` 清单。
边界与分层规则见 `docs/已完成/已完成-内网办公四件套-fork-spec.md`。

## 目录

```
.zcode-plugin/plugin.json        插件清单（version 0.1.7）
agents/visual-judge.md           渲染页视觉验收 Agent（只读，逐页 pass/fail 判决）
skills/pdf/
  SKILL.md                       1004 行入口：briefs → configs → typesetting → 质检
  briefs/                        report / resume / poster / academic / creative / process 等 8 类
  configs/                       components / fonts / visual_framework
  typesetting/                   pagination / overflow / geometry / typography / palette / cover / fill-engine
  scripts/                       design_engine.py、cover_render.py、html2pdf-next.js、html2poster.js
                                cover_validate.js、poster_validate.py、toc_validate.py、pdf_qa.py
  references/                    LaTeX 简历模板（resume-academic / resume-altacv）
  env_setup/                     环境检查与安装（Python / LibreOffice / Playwright / Tectonic / 字体）
  LICENSE.txt                    Z.ai 专有许可：仅限个人、教育与非商业使用；产品方内部使用
```

## 离线边界

技能内容随包分发；运行时依赖（Python、LibreOffice、可选 Playwright/Chromium 与
Tectonic、字体）尚未离线化，属 `docs/已完成/已完成-内网办公四件套-fork-spec.md` 的 Phase 2 决策项。
