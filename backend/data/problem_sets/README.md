# HOA 独立题单中心 (HITSZ-OpenAuto Problem Sets)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Format: HOA-YAML](https://img.shields.io/badge/Schema-HOA--YAML--v1-brightgreen.svg)](index/matrix.md)
[![Problems: 1167](https://img.shields.io/badge/Problems-1167-orange.svg)](index/catalog.json)

本项目是哈工大（深圳）**HITSZ-OpenAuto (HOA)** 计算机学科与工科自动化专业的公开编程题库与题单中心。

---

## 🎯 核心特性

- **多维多对多分类架构**：打破传统单一来源分类，建立 **难度 (L1~L5)** × **知识种类 (24类)** × **细粒度标签** × **对应大学课程 (9门)** 的多对多拓扑网络。
- **与 HOA 官方攻略无缝联动**：精准映射 `HITSZ-OpenAuto/<课程代码>` 攻略仓库，支持教师一键按教学大纲调取题单。
- **严格遵循平台五条安全红线**：所有题单通过 `service.validate_document` 与 `hoa.check_export` 双重校验，白名单字段安全重建，零测试用例外泄。
- **极速检索 CLI**：内置 `search.py`，支持毫秒级按课程代码、知识点、难度、出处多维联合检索。

---

## 📚 覆盖大学课程与映射关系 (9 门课程)

| 课程代码 | 课程名称 | 学分 | 题单目录 | 对应 HOA 攻略库 |
|---|---|---|---|---|
| `COMP1007` | 程序设计基础 | 4.0 | [`problems/courses/COMP1007/`](./problems/courses/COMP1007/) | [HITSZ-OpenAuto/COMP1007](https://github.com/HITSZ-OpenAuto/COMP1007) |
| `COMP1011` | 程序设计思维与实践 | 4.0 | [`problems/courses/COMP1011/`](./problems/courses/COMP1011/) | [HITSZ-OpenAuto/COMP1011](https://github.com/HITSZ-OpenAuto/COMP1011) |
| `COMP2001` | 计算机专业导论 | 2.0 | [`problems/courses/COMP2001/`](./problems/courses/COMP2001/) | [HITSZ-OpenAuto/COMP2001](https://github.com/HITSZ-OpenAuto/COMP2001) |
| `COMP2012` | 计算机设计与实践 | 2.0 | [`problems/courses/COMP2012/`](./problems/courses/COMP2012/) | [HITSZ-OpenAuto/COMP2012](https://github.com/HITSZ-OpenAuto/COMP2012) |
| `COMP2014` | C++语言程序设计 | 3.0 | [`problems/courses/COMP2014/`](./problems/courses/COMP2014/) | [HITSZ-OpenAuto/COMP2014](https://github.com/HITSZ-OpenAuto/COMP2014) |
| `COMP2050` | 数据结构与算法（自动化类） | 3.5 | [`problems/courses/COMP2050/`](./problems/courses/COMP2050/) | [HITSZ-OpenAuto/COMP2050](https://github.com/HITSZ-OpenAuto/COMP2050) |
| `COMP2052` | 数据结构与算法 | 4.0 | [`problems/courses/COMP2052/`](./problems/courses/COMP2052/) | [HITSZ-OpenAuto/COMP2052](https://github.com/HITSZ-OpenAuto/COMP2052) |
| `COMP3011` | 计算机体系结构 | 3.0 | [`problems/courses/COMP3011/`](./problems/courses/COMP3011/) | [HITSZ-OpenAuto/COMP3011](https://github.com/HITSZ-OpenAuto/COMP3011) |
| `COMP3001` | 算法设计与分析 | 3.0 | [`problems/courses/COMP3001/`](./problems/courses/COMP3001/) | [HITSZ-OpenAuto/COMP3001](https://github.com/HITSZ-OpenAuto/COMP3001) |

详细的多对多映射表请查阅 [**全景矩阵文档 (index/matrix.md)**](./index/matrix.md)。

---

## 🔍 快速检索指南 (`search.py`)

在仓库根目录直接运行：

```bash
# 1. 查找某门课程的所有题目 (如 COMP1011)
python3 search.py --course COMP1011

# 2. 查找 C++ 程序设计 (COMP2014) 中栈与队列的题目
python3 search.py --course COMP2014 --category 14-stack-queue

# 3. 查找自动化类数据结构 (COMP2050) 中难度为普及级 (L3) 的题目
python3 search.py --course COMP2050 --difficulty L3

# 4. 查找体系结构 (COMP3011) 中关于矩阵访存的题目
python3 search.py --course COMP3011 --keyword 矩阵
```

---

## 📂 仓库目录结构

```
hoa-oj/
├── README.md               # 项目主说明文档
├── search.py               # 教师多维检索工具
├── index/
│   ├── catalog.json        # 全量 1,167 道题目的结构化 JSON 索引
│   └── matrix.md           # 24 知识种类 × 9 门课程多对多全景矩阵
└── problems/
    ├── categories/         # 24 个按计科知识体系归类的标准题单 (每个最多80题)
    │   ├── 01-basic-io.yml
    │   ├── ...
    │   └── 24-number-theory.yml
    └── courses/            # 9 门校内推荐教学周次与专题题单 (共 51 份)
        ├── COMP1007/       # 程序设计基础 (W01~W10)
        ├── COMP1011/       # 程序设计思维与实践 (W01~W08)
        ├── COMP2001/       # 计算机专业导论 (P01~P02)
        ├── COMP2012/       # 计算机设计与实践 (P01~P02)
        ├── COMP2014/       # C++语言程序设计 (W01~W06)
        ├── COMP2050/       # 数据结构与算法·自动化 (W01~W06)
        ├── COMP2052/       # 数据结构与算法·计科 (W01~W08)
        ├── COMP3011/       # 计算机体系结构 (P01~P02)
        └── COMP3001/       # 算法设计与分析 (B01~B07)
```
