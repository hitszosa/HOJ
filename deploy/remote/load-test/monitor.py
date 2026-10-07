import json,os,subprocess,time,urllib.request,pathlib
root=pathlib.Path('/opt/hoj');f=json.loads((root/'load-test/fixture.json').read_text());prev=None
while True:
 start=time.monotonic()
 try:
  nums=list(map(int,open('/proc/stat').readline().split()[1:]));total=sum(nums);idle=nums[3]+nums[4]
  cpu=None if prev is None else 100*(1-(idle-prev[1])/(total-prev[0]));prev=(total,idle)
  mem={x.split(':')[0]:int(x.split()[1]) for x in open('/proc/meminfo') if ':' in x}
  load=list(map(float,open('/proc/loadavg').read().split()[:3]))
  stats=subprocess.check_output(['docker','stats','--no-stream','--format','{{json .}}'],timeout=8,text=True).splitlines();stats=[json.loads(x) for x in stats]
  q=f"SELECT result,COUNT(*) FROM jol.solution WHERE user_id LIKE '{f['prefix']}\\_%' GROUP BY result; SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections','Slow_queries');"
  cmd=['docker','exec','-i','hoj-db-1','sh','-c','MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot -N -B']
  db=subprocess.run(cmd,input=q,text=True,capture_output=True,timeout=8)
  pids=json.loads(subprocess.check_output(['docker','inspect','hoj-api-1','hoj-management-api-1','hoj-web-1'],text=True));fds={c['Name']:len(os.listdir('/proc/'+str(c['State']['Pid'])+'/fd')) for c in pids}
  metric={'fds':fds,'time':time.time(),'cpu_percent':cpu,'load':load,'memory_available_gib':mem['MemAvailable']/1048576,'containers':stats,'database':db.stdout.strip().splitlines()}
  print(json.dumps(metric),flush=True)
  if mem['MemAvailable']<8*1048576:
   subprocess.run(['docker','stop','-t','5','hoj-load-test'],capture_output=True);print(json.dumps({'abort':'memory reserve below 8GiB'}),flush=True);break
 except Exception as e:print(json.dumps({'monitor_error':str(e)}),flush=True)
 time.sleep(max(1,5-(time.monotonic()-start)))
