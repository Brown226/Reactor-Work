#!/usr/bin/env sh
# Reactor 运维台（reactor-ops）一键部署/升级
#
# 用法：在 deploy/ops 目录执行  sh load-and-up.sh
#
# 与主 Web 完全独立的 compose 项目（reactor-ops），不动 reactor-web / 用户数据卷。
# 只允许平台管理员登录；普通用户会被服务端 403 拒绝。
set -e
cd "$(dirname "$0")"

COMPOSE_FILE="compose.yml"
detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    echo "==> Compose: v2（docker compose 插件）"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
    echo "==> Compose: v1（$(docker-compose version --short 2>/dev/null || echo docker-compose)）"
    { echo 'version: "2.4"'; sed '/^name:/d' compose.yml; } > .compose.v1.yml
    COMPOSE_FILE=".compose.v1.yml"
  elif command -v compose >/dev/null 2>&1; then
    COMPOSE_CMD="compose"
    { echo 'version: "2.4"'; sed '/^name:/d' compose.yml; } > .compose.v1.yml
    COMPOSE_FILE=".compose.v1.yml"
  else
    echo "!! 未找到 docker compose（v2）或 docker-compose（v1）。"
    exit 1
  fi
}
detect_compose

echo "==> 1/3 检查基础镜像 reactor-web:v1.1.1"
if ! docker image inspect reactor-web:v1.1.1 >/dev/null 2>&1; then
  if [ -n "${REACTOR_WEB_IMAGE_TAR:-}" ] && [ -f "$REACTOR_WEB_IMAGE_TAR" ]; then
    echo "    导入 $REACTOR_WEB_IMAGE_TAR"
    docker load -i "$REACTOR_WEB_IMAGE_TAR"
  elif [ -f ../web/images/reactor-web-v1.1.1.tar.gz ]; then
    echo "    导入 ../web/images/reactor-web-v1.1.1.tar.gz"
    docker load -i ../web/images/reactor-web-v1.1.1.tar.gz
  elif [ -f ../images/reactor-web-v1.1.1.tar.gz ]; then
    echo "    导入 ../images/reactor-web-v1.1.1.tar.gz"
    docker load -i ../images/reactor-web-v1.1.1.tar.gz
  else
    echo "!! 缺少基础镜像 reactor-web:v1.1.1，请先部署主 Web 端（web/load-and-up.sh）。"
    exit 1
  fi
fi

echo "==> 2/3 准备运维镜像 reactor-ops:v1.1.1（离线导入）"
# 运维镜像必须在开发机构建后随包导出：Dockerfile 需要 apt 装 docker.io 等，
# 内网离线环境现场构建必然失败（这也是 3040 打不开的最常见原因）。
if [ -n "${REACTOR_OPS_IMAGE_TAR:-}" ] && [ -f "$REACTOR_OPS_IMAGE_TAR" ]; then
  echo "    导入 $REACTOR_OPS_IMAGE_TAR"
  docker load -i "$REACTOR_OPS_IMAGE_TAR"
elif [ -f images/reactor-ops-v1.1.1.tar.gz ]; then
  echo "    导入 images/reactor-ops-v1.1.1.tar.gz"
  docker load -i images/reactor-ops-v1.1.1.tar.gz
elif docker image inspect reactor-ops:v1.1.1 >/dev/null 2>&1; then
  echo "    本地已有 reactor-ops:v1.1.1，跳过导入"
elif [ "${REACTOR_OPS_ALLOW_BUILD:-0}" = "1" ]; then
  echo "    REACTOR_OPS_ALLOW_BUILD=1 → 现场构建（需要外网 apt，仅开发机使用）"
  docker build -t reactor-ops:v1.1.1 .
else
  echo "!! 未找到运维镜像：ops/images/reactor-ops-v1.1.1.tar.gz"
  echo "   内网离线环境不能现场构建（Dockerfile 需要 apt 联网）。"
  echo "   请使用随包的 images/reactor-ops-v1.1.1.tar.gz，" 
  echo "   或用 REACTOR_OPS_IMAGE_TAR 指定镜像 tar 路径。"
  exit 1
fi

echo "==> 3/3 启动运维台（独立项目 reactor-ops）"
$COMPOSE_CMD -p reactor-ops -f "$COMPOSE_FILE" up -d
$COMPOSE_CMD -p reactor-ops -f "$COMPOSE_FILE" ps

echo ""
echo "==> 完成。运维台入口：http://<服务器IP>:3040/"
echo "    仅平台管理员（platform_admin）可登录；普通用户会被拒绝。"
echo "    agent 以宿主机 root 视角运行：宿主根挂载在 /host，docker CLI 已直连宿主。"
echo "    不用时执行 docker compose -p reactor-ops down 关闭。"
