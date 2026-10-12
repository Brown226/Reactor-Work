# Reactor 产品门户（官网 + 说明书）· 独立部署单元

面向使用者与管理员的**离线静态站点**，在仓库根目录独立成一个部署单元：**单独构建 Docker 镜像**发布到内网服务器供用户查看，与 `server/` 的服务端镜像互不牵连，改门户不需要重发服务端。

| 入口 | 内容 |
| --- | --- |
| [`index.html`](index.html) | **官网首页**：Hero + 应用窗口演示、核心能力、本仓特有、三步部署 |
| [`changelog.html`](changelog.html) | **更新日志**：自 v3.14.0 起维护 |
| [`manual/index.html`](manual/index.html) | **产品说明书**：6 组 34 页，依据当前检出的源码整理 |

## 结构

```text
portal/
├── index.html          # 官网首页（深色单页，纯 HTML/CSS，无脚本）
├── changelog.html      # 更新日志
├── assets/
│   └── site.css        # 官网唯一样式来源（深色主题，含响应式与日志页样式）
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
├── nginx.conf          # 站点配置（UTF-8、gzip、缓存头）
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

# 4. 发布到内网
docker save reactor-portal:v1.0.0 -o reactor-portal-v3.14.0.tar
# 导入内网镜像仓库或目标机器 docker load 后，在服务端 compose 里加一个服务：
#
#   portal:
#     image: reactor-portal:v1.0.0
#     ports:
#       - "8080:80"
#     restart: unless-stopped
```

镜像只包含静态文件与 nginx，**不含任何业务状态、凭据与构建工具**；升级门户 = 换镜像 tag，服务端不重启也不受影响。

## 维护

- **说明书**：内容源是 `manual/pages/*.md`，构建与自检：

```bash
node portal/manual/build.mjs         # 生成全部 HTML
node portal/manual/check.mjs         # 内容自检
node portal/manual/verify-html.mjs   # 产物自检
node portal/manual/smoke-render.mjs  # 浏览器渲染冒烟
```

  写作口径、截图占位、`related` / `last-verified` 用法见 [`manual/AUTHORING.md`](manual/AUTHORING.md)。

- **官网**：Hero 应用窗口是纯 HTML/CSS 静态演示，界面大改时同步调整；版本号出现在公告条、页脚与更新日志，来自根 `package.json` 的 `version`，发版时手动同步（更新日志条目模板见 `changelog.html` 页尾说明）。
- **内容纪律**：只写本仓提供的能力；不出现外链、套餐权益、社群入口、其他产品名。
- 两站互链是相对路径（官网卡片 → `manual/<页面>.html`），同处一个镜像内天然可达。
- 本目录不在 `pnpm-workspace.yaml` 内，不参与本仓 lint / typecheck / 架构门禁。
