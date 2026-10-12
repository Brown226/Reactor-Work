# Reactor 产品门户（官网 + 说明书）

面向使用者与管理员的**离线静态站点**，内容源在仓库根 `portal/`，构建成 Docker 镜像（nginx:alpine）发布到内网。门户已作为 `portal` 服务写入 `server/packages/server/docker/compose.yml`，随服务端全栈 `pnpm docker:up` 一键起，与 identity 同网络、数据互通（下载面与更新日志反代）；它与服务端仍**各自独立构建**，改门户不需要重发服务端镜像。

| 入口 | 内容 |
| --- | --- |
| [`index.html`](index.html) | **官网首页**：Hero + 下载入口 + 应用窗口演示、核心能力、本仓特有 |
| [`changelog.html`](changelog.html) | **更新日志**：v1.0.0 基线静态维护，基线之后由服务端同步 |
| [`manual/index.html`](manual/index.html) | **产品说明书**：6 组 34 页，依据当前检出的源码整理 |

## 结构

```text
portal/
├── index.html          # 官网首页（深色单页，纯 HTML/CSS，无脚本）
├── changelog.html      # 更新日志（内含拉取服务端发布说明的渐进增强脚本）
├── assets/
│   ├── site.css        # 官网唯一样式来源（深色主题，含响应式与日志页样式）
│   └── icon.png        # 站点图标 favicon（浏览器标签页；官网顶栏/页脚品牌为纯文字字标，不用位图）
├── manual/             # 产品说明书（离线多页站点）
│   ├── pages/*.md      # 内容源（入库）
│   ├── *.html          # 构建产物（不入库，index.html 除外）
│   ├── assets/         # 样式、脚本与截图（assets/img/）
│   ├── build.mjs       # 构建脚本：pages/*.md → *.html
│   ├── check.mjs       # 内容自检：外链 / 禁用内容 / 路径口径 / 链接可达
│   ├── verify-html.mjs # 产物自检：结构与全部链接
│   ├── smoke-render.mjs# 真实浏览器渲染冒烟（需本机 Chrome）
│   ├── README.md       # 说明书站点说明
│   └── AUTHORING.md    # 编写规范（改任何页面之前先读）
├── Dockerfile          # 镜像：nginx:alpine 托管全站静态文件
├── nginx.conf          # 站点配置（UTF-8、gzip、缓存头、下载面反代）
└── README.md           # 本文件
```

## 镜像构建与部署

```bash
# 1. 先构建说明书 HTML（镜像直接拷贝文件系统，产物缺失就不会出现在站点里）
node portal/manual/build.mjs

# 2. 构建镜像（版本号与根 package.json 保持一致）
docker build -t reactor-portal:v1.0.0 portal

# 3. 本机验证
docker run --rm -p 8080:80 reactor-portal:v1.0.0
# 浏览器打开 http://localhost:8080/（官网）与 /manual/（说明书）

# 4. 发布到内网：门户已内置在服务端编排里，随全栈一键起
cd server && pnpm docker:up        # 起 pg + ldap + identity + gateway + portal 全栈
#   门户与服务端同处 reactor-desktop 网络，下载面反代直接解析到 identity，
#   数据（updates 卷 / app_release）天然互通。
#
#   —— 若要单独部署门户（与 identity 不同网），才需要镜像导出：
#   docker save reactor-portal:v1.0.0 -o reactor-portal-v1.0.0.tar
#   导入目标机器后单跑容器，并改 nginx.conf 的 $reactor_origin 指向可达地址。
```

镜像只包含静态文件与 nginx，**不含任何业务状态、凭据与构建工具**；升级门户 = 换镜像 tag（`docker compose -f packages/server/docker/compose.yml up -d --build portal`），服务端不重启也不受影响。

### 首页下载入口与更新日志的部署前提

官网首页的「下载 Reactor」按钮用**同源相对路径** `/download`，`changelog.html` 从 `/api/v1/releases/changelog` 拉服务端发布说明，两者都由 `nginx.conf` 反代到服务端 identity 的更新下发面（`/download`、`/api/v1/releases/published`、`/api/v1/releases/changelog`、安装包产物）。这带来一个前提：

- **门户需能访问到服务端**。门户已作为 `portal` 服务写进 `server/packages/server/docker/compose.yml`，与 identity 同处 `reactor-desktop` 默认网络，上游容器名 `identity:8791` 直接可解析——**无需任何额外配置**。
- 只有**单独部署门户**（脱离服务端编排、与 identity 不同网）时，才需要改 `nginx.conf` 里 `$reactor_origin` 一行（如 `10.x.x.x:8791`）。
- 上游解析不到或服务端未起时，**门户照常运行**：下载相关路径返回 502，更新日志页**静默保留 v1.0.0 静态基线**，均不影响官网与说明书的静态浏览。

> 之所以走反代而非在页面里写死地址：门户是纯静态站点，写死内网地址既违反"不出现内网地址"的内容纪律，也会让门户镜像与具体环境绑定。
> 更新日志脚本用**渐进增强**：门户写的是静态基线条目，脚本只是往上方追加服务端版本；无服务端也完整可读。

## 维护

- **说明书**：内容源是 `manual/pages/*.md`，构建与自检：

```bash
node portal/manual/build.mjs         # 生成全部 HTML
node portal/manual/check.mjs         # 内容自检
node portal/manual/verify-html.mjs   # 产物自检
node portal/manual/smoke-render.mjs  # 浏览器渲染冒烟
```

  写作口径、截图占位、`related` / `last-verified` 用法见 [`manual/AUTHORING.md`](manual/AUTHORING.md)。

- **官网**：Hero 应用窗口是纯 HTML/CSS 静态演示，界面大改时同步调整；版本号出现在公告条、页脚与更新日志，来自根 `package.json` 的 `version`，发版时手动同步。更新日志页只静态维护 **v1.0.0 基线**，之后的版本由服务端同步（发版时在管理台填写更新说明即可）。
- **内容纪律**：只写本仓提供的能力；不出现外链、套餐权益、社群入口、其他产品名。
- 两站互链是相对路径（官网卡片 → `manual/<页面>.html`），同处一个镜像内天然可达。
- 本目录不在 `pnpm-workspace.yaml` 内，不参与本仓 lint / typecheck / 架构门禁。
