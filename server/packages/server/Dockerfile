# 注意：这里**故意不写 `# syntax=docker/dockerfile:1`**。
# 该指令会强制 Docker 去拉取「前端镜像」（14MB），在慢网络下实测卡住 273 秒仅 1MB，
# 而本文件没有使用任何 BuildKit 专有语法（RUN --mount / heredoc 等），
# 用内置前端即可 —— 去掉后构建不再依赖该次网络拉取。
#
# Reactor 服务端镜像（身份服务 :8791 + 网关 :8790 共用）
#
# ⚠ 历史注释已修正：本文件曾声称「`packages/server/dist` 是**自包含**的 —— 实测零
#   `@reactor/shared` 运行时引用」。该结论**自 skills / agents 两个模块引入值导入起已不成立**
#   （如 SKILL_CATEGORIES、AGENT_NAME_PATTERN、可见性/作用域常量）—— 类型导入会被擦除，
#   值导入不会。若镜像里不放 shared，容器启动即 `ERR_MODULE_NOT_FOUND: @reactor/shared`。
#   故下方单独拷一层 shared（它无任何第三方依赖，仍然不需要 pnpm workspace）。
#
# 为什么这个镜像可以很薄：
#   1. 运行时依赖（hono / @hono/node-server / pg / ldapjs / jose / bcryptjs）
#      全部是**纯 JS**，无原生模块 —— alpine 上无需构建工具链，装完即可跑；
#   2. shared 只拷 `dist`（纯 ESM、零依赖）。
#
# 构建前请在宿主机先编译：pnpm --filter @reactor/server build 与 pnpm --filter @reactor/admin build
# （compose 里的 identity/gateway 服务已通过 depends_on 之外的方式依赖该产物）

FROM node:22-alpine

WORKDIR /app

# ---- 依赖层 ----
# 直接拿 package.json 装生产依赖；其中 `@reactor/shared: workspace:*` 是 pnpm 专属
# 协议，npm 无法解析 —— 而 dist 又确实不需要它，故先剥掉再装。
COPY packages/server/package.json /tmp/server-package.json
RUN node -e "const fs=require('fs');\
const p=JSON.parse(fs.readFileSync('/tmp/server-package.json','utf8'));\
delete p.dependencies['@reactor/shared'];\
fs.writeFileSync('/app/package.json',JSON.stringify({name:p.name,version:p.version,type:p.type,dependencies:p.dependencies},null,2));" \
 && npm install --omit=dev --no-audit --no-fund \
 && rm -f /tmp/server-package.json

# ---- 产物层 ----
COPY packages/server/dist ./dist

# ---- 共享契约层（@reactor/shared）----
# 直接当成普通 npm 包装进 node_modules：shared 的 package.json 已有 name/type/main/exports，
# 且无任何第三方依赖，所以拷 dist + package.json 就能被 Node 正常解析（无需 pnpm workspace）。
# 构建前请在宿主机先执行 pnpm --filter @reactor/shared build。
COPY packages/shared/package.json ./node_modules/@reactor/shared/package.json
COPY packages/shared/dist ./node_modules/@reactor/shared/dist

# 管理台 SPA（部署项）：identity 进程在 /admin 下静态托管它，
# 单镜像即可同时提供 API 与管理台。用 REACTOR_ADMIN_DIST 指向镜像内路径。
# 构建前请在宿主机先编译：pnpm --filter @reactor/admin build
COPY packages/admin/dist ./admin-dist
ENV REACTOR_ADMIN_DIST=/app/admin-dist

ENV NODE_ENV=production
EXPOSE 8790 8791

# 默认身份服务；网关由 compose 的 command 覆盖为 dist/index.js
CMD ["node", "dist/identity-entry.js"]
