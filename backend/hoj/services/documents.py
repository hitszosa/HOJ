from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from fastapi import HTTPException
import yaml

from hoj.config import yaml_load


def validate_document(doc):
    if not isinstance(doc,dict): raise HTTPException(422,'题单须为对象')
    if 'read_only' in doc and not isinstance(doc['read_only'],bool): raise HTTPException(422,'read_only 必须为布尔值')
    if doc.get('source_ref') is not None and (not isinstance(doc['source_ref'],str) or len(doc['source_ref'])>255):
        raise HTTPException(422,'source_ref 必须是不超过 255 字符的字符串')
    if doc.get('allowed_languages') is not None and (not isinstance(doc['allowed_languages'],str) or len(doc['allowed_languages'])>64):
        raise HTTPException(422,'allowed_languages 必须是不超过 64 字符的字符串')
    if not isinstance(doc.get('title'),str) or not doc['title'].strip(): raise HTTPException(422,'请填写题单标题')
    problems=doc.get('problems')
    if not isinstance(problems,list) or not 1<=len(problems)<=100: raise HTTPException(422,'每个题单需要 1–100 道题')
    slugs=set()
    for p in problems:
        if not isinstance(p,dict) or not all(isinstance(p.get(k),str) and p[k].strip() for k in ('slug','title','statement')): raise HTTPException(422,'每题须有 slug、标题和题面')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',p['slug']) or p['slug'] in slugs: raise HTTPException(422,'题目 slug 不合法或重复')
        slugs.add(p['slug'])
        for kind in ('samples','tests'):
            samples=p.get(kind,[])
            if not isinstance(samples,list) or len(samples)>100: raise HTTPException(422,'样例或测试数据格式错误')
            for sample in samples:
                if not isinstance(sample,dict) or any(not isinstance(sample.get(k),str) for k in ('input','output')): raise HTTPException(422,'样例和测试须包含文本 input/output')
        if not p.get('samples'): raise HTTPException(422,'每题至少提供一个样例')
    return doc


def parse_document(content):
    if not isinstance(content,str) or len(content.encode())>1048576: raise HTTPException(422,'题单文件过大')
    try:
        if content.lstrip().startswith('<'):
            if re.search(r'<!DOCTYPE|<!ENTITY',content,re.I): raise ValueError('XML 不允许 DTD 或实体')
            root=ET.fromstring(content)
            ps=[]
            for i,item in enumerate(root.findall('item')):
                ins=item.findall('test_input'); outs=item.findall('test_output')
                if len(ins)!=len(outs): raise ValueError('测试输入输出数量不一致')
                ps.append({'slug':f'fps-{i+1}','title':item.findtext('title',''),'statement':item.findtext('description','')+'\n'+item.findtext('input','')+'\n'+item.findtext('output',''),'samples':[{'input':item.findtext('sample_input',''),'output':item.findtext('sample_output','')}],'tests':[{'input':a.text or '', 'output':b.text or ''} for a,b in zip(ins,outs)]})
            doc={'title':'导入的 FPS 题单','problems':ps}
        else: doc=yaml_load(content)
    except (ValueError,yaml.YAMLError,ET.ParseError): raise HTTPException(422,'无法解析题单，请检查 YAML / JSON / FPS XML 格式')
    return validate_document(doc)
