#!/bin/bash
# 端到端冒烟：对运行中的服务（COURSE_DEV_LOGIN=1，库里有 offering_id=1 且 cm_pilot_* 账号已选课）走一遍教学流程。
# 用法：BASE=http://127.0.0.1:8100 bash backend/scripts/smoke.sh
set -u
B=${BASE:-http://127.0.0.1:8100}/api; S=$(mktemp -d); J='content-type: application/json'
login(){ curl -s -c $S/$1.jar -X POST $B/session -H "$J" -d "{\"role\":\"$1\"}" >/dev/null; }
T(){ curl -s -b $S/teacher.jar -H "$J" "$@"; echo; }
St(){ curl -s -b $S/student.jar -H "$J" "$@"; echo; }
O(){ curl -s -b $S/outsider.jar -H "$J" "$@"; echo; }
login teacher; login student; login outsider; login ta
echo "== me"; T $B/me; St $B/me
echo "== courses"; T $B/courses
echo "== draft"; D=$(T -X POST $B/offerings/1/drafts -d '{"document":{"title":"体验作业","problems":[{"slug":"sum","title":"两数和","statement":"a+b","samples":[{"input":"1 2\n","output":"3\n"}],"tests":[{"input":"2 3\n","output":"5\n"}]}]}}'); echo "$D"
DID=$(echo "$D" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
echo "== student reads draft (403)"; St $B/drafts/$DID
echo "== outsider offering (404)"; O $B/offerings/1
echo "== publish w/o review (422)"; T -X POST $B/drafts/$DID/publish -d '{}'
echo "== publish"; P=$(T -X POST $B/drafts/$DID/publish -d '{"reviewed":true,"due_at":"2099-01-01T10:00","allowed_languages":["python","cpp"]}'); echo $P
BID=$(echo "$P" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["batch_id"])')
echo "== publish again (idempotent)"; T -X POST $B/drafts/$DID/publish -d '{"reviewed":true}'
echo "== student batch"; SB=$(St $B/batches/$BID); echo "$SB"
PID=$(echo "$SB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["problems"][0]["problem_id"])')
echo "== problem"; St $B/batches/$BID/problems/$PID
echo "== teacher submit (403)"; T -X POST $B/batches/$BID/problems/$PID/submissions -d '{"code":"x","language":"python"}'
echo "== java not allowed (400)"; St -X POST $B/batches/$BID/problems/$PID/submissions -d '{"code":"x","language":"java"}'
echo "== submit"; SUB=$(St -X POST $B/batches/$BID/problems/$PID/submissions -d '{"code":"a,b=map(int,input().split())\nprint(a+b)\n","language":"python"}'); echo $SUB
SID=$(echo "$SUB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["submission_id"])')
echo "== result"; St $B/submissions/$SID
echo "== outsider result (404)"; O $B/submissions/$SID
echo "== code"; T $B/submissions/$SID/code
echo "== analysis"; St "$B/submissions/$SID/analysis?level=2"
echo "== trial"; TR=$(St -X POST $B/batches/$BID/problems/$PID/trials -d '{"code":"print(1)","language":"python","input":"1"}'); echo $TR
RID=$(echo "$TR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["run_id"])')
echo "== trial again (429)"; St -X POST $B/batches/$BID/problems/$PID/trials -d '{"code":"print(1)","language":"python","input":"1"}'
echo "== trial result"; St $B/trials/$RID
echo "== offering (teacher)"; T $B/offerings/1
echo "== offering (student)"; St $B/offerings/1
echo "== insights student (403)"; St $B/offerings/1/insights
echo "== students"; T $B/offerings/1/students
echo "== add students"; T -X POST $B/offerings/1/students -d '{"students":[{"raw_text":"s002,2026002,乙\ns003"}]}'
echo "== drop"; T -X DELETE $B/offerings/1/students/s003
echo "== ranklist"; St "$B/ranklist?offering_id=1&page_size=5"
echo "== status"; St "$B/status?only_mine=true&page_size=2"
echo "== settings"; T -X PATCH $B/batches/$BID -d '{"ai_enabled":false,"allowed_languages":null}'
echo "== copy"; T -X POST $B/batches/$BID/copy
echo "== export"; T -X POST $B/batches/$BID/export -d "{\"selected\":[$PID]}"
echo "== library"; T $B/teacher/library
echo "== create set"; T -X POST $B/teacher/library/sets -d '{"title":"空白"}'
echo "== problem-sets"; T $B/problem-sets
echo "== tree"; St $B/problem-sets/tree
echo "== offering sets"; T $B/offerings/1/problem-sets
echo "== import-set"; T -X POST $B/offerings/1/import-set -d '{"set_id":"cat:01-basic-io","selected_slugs":["01-basic-io-p01","01-basic-io-p02"]}'
echo "== publish-to-offerings"; T -X POST $B/problem-sets/publish-to-offerings -d '{"offering_ids":[1],"items":[{"set_id":"set:DFBY-P01","slug":"dfby-p01-p01"}]}'
echo "== public list"; St "$B/public-problems?page_size=2"
echo "== public slug"; St $B/public-problems/01-basic-io-p03
echo "== public submit"; St -X POST $B/public-problems/01-basic-io-p03/submissions -d '{"code":"print(1)","language":"c"}'
echo "== my-status"; St $B/problem-sets/my-status
echo "== demo users"; curl -s $B/demo/users
echo "== bad path"; St $B/batches/abc
echo "== bad json"; T -X POST $B/offerings/1/drafts -d '{bad'
echo "== 404"; St $B/nope
