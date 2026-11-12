# Reactor 运维台镜像（reactor-ops）
#
# 基于交付用的 reactor-web 镜像，额外装宿主机运维需要的命令行工具：
# docker CLI（通过挂载宿主 /var/run/docker.sock 管容器）、进程/网络/文件排障工具。
#
# ⚠ 该镜像刻意以最高权限运行（privileged + pid:host + 宿主 / 挂载 + docker.sock），
# 只允许平台管理员登录（REACTOR_WEB_ADMIN_ONLY=1）。不要用它跑普通用户流量。
#
# 构建：docker build -t reactor-ops:v<version> deploy/ops
# 基础镜像默认 reactor-web:v<version>，可用 --build-arg BASE_IMAGE=... 覆盖。
ARG BASE_IMAGE=reactor-web:v1.1.1
FROM ${BASE_IMAGE}

USER root

# docker.io 提供 docker CLI（容器内只作客户端，daemon 仍跑在宿主机）；
# procps/iproute2/lsof 用于看进程、端口、句柄——磁盘爆满排查的常用组合。
# p7zip-full/jq 基础镜像已有，不重复。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       docker.io procps iproute2 lsof less nano \
    && rm -rf /var/lib/apt/lists/*

# 运维台的默认工作区是宿主根（挂载到 /host），agent 一进来就在服务器视角。
ENV ZCODE_SERVER_WORKSPACE=/host \
    REACTOR_WEB_ADMIN_ONLY=1 \
    REACTOR_WEB_PRIVILEGED=1 \
    ZCODE_WEB_USER_SANDBOX=0 \
    PORT=3040

EXPOSE 3040
