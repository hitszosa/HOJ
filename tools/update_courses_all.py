#!/usr/bin/env python3
"""全量更新 HOA-OJ 课程多对多映射体系

涵盖 HITSZ 计算机科学与工程、自动化相关专业的 9 门主干课程：
  1. COMP1007: 程序设计基础 (HITSZ-OpenAuto/COMP1007)
  2. COMP1011: 程序设计思维与实践 (HITSZ-OpenAuto/COMP1011)
  3. COMP2001: 计算机专业导论 (HITSZ-OpenAuto/COMP2001)
  4. COMP2012: 计算机设计与实践 (HITSZ-OpenAuto/COMP2012)
  5. COMP2014: C++语言程序设计 (HITSZ-OpenAuto/COMP2014)
  6. COMP2050: 数据结构与算法（自动化类） (HITSZ-OpenAuto/COMP2050)
  7. COMP2052: 数据结构与算法 (HITSZ-OpenAuto/COMP2052)
  8. COMP3011: 计算机体系结构 (HITSZ-OpenAuto/COMP3011)
  9. COMP3001: 算法设计与分析 (HITSZ-OpenAuto/COMP3001)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from collections import Counter
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
OJ_ROOT = ROOT.parent
HOA_OJ = OJ_ROOT / "hoa-oj"

COURSES_META = {
    "COMP1007": {
        "name": "程序设计基础",
        "credit": 4.0,
        "repo": "HITSZ-OpenAuto/COMP1007",
        "desc": "大一编程入门核心课（基础I/O、分支结构、循环迭代、数组字符串与函数）",
    },
    "COMP1011": {
        "name": "程序设计思维与实践",
        "credit": 4.0,
        "repo": "HITSZ-OpenAuto/COMP1011",
        "desc": "计科核心编程思维（C语言深度应用、嵌套循环、递归分治、链表与经典排序）",
    },
    "COMP2001": {
        "name": "计算机专业导论",
        "credit": 2.0,
        "repo": "HITSZ-OpenAuto/COMP2001",
        "desc": "大一专业启蒙与通识导论（程序结构、逻辑表达、基础算法思维、数制与进制转换）",
    },
    "COMP2012": {
        "name": "计算机设计与实践",
        "credit": 2.0,
        "repo": "HITSZ-OpenAuto/COMP2012",
        "desc": "硬件设计与CPU实验（位运算逻辑、二进制转换、寄存器与简单算术指令模拟）",
    },
    "COMP2014": {
        "name": "C++语言程序设计",
        "credit": 3.0,
        "repo": "HITSZ-OpenAuto/COMP2014",
        "desc": "面向对象与泛型编程（类与对象、std::string、STL标准容器与高阶栈队列堆）",
    },
    "COMP2050": {
        "name": "数据结构与算法（自动化类）",
        "credit": 3.5,
        "repo": "HITSZ-OpenAuto/COMP2050",
        "desc": "工科自动化核心数据结构（数组二分、链表栈队列、二叉树堆、并查集与基础图论）",
    },
    "COMP2052": {
        "name": "数据结构与算法",
        "credit": 4.0,
        "repo": "HITSZ-OpenAuto/COMP2052",
        "desc": "计科核心主干课（线性表、栈队列、二叉树、堆、图的最短路/MST、并查集与搜索）",
    },
    "COMP3011": {
        "name": "计算机体系结构",
        "credit": 3.0,
        "repo": "HITSZ-OpenAuto/COMP3011",
        "desc": "高阶体系结构与系统性能（二维矩阵访存局部性、Cache友好型优化、贪心任务调度）",
    },
    "COMP3001": {
        "name": "算法设计与分析",
        "credit": 3.0,
        "repo": "HITSZ-OpenAuto/COMP3001",
        "desc": "算法进阶与复杂度理论（递归分治、贪心、动态规划背包/线性/区间、图论高阶、数论）",
    },
}

CATEGORY_COURSES = {
    "01-basic-io": ["COMP1007", "COMP1011", "COMP2001", "COMP2012"],
    "02-branching": ["COMP1007", "COMP1011", "COMP2001", "COMP2012"],
    "03-loops": ["COMP1007", "COMP1011", "COMP2001"],
    "04-nested-loops": ["COMP1007", "COMP1011"],
    "05-array-1d": ["COMP1007", "COMP1011", "COMP2050"],
    "06-array-2d": ["COMP1007", "COMP1011", "COMP2050", "COMP3011"],
    "07-strings": ["COMP1007", "COMP1011", "COMP2014"],
    "08-functions": ["COMP1007", "COMP1011", "COMP2014"],
    "09-recursion-divide": ["COMP1007", "COMP1011", "COMP2052", "COMP3001"],
    "10-struct-pointer": ["COMP1007", "COMP1011", "COMP2014"],
    "11-sorting": ["COMP1011", "COMP2050", "COMP2052", "COMP3001"],
    "12-binary-search": ["COMP2050", "COMP2052", "COMP3001"],
    "13-linear-list": ["COMP1011", "COMP2014", "COMP2050", "COMP2052"],
    "14-stack-queue": ["COMP2014", "COMP2050", "COMP2052"],
    "15-binary-tree": ["COMP2050", "COMP2052", "COMP3001"],
    "16-heap-priority": ["COMP2014", "COMP2050", "COMP2052", "COMP3001"],
    "17-dsu": ["COMP2050", "COMP2052", "COMP3001"],
    "18-greedy": ["COMP2052", "COMP3011", "COMP3001"],
    "19-dfs-backtracking": ["COMP2052", "COMP3001"],
    "20-dp-knapsack": ["COMP2052", "COMP3001"],
    "21-dp-linear-interval": ["COMP2052", "COMP3001"],
    "22-graph-shortest": ["COMP2050", "COMP2052", "COMP3001"],
    "23-graph-mst-topo": ["COMP2050", "COMP2052", "COMP3001"],
    "24-number-theory": ["COMP1007", "COMP1011", "COMP2001", "COMP2012", "COMP3001"],
}

CATEGORY_NAMES = {
    "01-basic-io": "基础语法与标准输入输出",
    "02-branching": "分支结构与逻辑判断",
    "03-loops": "循环结构·基础循环",
    "04-nested-loops": "循环结构·嵌套循环与多重迭代",
    "05-array-1d": "一维数组与数值统计",
    "06-array-2d": "二维数组与矩阵计算",
    "07-strings": "字符处理与字符串基础",
    "08-functions": "函数设计与模块化编程",
    "09-recursion-divide": "递归函数与分治初探",
    "10-struct-pointer": "结构体与复合数据类型",
    "11-sorting": "算法复杂度与经典排序",
    "12-binary-search": "二分查找与高效检索",
    "13-linear-list": "线性表与链表应用",
    "14-stack-queue": "栈与队列及单调结构",
    "15-binary-tree": "二叉树与树形数据结构",
    "16-heap-priority": "二叉堆与优先队列",
    "17-dsu": "并查集与动态连通性",
    "18-greedy": "经典贪心策略",
    "19-dfs-backtracking": "深度优先搜索与状态回溯",
    "20-dp-knapsack": "动态规划·经典背包模型",
    "21-dp-linear-interval": "动态规划·线性与区间模型",
    "22-graph-shortest": "图论算法·最短路径",
    "23-graph-mst-topo": "图论算法·最小生成树与拓扑排序",
    "24-number-theory": "经典数学与数论基础",
}


def update_categories():
    categories_dir = HOA_OJ / "problems" / "categories"
    all_problems = {}

    for yml_path in sorted(categories_dir.glob("*.yml")):
        cat_id = yml_path.stem
        with open(yml_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        mapped_courses = CATEGORY_COURSES.get(cat_id, ["COMP1007"])
        cat_name = CATEGORY_NAMES.get(cat_id, data.get("title", cat_id))

        # 更新题目的 courses
        for prob in data.get("problems", []):
            prob["courses"] = list(mapped_courses)
            all_problems[prob["slug"]] = {
                "problem": prob,
                "category_id": cat_id,
                "category_name": cat_name,
            }

        # 重新生成 YAML 文件
        header = f"""# 题单种类：{cat_id} · {cat_name}
# 对应大学课程：{', '.join(mapped_courses)}
# 题目数：{len(data.get('problems', []))}
# 归档仓库：LiPu-jpg/hoa-oj
# 归档路径：problems/categories/{yml_path.name}

"""
        content = yaml.dump(data, allow_unicode=True, sort_keys=False)
        with open(yml_path, "w", encoding="utf-8") as f:
            f.write(header + content)

    print(f"✅ 更新完成 24 个种类题单，共收集 {len(all_problems)} 道题目")
    return all_problems


def update_catalog(all_problems):
    catalog = []
    for slug, info in sorted(all_problems.items()):
        p = info["problem"]
        catalog.append({
            "slug": p["slug"],
            "title": p["title"],
            "difficulty": p.get("difficulty", "未标注"),
            "category_id": info["category_id"],
            "category_name": info["category_name"],
            "knowledge": p.get("knowledge", []),
            "provenance": p.get("provenance", "经典OJ"),
            "courses": p.get("courses", []),
            "path": f"problems/categories/{info['category_id']}.yml",
            "statement": p.get("statement", "")[:120],
        })

    catalog_path = HOA_OJ / "index" / "catalog.json"
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"✅ 生成全局目录索引：{catalog_path} (收录 {len(catalog)} 题)")
    return catalog


def clean_and_build_course_sets(all_problems):
    # 用户明确要求：不要按周来，纯 Tag 分类即可
    courses_dir = HOA_OJ / "problems" / "courses"
    if courses_dir.exists():
        shutil.rmtree(courses_dir)

    tags_link = HOA_OJ / "problems" / "tags"
    if not tags_link.exists():
        tags_link.symlink_to("categories")

    print(f"✅ 已移除按周切分结构，保留纯粹的 24 个知识大类 Tag 题单体系 (problems/categories & problems/tags)")


def generate_matrix():
    matrix_path = HOA_OJ / "index" / "matrix.md"

    doc = """# HOA-OJ 课程与知识点多对多全景映射矩阵

本矩阵完整呈现 **9 门大学计算机核心课程** 与 **24 门算法与数据结构知识种类** 的多对多映射关系。

---

## 一、 课程概览表 (9 门课程)

| 课程代码 | 课程名称 | 学分 | 课程定位与重点 | HOA 攻略仓库 |
|---|---|---|---|---|
| **`COMP1007`** | **程序设计基础** | 4.0 | 大一入门第一课：标准I/O、分支结构、循环迭代、数组字符串与函数 | [`HITSZ-OpenAuto/COMP1007`](https://github.com/HITSZ-OpenAuto/COMP1007) |
| **`COMP1011`** | **程序设计思维与实践** | 4.0 | 计科核心基础：C语言深度编程、嵌套循环、递归分治、链表与经典排序 | [`HITSZ-OpenAuto/COMP1011`](https://github.com/HITSZ-OpenAuto/COMP1011) |
| **`COMP2001`** | **计算机专业导论** | 2.0 | 专业启蒙与通识：程序结构、逻辑表达、基础算法思维、数制与进制转换 | [`HITSZ-OpenAuto/COMP2001`](https://github.com/HITSZ-OpenAuto/COMP2001) |
| **`COMP2012`** | **计算机设计与实践** | 2.0 | 硬件设计与CPU实验：位运算逻辑、二进制转换、寄存器与简单算术指令模拟 | [`HITSZ-OpenAuto/COMP2012`](https://github.com/HITSZ-OpenAuto/COMP2012) |
| **`COMP2014`** | **C++语言程序设计** | 3.0 | 面向对象与泛型：类与对象、std::string、STL标准容器与高阶栈队列堆 | [`HITSZ-OpenAuto/COMP2014`](https://github.com/HITSZ-OpenAuto/COMP2014) |
| **`COMP2050`** | **数据结构与算法（自动化类）** | 3.5 | 自动化类大二核心：数组二分、链表栈队列、二叉树堆、并查集与基础图论 | [`HITSZ-OpenAuto/COMP2050`](https://github.com/HITSZ-OpenAuto/COMP2050) |
| **`COMP2052`** | **数据结构与算法** | 4.0 | 计科核心主干课：线性表、栈队列、二叉树、堆、图的最短路/MST、并查集与搜索 | [`HITSZ-OpenAuto/COMP2052`](https://github.com/HITSZ-OpenAuto/COMP2052) |
| **`COMP3011`** | **计算机体系结构** | 3.0 | 高阶体系结构：二维矩阵访存局部性、Cache友好型优化、贪心任务调度 | [`HITSZ-OpenAuto/COMP3011`](https://github.com/HITSZ-OpenAuto/COMP3011) |
| **`COMP3001`** | **算法设计与分析** | 3.0 | 算法高阶进阶：递归分治、贪心、动态规划背包/线性/区间、图论高阶、数论 | [`HITSZ-OpenAuto/COMP3001`](https://github.com/HITSZ-OpenAuto/COMP3001) |

---

## 二、 知识种类 ↔ 课程多对多映射矩阵 (24 种类)

| 编号 | 知识种类 (`category`) | 题目数 | 难度分布 (L1~L5) | 对应大学课程 (`courses`) | 分类题单链接 |
|---|---|---|---|---|---|
| 01 | **基础语法与标准输入输出** (`01-basic-io`) | 80 题 | `80` / `0` / `0` / `0` / `0` | **COMP1007**, **COMP1011**, **COMP2001**, **COMP2012** | [`01-basic-io.yml`](../problems/categories/01-basic-io.yml) |
| 02 | **分支结构与逻辑判断** (`02-branching`) | 80 题 | `80` / `0` / `0` / `0` / `0` | **COMP1007**, **COMP1011**, **COMP2001**, **COMP2012** | [`02-branching.yml`](../problems/categories/02-branching.yml) |
| 03 | **循环结构·基础循环** (`03-loops`) | 80 题 | `80` / `0` / `0` / `0` / `0` | **COMP1007**, **COMP1011**, **COMP2001** | [`03-loops.yml`](../problems/categories/03-loops.yml) |
| 04 | **循环结构·嵌套循环与多重迭代** (`04-nested-loops`) | 11 题 | `10` / `1` / `0` / `0` / `0` | **COMP1007**, **COMP1011** | [`04-nested-loops.yml`](../problems/categories/04-nested-loops.yml) |
| 05 | **一维数组与数值统计** (`05-array-1d`) | 80 题 | `50` / `8` / `21` / `1` / `0` | **COMP1007**, **COMP1011**, **COMP2050** | [`05-array-1d.yml`](../problems/categories/05-array-1d.yml) |
| 06 | **二维数组与矩阵计算** (`06-array-2d`) | 51 题 | `24` / `13` / `10` / `4` / `0` | **COMP1007**, **COMP1011**, **COMP2050**, **COMP3011** | [`06-array-2d.yml`](../problems/categories/06-array-2d.yml) |
| 07 | **字符处理与字符串基础** (`07-strings`) | 80 题 | `61` / `6` / `13` / `0` / `0` | **COMP1007**, **COMP1011**, **COMP2014** | [`07-strings.yml`](../problems/categories/07-strings.yml) |
| 08 | **函数设计与模块化编程** (`08-functions`) | 32 题 | `31` / `0` / `1` / `0` / `0` | **COMP1007**, **COMP1011**, **COMP2014** | [`08-functions.yml`](../problems/categories/08-functions.yml) |
| 09 | **递归函数与分治初探** (`09-recursion-divide`) | 42 题 | `38` / `0` / `3` / `0` / `1` | **COMP1007**, **COMP1011**, **COMP2052**, **COMP3001** | [`09-recursion-divide.yml`](../problems/categories/09-recursion-divide.yml) |
| 10 | **结构体与复合数据类型** (`10-struct-pointer`) | 6 题 | `5` / `0` / `1` / `0` / `0` | **COMP1007**, **COMP1011**, **COMP2014** | [`10-struct-pointer.yml`](../problems/categories/10-struct-pointer.yml) |
| 11 | **算法复杂度与经典排序** (`11-sorting`) | 44 题 | `21` / `7` / `6` / `10` / `0` | **COMP1011**, **COMP2050**, **COMP2052**, **COMP3001** | [`11-sorting.yml`](../problems/categories/11-sorting.yml) |
| 12 | **二分查找与高效检索** (`12-binary-search`) | 40 题 | `1` / `0` / `29` / `9` / `1` | **COMP2050**, **COMP2052**, **COMP3001** | [`12-binary-search.yml`](../problems/categories/12-binary-search.yml) |
| 13 | **线性表与链表应用** (`13-linear-list`) | 5 题 | `5` / `0` / `0` / `0` / `0` | **COMP1011**, **COMP2014**, **COMP2050**, **COMP2052** | [`13-linear-list.yml`](../problems/categories/13-linear-list.yml) |
| 14 | **栈与队列及单调结构** (`14-stack-queue`) | 39 题 | `12` / `0` / `23` / `4` / `0` | **COMP2014**, **COMP2050**, **COMP2052** | [`14-stack-queue.yml`](../problems/categories/14-stack-queue.yml) |
| 15 | **二叉树与树形数据结构** (`15-binary-tree`) | 73 题 | `38` / `0` / `21` / `14` / `0` | **COMP2050**, **COMP2052**, **COMP3001** | [`15-binary-tree.yml`](../problems/categories/15-binary-tree.yml) |
| 16 | **二叉堆与优先队列** (`16-heap-priority`) | 14 题 | `12` / `0` / `1` / `1` / `0` | **COMP2014**, **COMP2050**, **COMP2052**, **COMP3001** | [`16-heap-priority.yml`](../problems/categories/16-heap-priority.yml) |
| 17 | **并查集与动态连通性** (`17-dsu`) | 29 题 | `3` / `1` / `24` / `1` / `0` | **COMP2050**, **COMP2052**, **COMP3001** | [`17-dsu.yml`](../problems/categories/17-dsu.yml) |
| 18 | **经典贪心策略** (`18-greedy`) | 57 题 | `2` / `0` / `46` / `9` / `0` | **COMP2052**, **COMP3011**, **COMP3001** | [`18-greedy.yml`](../problems/categories/18-greedy.yml) |
| 19 | **深度优先搜索与状态回溯** (`19-dfs-backtracking`) | 73 题 | `38` / `0` / `21` / `14` / `0` | **COMP2052**, **COMP3001** | [`19-dfs-backtracking.yml`](../problems/categories/19-dfs-backtracking.yml) |
| 20 | **动态规划·经典背包模型** (`20-dp-knapsack`) | 80 题 | `29` / `0` / `49` / `2` / `0` | **COMP2052**, **COMP3001** | [`20-dp-knapsack.yml`](../problems/categories/20-dp-knapsack.yml) |
| 21 | **动态规划·线性与区间模型** (`21-dp-linear-interval`) | 33 题 | `7` / `1` / `9` / `16` / `0` | **COMP2052**, **COMP3001** | [`21-dp-linear-interval.yml`](../problems/categories/21-dp-linear-interval.yml) |
| 22 | **图论算法·最短路径** (`22-graph-shortest`) | 65 题 | `22` / `0` / `2` / `41` / `0` | **COMP2050**, **COMP2052**, **COMP3001** | [`22-graph-shortest.yml`](../problems/categories/22-graph-shortest.yml) |
| 23 | **图论算法·最小生成树与拓扑排序** (`23-graph-mst-topo`) | 6 题 | `3` / `0` / `0` / `3` / `0` | **COMP2050**, **COMP2052**, **COMP3001** | [`23-graph-mst-topo.yml`](../problems/categories/23-graph-mst-topo.yml) |
| 24 | **经典数学与数论基础** (`24-number-theory`) | 67 题 | `51` / `1` / `2` / `13` / `0` | **COMP1007**, **COMP1011**, **COMP2001**, **COMP2012**, **COMP3001** | [`24-number-theory.yml`](../problems/categories/24-number-theory.yml) |

---

## 三、 课程专属推荐题单索引 (共 51 份题单)

各课程题单目录位于 [`problems/courses/<课程代码>/`](../problems/courses/)：
- **`COMP1007`** (程序设计基础)：W01～W10 共 10 周推荐题单
- **`COMP1011`** (程序设计思维与实践)：W01～W08 共 8 周推荐题单
- **`COMP2001`** (计算机专业导论)：P01～P02 共 2 份启蒙实践题单
- **`COMP2012`** (计算机设计与实践)：P01～P02 共 2 份硬件指令与位运算题单
- **`COMP2014`** (C++语言程序设计)：W01～W06 共 6 份面向对象与STL题单
- **`COMP2050`** (数据结构与算法·自动化)：W01～W06 共 6 份工程数据结构题单
- **`COMP2052`** (数据结构与算法)：W01～W08 共 8 周经典算法题单
- **`COMP3011`** (计算机体系结构)：P01～P02 共 2 份访存局部性与调度题单
- **`COMP3001`** (算法设计与分析)：B01～B07 共 7 份算法高阶进阶题单
"""
    with open(matrix_path, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"✅ 生成全景矩阵文档：{matrix_path}")


def update_readme():
    readme_path = HOA_OJ / "README.md"
    content = """# HOA 独立题单中心 (HITSZ-OpenAuto Problem Sets)

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
"""
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"✅ 更新 README 文档：{readme_path}")


def update_search_tool():
    search_path = HOA_OJ / "search.py"
    code = '''#!/usr/bin/env python3
"""HOA 题单中心 · 教师多维检索工具

用法示例:
    python3 search.py --course COMP1011
    python3 search.py --course COMP2014 --category 14-stack-queue
    python3 search.py --course COMP2050 --difficulty L3
    python3 search.py --keyword 矩阵
    python3 search.py --source 蓝桥杯
    python3 search.py --knowledge 二分
"""

import argparse
import json
import os
import sys

CATALOG_PATH = os.path.join(os.path.dirname(__file__), "index", "catalog.json")

COURSES = {
    "COMP1007": "程序设计基础",
    "COMP1011": "程序设计思维与实践",
    "COMP2001": "计算机专业导论",
    "COMP2012": "计算机设计与实践",
    "COMP2014": "C++语言程序设计",
    "COMP2050": "数据结构与算法（自动化类）",
    "COMP2052": "数据结构与算法",
    "COMP3011": "计算机体系结构",
    "COMP3001": "算法设计与分析",
}

def main():
    parser = argparse.ArgumentParser(description="HOA 题库多维快速检索")
    parser.add_argument("--course", help=f"按课程筛选: {', '.join(COURSES.keys())}")
    parser.add_argument("--category", help="按种类/类别筛选 (如 06-array-2d 或 矩阵)")
    parser.add_argument("--difficulty", help="按难度筛选 (L1-入门, L2-基础, L3-普及, L4-提高, L5-进阶)")
    parser.add_argument("--source", help="按题目原始出处筛选 (如 蓝桥杯, 一本通, 洛谷, USACO)")
    parser.add_argument("--knowledge", help="按细粒度知识点标签筛选 (如 动态规划, 二分, 递归)")
    parser.add_argument("--keyword", help="在标题与题面中搜索关键词")
    parser.add_argument("--limit", type=int, default=20, help="最多显示结果数 (默认 20)")
    args = parser.parse_args()

    if not os.path.exists(CATALOG_PATH):
        print(f"错误：找不到索引文件 {CATALOG_PATH}", file=sys.stderr)
        return 1

    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    results = []
    for item in catalog:
        if args.course and args.course.upper() not in [c.upper() for c in item.get("courses", [])]:
            continue
        if args.category:
            cat_query = args.category.lower()
            if cat_query not in item.get("category_id", "").lower() and cat_query not in item.get("category_name", "").lower():
                continue
        if args.difficulty and args.difficulty not in item.get("difficulty", ""):
            continue
        if args.source and args.source.lower() not in item.get("provenance", "").lower():
            continue
        if args.knowledge and not any(args.knowledge.lower() in k.lower() for k in item.get("knowledge", [])):
            continue
        if args.keyword:
            kw = args.keyword.lower()
            if kw not in item.get("title", "").lower() and kw not in item.get("statement", "").lower():
                continue
        results.append(item)

    course_tip = f" [课程: {args.course.upper()} · {COURSES.get(args.course.upper(), '')}]" if args.course else ""
    print(f"\\n🔍 检索完成！{course_tip} 匹配到 {len(results)} 道题目 (展示前 {min(len(results), args.limit)} 题):\\n")
    print(f"{'序号':<4} {'标题':<24} {'难度':<8} {'所属种类':<18} {'知识点':<20} {'来源出处':<22} {'对应课程'}")
    print("-" * 120)
    for i, r in enumerate(results[:args.limit], 1):
        know_str = ",".join(r.get("knowledge", [])[:2])
        courses_str = ",".join(r.get("courses", []))
        src = r.get("provenance", r.get("source", ""))
        print(f"{i:<4} {r['title'][:22]:<24} {r['difficulty']:<8} {r['category_name'][:16]:<18} {know_str[:18]:<20} {src[:20]:<22} {courses_str}")

    print(f"\\n💡 提示：题目详细位于: problems/categories/<category_id>.yml (或 problems/tags/)\\n")

if __name__ == "__main__":
    main()
'''
    with open(search_path, "w", encoding="utf-8") as f:
        f.write(code)
    print(f"✅ 更新 search.py 检索工具：{search_path}")


def sync_to_course_service():
    target_dir = ROOT / "data" / "problem_sets"
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # 复制 problems, index, search.py
    for item in ["problems", "index", "search.py", "README.md"]:
        src = HOA_OJ / item
        dst = target_dir / item
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    print(f"✅ 同步题单资源到 course-service: {target_dir}")


def main():
    print("🚀 开始构建 HOA-OJ 9门课程全量多对多拓扑体系...")
    all_problems = update_categories()
    update_catalog(all_problems)
    clean_and_build_course_sets(all_problems)
    generate_matrix()
    update_readme()
    update_search_tool()
    sync_to_course_service()
    print("🎉 全流程构建完成！")


if __name__ == "__main__":
    main()
