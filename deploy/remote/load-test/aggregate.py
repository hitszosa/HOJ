import json,pathlib,statistics
root=pathlib.Path('/opt/hoj/load-test');reports=[]
for p in sorted(root.glob('*.json')):
 if p.name in ['fixture.json','sessions.json','setup.json','judge-progress.json']:continue
 try:r=json.loads(p.read_text())
 except ValueError:continue
 if isinstance(r,dict) and 'mode' in r:reports.append(r)
metrics={}
for p in root.glob('metrics-*.jsonl'):
 rows=[]
 for line in p.read_text().splitlines():
  try:r=json.loads(line)
  except ValueError:continue
  if r.get('cpu_percent') is not None:rows.append(r)
 if rows:
  containers={}
  for r in rows:
   for c in r.get('containers',[]):
    cp=float(c['CPUPerc'].strip('%'));v=containers.setdefault(c['Name'],[]);v.append(cp)
  metrics[p.stem]={'samples':len(rows),'host_cpu_peak_percent':max(r['cpu_percent'] for r in rows),'host_cpu_mean_percent':statistics.mean(r['cpu_percent'] for r in rows),'memory_available_min_gib':min(r['memory_available_gib'] for r in rows),'load_peak':max(r['load'][0] for r in rows),'container_cpu_peak':{n:max(v) for n,v in containers.items()}}
result={'reports':reports,'resources':metrics};(root/'aggregate.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False))
