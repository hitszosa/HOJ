# HOJ (HITSZ Online Judge) 教学平台

基于 HOJ 底层判题能力的现代化校内编程作业与程序设计教学实验平台。提供学生沉浸式编程工作台、教师题库编排与多班级学情管理体系。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![Rust](https://img.shields.io/badge/Rust-Axum%20%2B%20sqlx-orange.svg)](https://github.com/tokio-rs/axum)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Tests: 170 Passed](https://img.shields.io/badge/Tests-170%20Passed-brightgreen.svg)]()

---

## 🏗️ 架构概览

```
├── Makefile              # 统一入口：make dev-api / dev-web / test / sqlx-prepare
├── backend/              # 课程服务：Rust · Axum + sqlx（开发约定见 backend/CLAUDE.md）
│   ├── src/
│   │   ├── routes/       # 一个领域一个文件（offerings、batches、submissions、drafts…）
│   │   ├── access.rs     # 权限闸：教学班 / 题单访问控制
│   │   ├── auth.rs       # 身份解析（SSO 头 / HUSTOJ 原生会话 / 开发登录）
│   │   ├── hustoj.rs     # HUSTOJ 适配层（提交写入、自测、判题数据、状态码）
│   │   ├── authoring.rs  # 草稿与发布
│   │   └── response.rs / error.rs  # 统一信封 {code, message, data}
│   ├── .sqlx/            # sqlx 离线查询缓存（构建不需要数据库）
│   ├── schema/           # 教学域 MySQL 表结构迁移脚本
│   ├── data/problem_sets/# 本地 2,148 题结构化 YAML 题单与索引
│   ├── scripts/smoke.sh  # 端到端冒烟脚本
│   └── legacy/           # 旧 Python 版（迁移期对照，切换完成后删除）
├── frontend/             # Next.js 15 前端
│   ├── src/api/generated/# 由后端 ts-rs 生成的接口类型（cargo test 时更新）
│   ├── src/components/   # 核心组件库
│   └── src/test/         # Vitest 测试集
├── deploy/               # 生产部署脚本、systemd 与 Nginx 配置
└── docs/                 # 集成契约、迁移记录（260930-rust-migration.md）
```

---

## 🚀 快速启动指南

### 1. 环境准备
- **Rust**: 1.85+（edition 2024）
- **Node.js**: 18.0+
- **MariaDB/MySQL**: 含 HUSTOJ 的 `jol` 库与教学域 `codemind_course`（`backend/schema/`），排序规则均为 `utf8mb4_general_ci`

### 2. 后端服务启动
```bash
# backend/.env 示例
#   COURSE_DB_HOST=127.0.0.1  COURSE_DB_PASSWORD=...  COURSE_OPS_PASSWORD=...
#   COURSE_DEV_LOGIN=1                      # 仅本地开发
#   DATABASE_URL=mysql://...                # 可选：sqlx 编译期在线校验 SQL
make dev-api      # 监听 127.0.0.1:8100
make test-backend # 单元测试 + HTTP 测试，并重新生成前端类型
```

### 3. 前端界面启动 (`Next.js`)
```bash
cd frontend

# 安装依赖
npm install

# 运行测试确保样式与逻辑无误
npm test

# 生产环境编译与启动（监听 3100 端口）
npm run build
npm run start -p 3100
```

访问 `http://localhost:3100` 即可体验平台。

---

## 🧪 自动化测试验证

```bash
# 前后端全部测试
make test

# 或分别运行
make test-backend     # cd backend && .venv/bin/python -m pytest -q
make test-frontend    # cd frontend && npx vitest run
```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权开源。
