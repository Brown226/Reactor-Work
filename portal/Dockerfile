# Reactor 产品门户镜像：nginx 托管全站静态文件（官网 + 说明书）。
# 构建前先运行 node portal/manual/build.mjs 生成说明书 HTML（镜像按文件系统原样拷贝）。
# 在仓库根目录执行：docker build -t reactor-portal:<版本> portal
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html/

# busybox wget 可用；首页可达即视为健康。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
