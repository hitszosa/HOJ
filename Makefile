# 单仓库统一入口：backend/（FastAPI）与 frontend/（Next.js）。
PYTHON ?= backend/.venv/bin/python

.PHONY: install install-backend install-frontend dev-api dev-web test test-backend test-frontend typecheck

install: install-backend install-frontend

install-backend:
	test -d backend/.venv || python3 -m venv backend/.venv
	$(PYTHON) -m pip install -r backend/requirements.txt pytest

install-frontend:
	cd frontend && npm install

dev-api:
	cd backend && .venv/bin/python -m uvicorn hoj.main:app --host 127.0.0.1 --port 8100 --reload

dev-web:
	cd frontend && npm run dev -- -p 3100

test: test-backend test-frontend

test-backend:
	cd backend && .venv/bin/python -m pytest -q

test-frontend:
	cd frontend && npx vitest run

typecheck:
	cd frontend && npm run typecheck
