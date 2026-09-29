# Reactor 产品说明书（离线站点）

本目录是一套**可离线浏览的产品说明书**，内容依据当前检出的源码改写，面向内网隔离部署环境。

## 怎么用

直接双击 `index.html` 即可浏览，不需要网络、不需要起服务。所有页面都在同一层目录，共用 `assets/manual.css` 与 `assets/manual.js`。

## 目录结构

```text
docs/manual/
├── index.html            # 站点首页（由 pages/index.md 生成）
├── *.html                # 各章节页面（由 pages/*.md 生成）
├── assets/
│   ├── manual.css        # 全站唯一样式来源
│   └── manual.js         # 窄屏目录开合 + 回到顶部
├── pages/                # 内容源：每页一个 markdown
│   └── *.md
├── build.mjs             # 构建脚本：pages/*.md → *.html
├── AUTHORING.md          # 改写规范（改任何页面之前先读）
└── README.md             # 本文件
```

## 改内容

1. 先读 [`AUTHORING.md`](AUTHORING.md)。那里定义了产品名、路径口径、删除项、事实纪律与页面结构。
2. 改 `pages/<页面>.md`。
3. 重新构建：

```bash
node docs/manual/build.mjs
```

构建输出会列出已生成的页面，以及侧栏导航里配置了但**缺少内容文件**的 slug。

> **提示**：站点导航由 `build.mjs` 顶部的 `NAV` 常量定义。新增页面时要在 `NAV` 里加一项，并建立同名 `pages/<slug>.md`；只加一边会导致构建报「缺少内容文件」。

## 维护约定

- **内容源是 `pages/*.md`，`*.html` 是产物**。不要直接编辑 HTML，下次构建会被覆盖。
- 内容涉及代码行为时，先核对源码或 `docs/已完成/`、`docs/未完成-` 下的契约，再落笔。
- 无法核实的条目写 `> **待核实**：...`，不要用推测填充。
- `build.mjs` 内置一个 markdown 子集渲染器，**不引入任何第三方依赖**（仓库里的 `marked` 等只是传递依赖，不是本仓声明依赖）。支持的语法：标题 `#`~`####`、段落、有序/无序列表、表格、围栏代码块、引用块、分隔线、行内代码/粗体/斜体/链接。
- 站内链接在源文件里写相对 `.md`（如 `[技能](skill.md)`），构建时会自动改写成 `.html`。
- 本目录不参与构建流水线，也不在 `pnpm-workspace.yaml` 内；`docs/**` 已被 `knip.json` 排除。

## 与上游的关系

内容由上游 ZCode 官方中文文档（`https://zcode.z.ai/cn/docs/*`）改写而来，但不是镜像：

- 上游是**产品形态**的描述，本说明书是**本仓源码实际行为**的描述。
- 上游的在线商业与社群内容（下载、套餐、额度、社群、Bot Channel 等）不收录。
- 本仓新增能力（界面模式、审查板块、办公四件套、模型治理、内网服务端等）单列章节。
- 逐页差异在各页末尾的「与上游 ZCode 的差异」小节；总表见 [`pages/upstream-diff.md`](pages/upstream-diff.md)。
