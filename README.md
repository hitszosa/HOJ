# HOJ (HITSZ Online Judge) 教学平台

基于 HOJ 底层判题能力的现代化校内编程作业与程序设计教学实验平台。提供学生沉浸式编程工作台、教师题库编排与多班级学情管理体系。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg)](https://fastapi.tiangolo.com/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Tests: 170 Passed](https://img.shields.io/badge/Tests-170%20Passed-brightgreen.svg)]()

---

## 🌟 平台核心特性

### 1. 2×2 对称等高矩阵编程工作台 (Student Workbench)
- **四象限黄金布局**：
  - **左上·题目要求**：GFM 标准 Markdown 渲染，内置 KaTeX 数学公式解析，样例输入/输出卡片。
  - **右上·我的代码**：Ace 代码编辑器，支持自适应动态纵向延展（消除空白死区）、作业允许语言约束校验、正式提交判题。
  - **左下·提交前自测**：不消耗提交次数，基于标准输入 stdin 运行快速自测，提供运行输出与预期样例的即时对照。
  - **右下·学习反馈**：AI 1/2/3 级循序启发式学习提示，判题事实与针对性诊断建议。
- **独立内部平滑滚动**：四块卡片在行内通过 CSS Grid 绝对等高对齐，各自正文区使用 `flex-1 overflow-y-auto min-h-0` 独立滚动，避免长题干或多测试点拉扯整体页面。

### 2. 评测节点详情结构化展现 (`JudgeDetailView`)
- 深度适配 HOJ 评测机输出，自动解析 `filename|size|result|memory|time` 测试点日志；
- 转换为结构化评测表格，提供总通过率徽章、耗时、内存占用及 `AC` / `WA` / `TLE` / `MLE` / `RE` 语义状态徽章；
- 兼顾 GCC / G++ 等编译器报错文本，平滑降级为终端代码块诊断。

### 3. 全景分类题库树与算法思维导图 (`CategoryTreeView`)
- **本地化完整题库**：收录 5 大知识支柱、48 个知识分类、2,148 道精选试题（涵盖算法基础、数据结构、DP、数论、蓝桥杯与等级认证真题）；
- **双模可视化**：
  - **模式 1：折叠目录树 + 题流速览器**：双栏工作台，支持关键词检索、难度过滤（入门~高级）、一键展开/折叠及快速题面试听；
  - **模式 2：ECharts 算法思维导图**：辐射状思维导图漫游，滚轮缩放与拖拽，点击末级节点下钻查看试题；
- **跨分类试题篮 (Basket)**：教师可在不同分类自由勾选试题，一键生成作业草稿并批量分发至选定教学班。

### 4. 教师端教学闭环与学情天梯
- **多班级批量布置**：一次选题，勾选多个教学班，一键同步生成批次；
- **允许提交语言限制**：教师在布置时限定允许的编程语言（C / C++ / Java / Python），学生工作台语言下拉菜单自动同步限制；
- **班内学情天梯榜**：严格按班级内隔离查看学情分布、提交通过率、学生做题次数与进度排行。

### 5. 双向 AI 辅助与人机协同教学安全
- **学生端**：点击时按需请求生成 1/2/3 级逐步提示，严格隔离隐藏测试用例；若已完全 AC 则直接返回规则回顾，绝不浪费模型算力；
- **教师端**：自然语言教学目标一键起草完整题单草稿（题面、公开样例、隐藏测试），严格经过教师人工审核才可发布；
- **教师总控权**：布置作业时支持随时一键关闭 AI 辅助（用于考试或严格测验）。

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
