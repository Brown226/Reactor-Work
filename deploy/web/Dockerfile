# Reactor Web 客户端运行时镜像
#
# 组成：Web 前端静态产物 + HTTP/WS 服务端 + agent bundle。
# 身份服务与模型网关不在此镜像内，仍由既有的 reactor-desktop-server 镜像提供。
#
# 基础镜像用 Debian(bookworm) 而非 Alpine：node-pty 的预编译产物是 glibc 链接，
# 在 musl 环境下无法加载，终端能力会直接失效。
# 默认走国内镜像站；自有镜像仓库可用 --build-arg BASE_IMAGE=... 覆盖。
ARG BASE_IMAGE=docker.1ms.run/library/node:24-bookworm-slim
FROM ${BASE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

# 运行时依赖：与 packages/server/tsup.config.ts 的 external 清单一致。
# 其余依赖已被 tsup 内联进 server-dist，无需在此安装。
COPY runtime-package.json ./package.json
RUN npm install --omit=dev --registry="${NPM_REGISTRY}" && npm cache clean --force

# 服务端 bundle（已内联 @zcode/* 工作区包与内置 provider config）
COPY server-dist ./server-dist
# Web 前端静态产物（CSS 已按 Chromium 109 目标降级，兼容 Win7 浏览器）
COPY web-dist ./web-dist
# Agent 运行时：Node 24 直接执行 zcode.cjs，无需 Electron
COPY agent/zcode.cjs ./agent/zcode.cjs

ENV NODE_ENV=production \
    PORT=3030 \
    HOST=0.0.0.0 \
    ZCODE_WEB_STATIC_ROOT=/app/web-dist \
    ZCODE_DATA_BASE_DIR=/data \
    ZCODE_SERVER_WORKSPACE=/data/workspace \
    ZCODE_AGENT_SERVER_COMMAND=node \
    ZCODE_AGENT_SERVER_ARGS_JSON=["/app/agent/zcode.cjs","app-server","--stdio"]

# 工作区与数据必须落在可挂载卷内：默认值 /app 会让用户在容器里直接改应用文件。
RUN mkdir -p /data/workspace
VOLUME ["/data"]
EXPOSE 3030

CMD ["node", "/app/server-dist/entry-http.js"]
