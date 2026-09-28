#!/usr/bin/env python3
"""题库中心 · 多维检索工具

用法示例:
    python3 search.py --course COMP1011
    python3 search.py --category 14-stack-queue
    python3 search.py --difficulty L3
    python3 search.py --keyword 矩阵
    python3 search.py --source 蓝桥杯
    python3 search.py --tag 递归
"""

import argparse
import json
import os
import sys

BASE_DIR = os.path.dirname(__file__)
CATALOG_PATH = os.path.join(BASE_DIR, "index", "catalog.json")

# Try to find course_syllabus.json
SYLLABUS_PATHS = [
    os.path.join(BASE_DIR, "..", "course_syllabus.json"),
    os.path.join(BASE_DIR, "index", "course_syllabus.json"),
    os.path.join(BASE_DIR, "course_syllabus.json"),
]

def load_syllabus():
    for p in SYLLABUS_PATHS:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return {}

def main():
    syllabus = load_syllabus()
    available_courses = list(syllabus.keys())

    parser = argparse.ArgumentParser(description="开放题库多维快速检索")
    parser.add_argument("--course", help=f"按课程大纲筛选: {', '.join(available_courses)}")
    parser.add_argument("--category", help="按种类/类别筛选 (如 06-array-2d 或 矩阵)")
    parser.add_argument("--difficulty", help="按难度筛选 (L1-入门, L2-基础, L3-普及, L4-提高, L5-进阶)")
    parser.add_argument("--source", help="按题目原始出处筛选 (如 蓝桥杯, 一本通, 洛谷, USACO)")
    parser.add_argument("--tag", "--knowledge", dest="tag", help="按细粒度知识点标签筛选 (如 动态规划, 二分, 递归)")
    parser.add_argument("--keyword", help="在标题与题面中搜索关键词")
    parser.add_argument("--limit", type=int, default=20, help="最多显示结果数 (默认 20)")
    args = parser.parse_args()

    if not os.path.exists(CATALOG_PATH):
        print(f"错误：找不到索引文件 {CATALOG_PATH}", file=sys.stderr)
        return 1

    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    target_categories = None
    if args.course:
        c_code = args.course.upper()
        if c_code in syllabus:
            target_categories = set(syllabus[c_code].get("recommended_categories", []))
        else:
            print(f"警告：未在教学大纲中找到课程 {c_code}，可用课程: {', '.join(available_courses)}")
            target_categories = set()

    results = []
    for item in catalog:
        if target_categories is not None and item.get("category_id") not in target_categories:
            continue
        if args.category:
            cat_query = args.category.lower()
            if cat_query not in item.get("category_id", "").lower() and cat_query not in item.get("category_name", "").lower():
                continue
        if args.difficulty and args.difficulty not in item.get("difficulty", ""):
            continue
        if args.source and args.source.lower() not in item.get("provenance", "").lower():
            continue
        if args.tag:
            tag_q = args.tag.lower()
            all_tags = [t.lower() for t in item.get("tags", []) + item.get("knowledge", [])]
            if not any(tag_q in t for t in all_tags):
                continue
        if args.keyword:
            kw = args.keyword.lower()
            if kw not in item.get("title", "").lower() and kw not in item.get("statement", "").lower():
                continue
        results.append(item)

    c_name = syllabus.get(args.course.upper(), {}).get("name", "") if args.course else ""
    course_tip = f" [课程大纲: {args.course.upper()} · {c_name}]" if args.course else ""
    print(f"\n🔍 检索完成！{course_tip} 匹配到 {len(results)} 道题目 (展示前 {min(len(results), args.limit)} 题):\n")
    print(f"{'序号':<4} {'标题':<24} {'难度':<8} {'所属种类':<18} {'标签/知识点':<28} {'来源出处'}")
    print("-" * 110)
    for i, r in enumerate(results[:args.limit], 1):
        tags_str = ",".join((r.get("tags") or r.get("knowledge") or [])[:3])
        src = r.get("provenance", r.get("source", ""))
        print(f"{i:<4} {r['title'][:22]:<24} {r['difficulty']:<8} {r['category_name'][:16]:<18} {tags_str[:26]:<28} {src[:20]}")

    print(f"\n💡 提示：题目详细位于: problems/categories/<category_id>.yml (或 problems/tags/)\n")

if __name__ == "__main__":
    main()
