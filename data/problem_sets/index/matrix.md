# HOA-OJ 课程与知识点多对多全景映射矩阵

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
