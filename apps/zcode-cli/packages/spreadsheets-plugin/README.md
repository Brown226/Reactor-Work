# spreadsheets（电子表格·内置插件）

面向 XLSX 的表格制作技能，**随安装包内置**（SEA 资产 → 本地插件缓存），不经过插件
市场 CDN 下载；内网环境装完即可用。

## 为什么从市场插件改为仓库内置

部署环境为内外网隔离的公司内网：市场 seed 走 `cdn-zcode.z.ai`，断网时四件套会退化为
不可用。本插件与其余三个办公插件（documents / pdf / presentations）一并 fork 进
`apps/zcode-cli/packages/*-plugin`，并登记进
`packages/cli/scripts/sea-official-plugin-assets.mjs` 的 `officialSeaPlugins` 清单。
边界与分层规则见 `docs/已完成/已完成-内网办公四件套-fork-spec.md`。

## 目录

```
.zcode-plugin/plugin.json        插件清单（version 0.1.7）
agents/visual-judge.md           渲染页视觉验收 Agent（只读，逐页 pass/fail 判决）
skills/xlsx/
  SKILL.md                       349 行入口：场景 → engines → 质检流水线
  scenes/                        create / edit / analyze / convert / finance / finance_lite / vba / analyze-recipes / edit-patterns
  engines/                        chart.md、chart-templates.md、vba-templates.md、design.md
  templates/                     base.py、palettes.py
  xlsx.py                        表格生成主脚本
  env_setup/                     环境检查与安装（Python / LibreOffice / 字体）
  quality/pipeline.md            质检流水线
  LICENSE.txt                    Z.ai 专有许可：仅限个人、教育与非商业使用；产品方内部使用
```

## 能力边界

覆盖「从无到有」的表格制作（公式 / 图表 / 财务场景 / VBA）。**既有表格的确定性编辑**
（单元格级读写、透视、图表更新）不在技能射程内，规划以 exceljs 自建 JS 版 MCP 工具
补位（参照 haris-musa/excel-mcp-server 的 25 工具清单），见
`docs/已完成/已完成-内网办公四件套-fork-spec.md` 后续项。
