# 单仓库统一入口：backend/（Rust · Axum + sqlx）与 frontend/（Next.js）。
LEGACY_PYTHON ?= backend/legacy/.venv/bin/python

.PHONY: install install-frontend dev-api dev-web build-api test test-backend test-frontend typecheck types sqlx-prepare test-legacy

install: install-frontend

install-frontend:
	cd frontend && npm install

# 开发：backend/.env 提供 DATABASE_URL 时 sqlx 在线校验 SQL；否则加 SQLX_OFFLINE=true 使用 .sqlx/ 缓存。
dev-api:
	cd backend && cargo run

dev-web:
	cd frontend && npm run dev -- -p 3100

build-api:
	cd backend && SQLX_OFFLINE=true cargo build --release --locked

test: test-backend test-frontend

# cargo test 同时重新生成前端类型 frontend/src/api/generated/。
test-backend:
	cd backend && cargo test

types: test-backend

test-frontend:
	cd frontend && npx vitest run

typecheck:
	cd frontend && npm run typecheck

# 修改 SQL 后运行（需要连到带 jol 与 codemind_course 的库），并提交 backend/.sqlx/。
sqlx-prepare:
	cd backend && cargo sqlx prepare -- --all-targets

# 旧 Python 版（迁移期对照用，完成切换后删除）。
test-legacy:
	cd backend/legacy && .venv/bin/python -m pytest -q
