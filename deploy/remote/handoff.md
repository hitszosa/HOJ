# 部署交接：整理后的教学平台

2026-10-09：源码整理已合入 `main`（原整理分支 `codex/deployment-cleanup`），包含现有教学功能、正式构建入口、版本清单、网络权限调整和备份工具。Harbor 暂缓；尚未迁移到 dell0。现有平台继续运行在 `10.249.12.21:3100`，服务器目录 `/opt/hoj`。

## 先取得正确源码

目标环境为 Linux x86_64，安装 Git、Python 3.10+、Docker Engine、Compose 插件与 Buildx。构建需要能访问依赖和基础镜像源。以下安装和恢复命令在目标机器以 root 执行，项目目录固定为 `/opt/hoj`：

```bash
git clone --branch main --single-branch \
  https://github.com/hitszosa/HOJ.git /opt/hoj
cd /opt/hoj
git status --short
git rev-parse HEAD
systemctl enable --now docker
```

不要从旧 `source_before_*.tar.gz` 开始开发。新增修改先提交 Git，再构建；不要在运行容器里修改代码，也不要增加按功能命名的 Dockerfile。构建会拒绝有未提交修改的源码。

## 全新安装：空账号、空课程

只有不需要现有业务数据时使用这一流程。将下面地址替换为学生浏览器能够访问的目标服务器地址；附件端口也必须可达。

```bash
cd /opt/hoj
python3 deploy/remote/configure.py \
  --public-url http://SERVER_IP:3100 \
  --storage-url http://SERVER_IP:9002
bash deploy/remote/build.sh
release="releases/$(git rev-parse HEAD)/release.json"
bash deploy/remote/start.sh "$release"
cp "$release" active-release.json
chmod 600 active-release.json
python3 deploy/remote/create-admin.py
```

`configure.py` 创建随机私有凭据及初始化 SQL。管理员密码保存在 `/opt/hoj/admin-account.json`，不要发送到 GitHub。完整镜像构建可能较久；七个镜像全部完成后，版本清单才标记为 `built`。`start.sh` 校验镜像 ID，执行教学管理数据库迁移和附件桶初始化，然后启动服务。

## 保留现有账号、课程、题目和提交

这是迁移现有平台应使用的流程。**不要运行 `configure.py` 或 `create-admin.py`，不要重新生成密码。** 先保留旧机器服务，目标机器隔离验收通过后再切换访问地址。

私下取得一个完整备份目录及对应七个运行镜像。备份内含密码和学生数据，不能推送到 GitHub 或公开仓库。现有备份在旧服务器 `/opt/hoj/backups/sets/`，独立副本在维护者 Mac 的 `~/Library/Application Support/HOJ/Backups/`。每组应包含：

| 文件 | 内容 |
|---|---|
| `manifest.json` | 源码版本、各文件字节数与 SHA-256 |
| `databases.sql.gz` | `jol`、`codemind_course`、`grader` 三库及触发器等 |
| `application-grants.sql` | 四种应用数据库账号的八条本地账户及授权 |
| `files.tar.gz` | `.env`、管理员凭据、判题数据、课程文件、附件对象和活动版本记录 |
| `source.bundle` | 私有 Git 恢复归档，包括历史分支；仅用于恢复，不公开推送所有分支 |

先按 `manifest.json` 校验每个文件的大小和 SHA-256；缺失或不一致则停止。将备份置于目标机器私有目录（0700），文件设为 0600。只向空目标恢复，不能覆盖已经有数据的安装。

恢复时使用与旧机器一致的 MariaDB 镜像；当前实际版本为 **11.8.9**，不能仅凭可变 `mariadb:11.8` 标签判断一致。可由旧机器根据 `active-release.json` 的七个镜像 ID 执行 `docker save`，目标机器 `docker load` 后再次核对 ID。无需 Harbor。活动清单记录的应用源码为 `fbb4668096b2baf7c5caf0cc739e184976ee8083`；后续配置与文档提交单独记录，不能把它们说成已重建的应用。

恢复顺序：

1. 在空 `/opt/hoj` 签出 `main`，解包 `files.tar.gz` 到项目根目录，保留文件原有所有者和权限。创建空的 `init`、`data/mysql`、`data/judge-log` 目录。不要复制正在运行的 `data/mysql`。
2. 导入并校验七个镜像；使用恢复的 `active-release.json` 生成覆盖配置。下面命令只启动数据库，不启动写入服务。

   ```bash
   cd /opt/hoj
   mkdir -p init data/mysql data/judge-log
   override=$(python3 deploy/remote/release.py config active-release.json)
   docker compose --env-file .env -f deploy/remote/compose.yml -f "$override" \
     up -d --pull never --wait --wait-timeout 180 db
   ```

3. 将三库 SQL 和应用授权依次导入空数据库。以下 `BACKUP_DIR` 是已校验的私有备份目录；密码在容器内部读取，不放在命令参数中。

   ```bash
   set -o pipefail
   BACKUP_DIR=/PRIVATE_BACKUP_DIRECTORY
   gzip -dc "$BACKUP_DIR/databases.sql.gz" | docker exec -i hoj-db-1 sh -c \
     'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot'
   docker exec -i hoj-db-1 sh -c \
     'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot' \
     < "$BACKUP_DIR/application-grants.sql"
   ```

4. 私下编辑 `.env` 的 `HOJ_ORIGINS` 和 `PUBLIC_STORAGE_URL`，对应目标浏览器入口及附件地址；保留原有数据库、存储、会话密钥。`admin-account.json` 的 `url` 是维护记录，也应更新。保持私有配置 0600。
5. `bash deploy/remote/start.sh active-release.json` 启动其余服务。核对三库表数和主要业务表行数、账号、课程、题目、成绩、附件及判题数据。旧机器成功恢复验证的参考规模是三库分别 23/9/26 张表（`jol`/`codemind_course`/`grader`），迁移时以新备份实际数据为准。

若要从源码重新构建，使用 `bash deploy/remote/build.sh --db-image IMMUTABLE_DATABASE_IMAGE`，其中数据库参数必须是已核对的 `sha256:...` 镜像 ID 或仓库 digest；再用新生成的完整清单启动。私有备份中的活动镜像清单不会被普通 Git clone 下载。

## 网络与功能验收

只发布宿主机 **3100**（统一平台）和 **9002**（附件签名上传下载）。数据库及内部 API 在共用的 bridge 网络命名空间内，绑定其 loopback；不能用宿主机的 `127.0.0.1:8100` 判断 API 是否存活。容器均不使用 host 网络或 privileged。判题仍需要 `SYS_ADMIN`、`SYS_PTRACE`；这不是完全隔离的沙箱，不应与无关敏感业务混放。

```bash
cd /opt/hoj
override=$(python3 deploy/remote/release.py config active-release.json)
docker compose --env-file .env -f deploy/remote/compose.yml -f "$override" ps
docker exec hoj-core-1 curl -fsS http://127.0.0.1:8100/api/health
docker exec hoj-core-1 curl -fsS http://127.0.0.1:8101/healthz
curl -fsS http://127.0.0.1:3100/management/login >/dev/null
curl -fsS http://127.0.0.1:9002/minio/health/live
```

切换前验收真实教师和学生登录、发布题单、C/C++/Python 各一份 AC 和 WA、权重成绩、学生仅看本人代码、教师班级权限、附件上传下载。Java 尚不可用；AI 为可选私有配置，未连通时不影响普通题库和判题。可参考 `smoke.py`，只删除本次测试 fixture 的数据。

2026-10-09 旧机器已验证七个服务运行、六个配置了健康检查的服务健康，C/C++/Python 六个 AC/WA 测试全部通过；清理了 96 个旧 HOJ 镜像标签，保留七个活动镜像及七个回退镜像。新机器需要重新验收，不能直接沿用旧机器结果。

## 安装备份并留独立副本

服务固定运行于 `/opt/hoj`，备份依赖 Compose 项目名 `hoj`。默认导出用户为旧机器的 `lhy`；目标没有此账户时必须使用实际的非 root 系统账户，例如先执行 `python3 deploy/remote/backup.py --export-user BACKUP_USER` 验证一次，然后安装 timer：

```bash
install -m 644 deploy/remote/hoj-backup.service /etc/systemd/system/
install -m 644 deploy/remote/hoj-backup.timer /etc/systemd/system/
systemctl edit hoj-backup.service
```

在 override 中填写（替换 `BACKUP_USER`）：

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/python3 /opt/hoj/deploy/remote/backup.py --export-user BACKUP_USER
```

```bash
systemctl daemon-reload
systemctl start hoj-backup.service
systemctl status hoj-backup.service
systemctl enable --now hoj-backup.timer
```

每天北京时间约 04:00 暂停入口，等待队列清空，停止写入服务后备份；结束后恢复原本运行的容器，服务会短暂停止。服务器及只读导出各保留 14 组。定期检查失败状态及备份年龄；发现积压判题时备份会取消。

独立机器使用 `backup-pull.py` 核对下载，保留 30 组。目标服务器需安装 `backup-read.py` 到 `/usr/local/libexec/hoj-backup-read.py`（root 所有、0755），为上述导出用户添加专用公钥，`authorized_keys` 项前缀为 `restrict,command="/usr/bin/python3 /usr/local/libexec/hoj-backup-read.py"`。独立机器先核对 SSH 主机密钥，再设置定时调用：

```bash
python3 deploy/remote/backup-pull.py --host BACKUP_USER@SERVER_IP --port 22 \
  --key /PRIVATE/backup-read.key --known-hosts /PRIVATE/known_hosts \
  --output /PRIVATE/Backups
```

现有 Mac 已安装此任务（登录、04:30 及每小时重试），最新独立副本已通过 SHA-256 校验，三库及授权已做隔离恢复验证。新服务器须更新主机及受限制密钥配置。Mac 关机、休眠或无法访问校园网时副本不会更新。当前仍是单机服务；独立备份解决恢复能力，不提供自动故障切换。

## 回退与版本维护

每次部署先保留当前 `active-release.json`、部署配置及完整备份。镜像固定为七个 ID 或 digest；`start.sh` 默认读取活动清单，避免可变 `amd64` 标签。配置 Git commit 与应用镜像源码 commit 分别记录，不要手动改记录来冒充构建。

旧机器整理前的私有回退配置位于 `/opt/hoj/backups/pre-hardening-20261009/compose.rollback.json`，七个旧镜像保留 `rollback-20261009` 标签。必须先停止当前整组容器，再按保存的旧配置启动，不能让新旧服务同时写同一数据目录。该旧配置包含 host 网络及 privileged，仅用于紧急恢复，不应作为新机器正式部署方案。跨数据库结构升级的回退还需恢复对应的数据库和文件备份，不能只换镜像。

不要运行全局 `docker system prune` 清理共享服务器。只按完整版本清单清理确认无引用的 HOJ 镜像，至少保留一个已验收的回退版本。正常源码更新走 Git 提交和分支评审；私有配置与业务数据继续独立管理。
