# Reactor Server V2 —— 本地开发入口
# 上游发布 Makefile 依赖私有仓库 / 私有密钥，不适合本目录；这里只保留本地可执行目标。

.PHONY: backend-build backend-test backend-vet backend-check web-install web-typecheck web-build check

backend-build:
	cd backend && go build ./...

backend-test:
	cd backend && go test ./...

backend-vet:
	cd backend && go vet ./...

backend-check: backend-build backend-vet backend-test

web-install:
	cd web && pnpm install

web-typecheck:
	cd web && pnpm typecheck

web-build:
	cd web && pnpm build

check: backend-check web-typecheck
