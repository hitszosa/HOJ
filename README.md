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
├── service.py            # FastAPI 后端服务（业务逻辑、鉴权、HOJ 数据库连接、本地题库 API、AI 接口）
├── requirements.txt      # 后端依赖配置
├── schema/               # 教学域 MySQL/SQLite 表结构迁移脚本
├── data/
│   ├── problem_sets/     # 本地 2,148 题结构化 YAML 题单与索引
│   └── seed/             # 种子数据
├── docs/                 # 系统集成契约与对接规范
├── tests/                # 后端自动化测试套件 (141 tests)
├── tools/                # 运维与数据导入工具
└── web/                  # Next.js 15 现代化全栈前端
    ├── src/app/          # App Router 页面入口与全局布局
    ├── src/components/   # 核心组件库 (Platform, Workspace, JudgeDetailView, CategoryTreeView, TrialPanel...)
    ├── src/test/         # 前端 Vitest 测试集 (29 tests，含 Design Token 纯净度守卫)
    └── package.json
```

---

## 🚀 快速启动指南

### 1. 环境准备
- **Python**: 3.10+
- **Node.js**: 18.0+
- **HOJ 运行环境**: MySQL 数据库已就绪（配置账号密码）

### 2. 后端服务启动 (`FastAPI`)
```bash
# 进入工程根目录
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 配置环境变量（可参考 schema/ 引导数据库配置）
export DB_HOST=127.0.0.1
export DB_USER=root
export DB_PASS=your_password
export DB_NAME=jol

# 启动后端 API（监听 8100 端口）
python -m uvicorn service:app --host 127.0.0.1 --port 8100
```

### 3. 前端界面启动 (`Next.js`)
```bash
cd web

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
# 后端回归测试 (141 tests)
source .venv/bin/activate
python -m unittest discover -s tests

# 前端回归与设计规范测试 (29 tests)
cd web
npx vitest run
```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权开源。
