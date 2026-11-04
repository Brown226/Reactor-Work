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

# 中文字体（Noto CJK）：agent 生成 PDF/PPT/截图类产物时若容器无 CJK 字体，
# 中文会渲染成空白或豆腐块（2026-10-31 容器实测确认）。fontconfig 供字体发现。
# apt 源默认换国内镜像（deb.debian.org 在内网环境常不可达），可用 ARG 覆盖。
# 其余 apt 包对齐桌面安装包 bundled-tools 的能力面（2026-11-01 对齐，见
# scripts/prepare-web-image-linux-tools.mjs）：
# - libreoffice writer/calc/impress：office 四件套 skill 的文档转换引擎（解析器走 PATH）；
# - ripgrep / ugrep：agent 搜索工具（buildRuntimeToolEnvPatch 的 PATH 解析）；
# - python3 + pip：office-engines 的 skill 执行体（ocr_scan / omml 公式等）；
# - acl：每用户工作区默认 ACL（Web 宿主 root 上传的文件也要让该 UID 可读）。
ARG APT_MIRROR=mirrors.aliyun.com
RUN sed -i "s@deb.debian.org@${APT_MIRROR}@g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk fontconfig \
       libreoffice-writer libreoffice-calc libreoffice-impress \
       ripgrep ugrep python3 python3-pip acl util-linux \
       git curl unzip zip poppler-utils file \
    && rm -rf /var/lib/apt/lists/*

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
# 内置官方插件（seed 源）：bootstrap 从入口目录的 packages/<name>-plugin 找插件根。
# 不随包 stage 会导致插件市场为空、dwg_modify/parse_document/OCR 等 MCP 工具不可达
# （见 scripts/prepare-web-image-linux-plugins.mjs）。
COPY agent/packages ./agent/packages
# DWG 解析 sidecar（.NET 自包含，linux-x64）。桌面端资产树只有 win32-x64，
# 交叉发布产物由 dwg-tools-plugin 的 scripts/publish-sidecar.mjs --rid linux-x64 生成。
# 用 ZCODE_DWG_TOOLS_ASSETS_ROOT 指过去：容器内 cwd 是工作区，包内相对路径找不到 assets。
COPY agent/dwg-tools ./agent/dwg-tools
RUN chmod +x /app/agent/dwg-tools/dwg-sidecar/linux-x64/dwg-sidecar

# agent 能力资产（对齐桌面 bundled-tools，见 scripts/prepare-web-image-linux-tools.mjs）：
# - file-tools：anydoc + canvas 的 linux napi（parse_document / pdf-research 栅格化）；
# - office-engines：CJK 字体 + OCR 模型 + python 骨架与 office_skill_lib。
#   三方 Python 依赖在构建期装进 site-packages（Debian CPython 3.11 ↔ manylinux wheel），
#   容器运行时零网络、零安装。
COPY bundled-tools ./bundled-tools
# office-engines 的 Python 依赖装在自带 site-packages（--target），系统 python3 不会自动
# 把它加入 sys.path；这里生成 wrapper 而不是 symlink，保证 docx/pptx/xlsx 等 skill
# 直接调用 ZCODE_PYTHON_PATH 时也能 import 到 numpy/onnxruntime/python-pptx。
# 同时保留 symlink 的幂等性（构建上下文可能来自既有镜像的 docker cp）。
# 另外在 /usr/local/bin 放一个转发壳（PATH 优先于 /usr/bin）：agent/运维自检常直接
# 执行 `python3 -c "import numpy"`，系统解释器看不到 --target 装的依赖，会被误判为
# 「Python 资源缺失」（2026-11-04 现场自检复现）。/usr/bin/python3 保持原生，技能链路
# （ZCODE_PYTHON_PATH）与系统脚本不受影响。
RUN printf '%s\n' \
      '#!/bin/sh' \
      'export PYTHONPATH="/app/bundled-tools/linux-x64/office-engines/python/lib/python3.11/site-packages${PYTHONPATH:+:$PYTHONPATH}"' \
      'exec /usr/bin/python3 "$@"' \
      > /app/bundled-tools/linux-x64/office-engines/python/bin/python3 \
    && chmod +x /app/bundled-tools/linux-x64/office-engines/python/bin/python3 \
    && printf '%s\n' \
      '#!/bin/sh' \
      'export PYTHONPATH="/app/bundled-tools/linux-x64/office-engines/python/lib/python3.11/site-packages${PYTHONPATH:+:$PYTHONPATH}"' \
      'exec /usr/bin/python3 "$@"' \
      > /usr/local/bin/python3 \
    && chmod +x /usr/local/bin/python3 \
    && python3 -m pip install --no-cache-dir --break-system-packages \
       -i https://pypi.tuna.tsinghua.edu.cn/simple \
       -r /app/bundled-tools/linux-x64/office-engines/python/requirements-linux.txt \
       --target /app/bundled-tools/linux-x64/office-engines/python/lib/python3.11/site-packages

# 通用办公工具增量层（2026-11-04）：报告配图/统计图（matplotlib）、PDF 合并拆分
# 与水印（pypdf）、7z 压缩包（p7zip-full）、命令行 JSON（jq）。单独成层是为了
# 不破坏上面 apt/pip 的大缓存；内部镜像离线部署，这些必须随包提供。
RUN apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full jq \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages \
       -i https://pypi.tuna.tsinghua.edu.cn/simple \
       matplotlib pypdf \
       --target /app/bundled-tools/linux-x64/office-engines/python/lib/python3.11/site-packages

# CLI 的会话库 / 插件缓存用 homedir()（/root），不走 ZCODE_DATA_BASE_DIR。
# 用符号链接落到持久卷：容器重建后会话仍在；同时不改 HOME，v1 凭据密文的
# 环境推导键（platform + homedir + user）保持不变，否则旧凭据会解密失败。
ENV NODE_ENV=production \
    PORT=3030 \
    HOST=0.0.0.0 \
    ZCODE_WEB_STATIC_ROOT=/app/web-dist \
    ZCODE_DATA_BASE_DIR=/data \
    ZCODE_SERVER_WORKSPACE=/data/workspace \
    ZCODE_DWG_TOOLS_ASSETS_ROOT=/app/agent/dwg-tools \
    ZCODE_FILE_TOOLS_ASSETS_ROOT=/app/bundled-tools/linux-x64/file-tools \
    ZCODE_SKILL_ENGINE_ROOT=/app/bundled-tools/linux-x64/office-engines \
    ZCODE_WEB_USER_SANDBOX=1 \
    REACTOR_WEB_SESSION_AUTH=1 \
    REACTOR_WEB_SESSION_DB=/data/.reactor/web-sessions/sessions.sqlite \
    ZCODE_WEB_WORKER_ENTRY=/app/server-dist/entry-http.js \
    ZCODE_AGENT_SERVER_COMMAND=node \
    ZCODE_AGENT_SERVER_ARGS_JSON='["/app/agent/zcode.cjs","app-server","--stdio"]'
# ⚠ 上面这个值必须用单引号包住：Docker 的 ENV 解析会剥掉未转义的双引号，
#   写 ENV K=["a","b"] 实际得到 [a,b] —— 不是合法 JSON，agent 启动直接 JSON.parse 失败，
#   表现为「聊天一发就报 SyntaxError: Unexpected token '/'」。实测踩过。

# 工作区与数据必须落在可挂载卷内：默认值 /app 会让用户在容器里直接改应用文件。
# /data/users 711：可穿过、不可列；/data/.reactor 700：凭据/宿主会话库仅 root。
# /root/.reactor → /data/.reactor：宿主 CLI 会话库/插件缓存跟随 home，但数据落持久卷。
RUN mkdir -p /data/workspace /data/users /data/homes /data/.reactor /data/.reactor/web-sessions \
    && chmod 711 /data/users /data/homes \
    && chmod 700 /data/.reactor /data/.reactor/web-sessions \
    && rm -rf /root/.reactor \
    && ln -s /data/.reactor /root/.reactor
VOLUME ["/data"]
EXPOSE 3030

CMD ["node", "/app/server-dist/entry-http.js"]
