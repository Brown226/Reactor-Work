#!/usr/bin/env bash
# 自签证书生成（仅内网试点用；正式环境应替换为企业 CA 签发的证书）。
#
# 用法：
#   ./gen-self-signed.sh [服务器IP或域名]
#   （缺省取参数 1，再缺省用本机 hostname）
#
# 产物：./certs/server.crt 与 ./certs/server.key（compose.https.yml 按此路径挂载）。
# 自签证书首次访问时浏览器会提示「不受信任」——内网试点可点击继续；
# 要消除提示，需把 server.crt 导入域内受信任根，或改用企业 CA 证书。
set -euo pipefail

# Git Bash (Windows) 会把 -subj "/CN=..." 当成 Unix 路径改写成 "E:/Git/CN=..."，
# 导致 openssl 报「subject name is not in the expected format」。关闭该改写；Linux 上无副作用。
export MSYS_NO_PATHCONV=1

HOST="${1:-$(hostname)}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$OUT_DIR"

if [[ -f "$OUT_DIR/server.crt" ]]; then
  echo "[certs] 已存在 $OUT_DIR/server.crt，跳过（重新生成请先删除）"
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$OUT_DIR/server.key" \
  -out "$OUT_DIR/server.crt" \
  -subj "/CN=${HOST}" \
  -addext "subjectAltName=DNS:${HOST},DNS:localhost,IP:127.0.0.1" \
  >/dev/null 2>&1

chmod 600 "$OUT_DIR/server.key"
echo "[certs] 已生成：$OUT_DIR/server.crt / server.key（CN=${HOST}）"
echo "[certs] 提醒：SAN 里只带了 ${HOST} / localhost / 127.0.0.1；"
echo "[certs] 若用户会用其它 IP 或域名访问，请重新生成并在 -addext 里补上对应 IP:xx 或 DNS:xx。"
