# documents（Word 文档·内置插件）

面向 DOCX 的 Word 文档制作技能，**随安装包内置**（SEA 资产 → 本地插件缓存），不经过插件
市场 CDN 下载；内网（无公网）环境下装完即可用，升级跟随 Reactor-Work 发布节奏，不再
受 `cdn-zcode.z.ai` 市场通道影响。

## 为什么从市场插件改为仓库内置

部署环境为内外网隔离的公司内网：市场 seed 走 `cdn-zcode.z.ai`，断网时四件套会退化为
不可用。本插件与其余三个办公插件（pdf / presentations / spreadsheets）一并 fork 进
`apps/zcode-cli/packages/*-plugin`，并登记进 `packages/cli/scripts/sea-official-plugin-assets.mjs`
的 `officialSeaPlugins` 清单，构建期作为 SEA 资产打包，启动时 seed 到本地缓存。
边界与分层规则见 `docs/已完成/已完成-内网办公四件套-fork-spec.md`。

## 目录

```
.zcode-plugin/plugin.json        插件清单（version 0.1.7，与 definition/SEA 清单对齐）
agents/visual-judge.md           渲染页视觉验收 Agent（只读，逐页 pass/fail 判决）
skills/docx/
  SKILL.md                       315 行入口：路由 → 场景 → design-system → 质检清单
  routes/                        create / edit / format / read / comment 五条路线
  scenes/                        academic / contract / copywriting / exam / official-doc / report / resume
  references/                    design-system（R1–R7 封面配方）、docx-js、OOXML、TOC、图表、公式
  scripts/                       postcheck.py、add_toc_placeholders.py、fix_footer_fields.py、document.py
  env_setup/                     环境检查与安装（Python 依赖 / LibreOffice / 字体）
  LICENSE.txt                    Z.ai 专有许可：仅限个人、教育与非商业使用；产品方内部使用
```

## 离线边界

技能内容是纯文本、随包分发；**运行时依赖（python-docx、LibreOffice、字体）尚未离线化**，
属于 `docs/已完成/已完成-内网办公四件套-fork-spec.md` 的 Phase 2 决策项（内置引擎 vs Node 化），
在完成前内网环境的渲染/转换链路按 env_setup 的 on-demand 规则报告依赖缺失。
