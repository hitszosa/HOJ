from __future__ import annotations

from collections import Counter
from collections import defaultdict
import json

from hoj.config import ROOT, yaml_load
from hoj.hustoj.testdata import write_test_files
from hoj.infra.database import db, q


PROBLEM_SETS_CACHE = None


def get_problem_sets_index():
    global PROBLEM_SETS_CACHE
    if PROBLEM_SETS_CACHE is not None:
        return PROBLEM_SETS_CACHE
    
    ps_dir = ROOT / 'data' / 'problem_sets'
    catalog_file = ps_dir / 'index' / 'catalog.json'
    categories_dir = ps_dir / 'problems' / 'categories'
    
    categories = []
    category_map = {}
    
    catalog = []
    if catalog_file.is_file():
        try:
            with open(catalog_file, 'r', encoding='utf-8') as f:
                catalog = json.load(f)
        except Exception:
            catalog = []
            
    cat_problems = defaultdict(list)
    for p in catalog:
        cat_problems[p['category_id']].append(p)
        
    for cat_file in sorted(categories_dir.glob('*.yml')):
        stem = cat_file.stem
        ps = cat_problems.get(stem, [])
        cat_name = ps[0]['category_name'] if ps else stem
        tags = ps[0].get('tags', [cat_name]) if ps else [stem]
        diff_counter = Counter(p.get('difficulty', '')[:2] for p in ps if p.get('difficulty'))
        
        preview_problems = []
        for p in ps:
            preview_problems.append({
                'slug': p['slug'],
                'title': p['title'],
                'difficulty': p.get('difficulty', 'L1-入门'),
                'tags': p.get('tags', []),
                'knowledge': p.get('knowledge', []),
                'provenance': p.get('provenance', ''),
                'statement': p.get('statement', ''),
                'samples': p.get('samples', [])
            })
            
        cat_info = {
            'id': f'cat:{stem}',
            'kind': 'category',
            'code': stem,
            'title': f'{stem} · {cat_name}',
            'categoryName': cat_name,
            'tags': tags,
            'count': len(ps),
            'difficultyCount': dict(diff_counter),
            'problems': preview_problems
        }
        categories.append(cat_info)
        category_map[stem] = cat_info
        
    standalone_sets = []
    for sfile in sorted(ps_dir.glob('*.yml')):
        stem = sfile.stem
        try:
            with open(sfile, 'r', encoding='utf-8') as f:
                doc = yaml_load(f) or {}
            ps = doc.get('problems', [])
            preview_problems = []
            for p in ps:
                preview_problems.append({
                    'slug': p.get('slug', ''),
                    'title': p.get('title', ''),
                    'difficulty': p.get('difficulty', 'medium'),
                    'tags': p.get('tags', []),
                    'knowledge': p.get('knowledge', []),
                    'provenance': p.get('provenance', ''),
                    'statement': p.get('statement', ''),
                    'samples': p.get('samples', [])
                })
            standalone_sets.append({
                'id': f'set:{stem}',
                'kind': 'set',
                'code': stem,
                'title': doc.get('title', stem),
                'course': doc.get('course', ''),
                'count': len(ps),
                'problems': preview_problems
            })
        except Exception:
            pass

    PROBLEM_SETS_CACHE = {
        'categories': categories,
        'category_map': category_map,
        'standalone_sets': standalone_sets
    }
    return PROBLEM_SETS_CACHE


TAXONOMY = [
    {
        'id': 'p1-basics',
        'name': '1. 基础与语言入门',
        'icon': '🌱',
        'description': 'C/C++ 语法规范、分支与循环结构、基础函数与模块化设计',
        'children': [
            {
                'id': 'g1-syntax',
                'name': '语言与基本语法',
                'codes': ['01-basic-io', '08-functions', '10-struct-pointer', 'DFBY-P05']
            },
            {
                'id': 'g1-branch',
                'name': '顺序与分支结构',
                'codes': ['02-branching', 'DFBY-P01']
            },
            {
                'id': 'g1-loop',
                'name': '循环与多重迭代',
                'codes': ['03-loops', '04-nested-loops', 'DFBY-P02']
            }
        ]
    },
    {
        'id': 'p2-structures',
        'name': '2. 核心数据结构',
        'icon': '🧱',
        'description': '线性表、数组矩阵、栈队列、二叉树与并查集等存储结构',
        'children': [
            {
                'id': 'g2-linear',
                'name': '线性表、数组与字符串',
                'codes': ['05-array-1d', '06-array-2d', '07-strings', '13-linear-list', 'DFBY-P03', 'DFBY-P04']
            },
            {
                'id': 'g2-stack-queue',
                'name': '栈、队列与单调结构',
                'codes': ['14-stack-queue']
            },
            {
                'id': 'g2-trees',
                'name': '树形结构与并查集',
                'codes': ['15-binary-tree', '16-heap-priority', '17-dsu']
            }
        ]
    },
    {
        'id': 'p3-algorithms',
        'name': '3. 算法思想与进阶',
        'icon': '⚡',
        'description': '排序二分、递归分治、搜索回溯、贪心动态规划与图论体系',
        'children': [
            {
                'id': 'g3-sorting-search',
                'name': '排序与高效检索',
                'codes': ['11-sorting', '12-binary-search']
            },
            {
                'id': 'g3-recursion-search',
                'name': '递归分治与搜索回溯',
                'codes': ['09-recursion-divide', '19-dfs-backtracking', 'LUOGU-T03']
            },
            {
                'id': 'g3-greedy',
                'name': '经典贪心策略',
                'codes': ['18-greedy', 'LUOGU-T04', 'YBT-ADV-S01']
            },
            {
                'id': 'g3-dp',
                'name': '动态规划模型',
                'codes': ['20-dp-knapsack', '21-dp-linear-interval', 'LUOGU-T01', 'YBT-ADV-S03']
            },
            {
                'id': 'g3-graphs',
                'name': '图论核心算法',
                'codes': ['22-graph-shortest', '23-graph-mst-topo', 'LUOGU-T02', 'YBT-ADV-S02']
            }
        ]
    },
    {
        'id': 'p4-math',
        'name': '4. 数学与数论专项',
        'icon': '🔢',
        'description': '经典数论素数筛法、高精度大数乘除与组合数学',
        'children': [
            {
                'id': 'g4-theory',
                'name': '初等数学与数论基础',
                'codes': ['24-number-theory', 'YBT-ADV-S05', 'YBT-ADV-S04']
            }
        ]
    },
    {
        'id': 'p5-contests',
        'name': '5. 竞赛真题与等级认证',
        'icon': '🏆',
        'description': '蓝桥杯真题、GESP 等级认证、USACO 实战与高校专业机试',
        'children': [
            {
                'id': 'g5-lanqiao',
                'name': '蓝桥杯历届真题精选',
                'codes': ['LANQIAO-B01', 'LANQIAO-B02', 'LANQIAO-B03', 'LANQIAO-B04', 'LANQIAO-B05', 'LANQIAO-B06']
            },
            {
                'id': 'g5-gesp',
                'name': 'CCF GESP 认证精选',
                'codes': ['GESP-G01']
            },
            {
                'id': 'g5-usaco',
                'name': 'USACO 国际竞赛实战',
                'codes': ['USACO-U01', 'USACO-U02']
            },
            {
                'id': 'g5-nowcoder',
                'name': '牛客大学专业机试',
                'codes': ['NOWCODER-N01']
            }
        ]
    }
]


def resolve_set_file(set_id: str):
    ps_dir = ROOT / 'data' / 'problem_sets'
    if set_id.startswith(('cat:', 'category:')):
        code = set_id.split(':', 1)[1]
        target_path = ps_dir / 'problems' / 'categories' / f'{code}.yml'
    elif set_id.startswith('set:'):
        code = set_id.split(':', 1)[1]
        target_path = ps_dir / f'{code}.yml'
    else:
        code = set_id
        target_path = ps_dir / f'{code}.yml'
        if not target_path.is_file():
            target_path = ps_dir / 'problems' / 'categories' / f'{code}.yml'
    return code, target_path


def find_problem_by_slug(slug: str):
    data = get_problem_sets_index()
    target_set_id = None
    for cat in data['categories']:
        for p in cat.get('problems', []):
            if p.get('slug') == slug:
                target_set_id = cat['id']
                break
        if target_set_id:
            break
    if not target_set_id:
        for s in data['standalone_sets']:
            for p in s.get('problems', []):
                if p.get('slug') == slug:
                    target_set_id = s['id']
                    break
            if target_set_id:
                break
    if not target_set_id:
        return None
    code, path = resolve_set_file(target_set_id)
    if not path.is_file():
        return None
    with open(path, 'r', encoding='utf-8') as f:
        doc = yaml_load(f) or {}
    for p in doc.get('problems', []):
        if p.get('slug') == slug:
            prob = dict(p)
            prob['set_id'] = target_set_id
            prob['category_name'] = doc.get('title', code)
            return prob
    return None


def ensure_bank_problem(slug: str):
    source = f'bank:{slug}'
    existing = db.one(f"SELECT problem_id FROM jol.problem WHERE source={q(source)}")
    if existing:
        return int(existing['problem_id'])
    prob = find_problem_by_slug(slug)
    if not prob:
        return None
    title = str(prob.get('title') or slug).strip()
    statement = str(prob.get('statement') or '').strip()
    samples = prob.get('samples') or [{'input': '1\n', 'output': '1\n'}]
    sample_in = str(samples[0].get('input', '')) if samples else ''
    sample_out = str(samples[0].get('output', '')) if samples else ''
    tests = prob.get('tests') or samples
    hint = '、'.join(str(x) for x in (prob.get('tags', []) or prob.get('knowledge', [])) if x)
    sql = f"""
        INSERT INTO jol.problem(title, description, input, output, sample_input, sample_output, hint, source, in_date, defunct, time_limit, memory_limit)
        VALUES({q(title)}, {q(statement)}, '', '', {q(sample_in)}, {q(sample_out)}, {q(hint)}, {q(source)}, NOW(), 'N', 1, 128);
    """
    db.write(sql, ops=True)
    row = db.one(f"SELECT problem_id FROM jol.problem WHERE source={q(source)}")
    pid = int(row['problem_id'])
    try:
        write_test_files(pid, tests)
    except Exception:
        pass
    return pid
