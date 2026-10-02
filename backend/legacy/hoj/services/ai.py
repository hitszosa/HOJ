from __future__ import annotations

import json
import os

import httpx


def ai_config():
    """模型服务配置的只读入口：题单生成与学习建议共用同一口径。"""
    return (os.environ.get('COURSE_AI_URL'), os.environ.get('COURSE_AI_MODEL'), os.environ.get('COURSE_AI_KEY'))


def ai_timeout():
    try:
        return max(1.0, min(60.0, float(os.environ.get('COURSE_AI_TIMEOUT', '20'))))
    except ValueError:
        return 20.0


def clip(text, limit):
    """按字符截断文本（用于题面等短文本）；非字符串一律视为空。"""
    if not isinstance(text, str):
        return ''
    return text if len(text) <= limit else text[:limit] + '……（已截断）'


def clip_bytes(text, limit):
    """按 UTF-8 字节截断（用于源码大字段），不会切出半个多字节字符。"""
    if not isinstance(text, str):
        return ''
    raw = text.encode('utf-8')
    if len(raw) <= limit:
        return text
    return raw[:limit].decode('utf-8', 'ignore') + '……（已截断）'


def error_text(row):
    """db 的 XML 行形如 {'error': 文本}；取出其中的字符串，其余一律忽略。"""
    if isinstance(row, dict):
        row = row.get('error')
    return row if isinstance(row, str) else ''


HINT_LEVEL_GUIDE = {1: '只给方向性提示，不点具体行号', 2: '指出可疑的结构或边界，可引用判题错误信息', 3: '给出接近可操作的定位，但仍不得提供完整解答'}


RULES_HINTS = {6: ['对照输入约束检查边界值。', '选取最小规模与最大规模，手动跟踪关键变量。', '把实际输出和预期输出逐行比较，定位第一个不同的位置。'],
               11: ['先定位编译器给出的第一条错误。', '检查该行之前的括号、类型声明和作用域。', '逐步缩小报错片段，修复后重新提交。'],
               7: ['检查循环是否可以结束。', '估算输入规模与循环次数的关系。', '查找是否重复计算了相同的中间结果。']}


RULES_FALLBACK = ['先读取判题结果与错误信息。', '使用题目样例复现并记录中间状态。', '一次只修改一个假设，再用新的提交验证。']


def analysis_hint(problem_row, code, judge, level):
    """调用已配置的模型服务生成一条学习建议。返回 (建议文本, 失败原因)；失败原因非空表示应降级为规则建议。

    只发送当前这一次已授权的提交：公开题面字段、学生本人代码、服务端判题事实与提示级别。
    - 隐藏测试从不进入请求（服务端不读取判题目录，数据库里也没有隐藏测试）。
    - 运行时错误可能回显隐藏输入/输出，因此只发送编译信息（compileError），不外发 runtimeinfo 原文。
    - 代码按 UTF-8 字节限长，题面按字符限长。
    """
    endpoint, model, token = ai_config()
    if not endpoint or not model:
        return None, 'not_configured'
    case = {
        'level': level,
        'levelGuide': HINT_LEVEL_GUIDE[level],
        'problem': {'title': clip(problem_row.get('title'), 200),
                    'statement': clip(problem_row.get('description'), 4000),
                    'input': clip(problem_row.get('input'), 1000),
                    'output': clip(problem_row.get('output'), 1000),
                    'sampleInput': clip(problem_row.get('sample_input'), 1000),
                    'sampleOutput': clip(problem_row.get('sample_output'), 1000)},
        'judge': {'resultCode': int(judge['result']), 'resultLabel': judge['label'],
                  'timeMs': judge.get('time'), 'memoryKb': judge.get('memory'),
                  'compileError': clip(judge.get('compileError'), 2000)},
        'language': judge.get('language'),
        'code': clip_bytes(code, 8000)}
    payload = {
        'model': model,
        'temperature': 0.2,
        'messages': [
            {'role': 'system', 'content': '你是编程课助教。只依据给定事实写 1 条中文学习建议，不超过 300 字。'
                                         '不得改写、质疑或猜测判题结果，不得声称看到隐藏测试或外部资料，'
                                         '不得给出可直接提交的完整解答。'},
            {'role': 'user', 'content': json.dumps(case, ensure_ascii=False)}]}
    try:
        with httpx.Client(timeout=ai_timeout(), trust_env=False, follow_redirects=False) as client:
            response = client.post(endpoint.rstrip('/') + '/chat/completions',
                                   headers={'Authorization': 'Bearer ' + (token or '')}, json=payload)
        if response.status_code != 200:
            return None, 'model_unavailable'
        content = response.json()['choices'][0]['message']['content']
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return None, 'model_unavailable'
    if not isinstance(content, str):        # dict / list / int 等一律视为无效返回，绝不能抛 500
        return None, 'invalid_response'
    text = content.strip()
    if not text or len(text) > 1200:
        return None, 'invalid_response'
    return text, None
