#!/bin/bash
set -eu
ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
printf 'Asia/Shanghai\n' > /etc/timezone
sed -i 's/^bind-address\s*=.*/bind-address = 0.0.0.0/' /etc/mysql/mariadb.conf.d/50-server.cnf
sed -i 's/^OJ_USE_PTRACE=.*/OJ_USE_PTRACE=1/' /home/judge/etc/judge.conf
mkdir -p /home/judge/data/1000
printf '1 2\n' > /home/judge/data/1000/sample.in
printf '3\n' > /home/judge/data/1000/sample.out
exec /bin/bash /opt/codemind-entrypoint.sh
