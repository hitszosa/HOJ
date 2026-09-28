# HOJ (HITSZ Online Judge) 教学平台

基于 HOJ 底层判题能力的现代化校内编程作业与程序设计教学实验平台。提供学生沉浸式编程工作台、教师题库编排与多班级学情管理体系。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg)](https://fastapi.tiangolo.com/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Tests: 170 Passed](https://img.shields.io/badge/Tests-170%20Passed-brightgreen.svg)]()

---

## 🏗️ 架构概览

```
├── Makefile              # 统一入口：make install / dev-api / dev-web / test
├── backend/              # FastAPI 课程服务
│   ├── hoj/
│   │   ├── main.py       # 应用组装：中间件与路由挂载
│   │   ├── config.py     # backend/.env 加载与路径
│   │   ├── auth.py       # 身份解析（SSO 头 / HUSTOJ 原生会话 / 开发登录）
│   │   ├── api/          # 路由层，按领域拆分（offerings、batches、submissions、drafts…）
│   │   ├── services/     # 业务逻辑（权限闸、题库、出题发布、AI 学习建议…）
│   │   ├── hustoj/       # HUSTOJ 适配层（会话协议、测试点写入、状态码）
│   │   ├── infra/        # 数据库执行器、签名密钥、进程锁
│   │   └── hoa.py        # HOA 公开导出红线与课程映射（亦可 python -m hoj.hoa）
│   ├── schema/           # 教学域 MySQL 表结构迁移脚本
│   ├── data/
│   │   ├── problem_sets/ # 本地 2,148 题结构化 YAML 题单与索引
│   │   └── seed/         # 种子数据
│   ├── tests/            # 后端自动化测试套件
│   ├── tools/            # 运维与数据导入工具
│   └── requirements.txt
├── frontend/             # Next.js 15 前端
│   ├── src/app/          # App Router 页面入口与全局布局
│   ├── src/components/   # 核心组件库 (Platform, Workspace, JudgeDetailView, CategoryTreeView, TrialPanel...)
│   ├── src/test/         # 前端 Vitest 测试集 (含 Design Token 纯净度守卫)
│   └── package.json
├── deploy/               # 生产部署脚本、systemd 与 Nginx 配置
└── docs/                 # 系统集成契约与对接规范
```

---

## 🚀 快速启动指南

### 1. 环境准备
- **Python**: 3.10+
- **Node.js**: 18.0+
- **HOJ 运行环境**: MySQL 数据库已就绪（配置账号密码）

### 2. 后端服务启动 (`FastAPI`)
```bash
# 在仓库根目录创建 backend/.venv 并安装依赖
make install-backend

# 配置环境变量（写入 backend/.env 或直接 export；可参考 backend/schema/ 引导数据库配置）
export DB_HOST=127.0.0.1
export DB_USER=root
export DB_PASS=your_password
export DB_NAME=jol

# 启动后端 API（监听 8100 端口）
make dev-api    # 等价于 cd backend && .venv/bin/python -m uvicorn hoj.main:app --port 8100
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
