# HOJ 教学平台远程测试部署

本目录部署当前工作区的统一教学管理与编程题库版本。目标为 Linux x86_64；不启用 PDF 批改、体验登录、旧 HUSTOJ 页面或尚未配置的 SSO。

新机器部署、保留现有业务数据的恢复顺序及回退见 [部署交接说明](handoff.md)。Harbor 和 dell0 迁移本轮暂缓。

## 本次机器与访问地址

- 服务器：`10.249.12.21:22`，主机名 `proj317`，Arch Linux。
- 部署目录：`/opt/hoj`；数据保存在 `/opt/hoj/data`。
- 统一入口：[教学平台](http://10.249.12.21:3100/management/home)。此为内网地址，需要相应校园网或 VPN 路由。
- 管理账号：`admin`，同时具备教学管理和编程教学权限。随机密码在服务器 `/opt/hoj/admin-account.json` 和本机 `.local/remote-deploy/admin-account.json`，均为私有文件。
- 本次部署没有使用或改动原文档中的 dell1、华为虚拟机及其端口映射。

| 服务 | 监听地址 | 数据 |
|---|---|---|
| 统一页面 Next.js | `0.0.0.0:3100` | 构建镜像 |
| 教学附件 MinIO | `:9002`，私有桶及签名上传/下载 | `data/objects` |
| MinIO 控制台 | `127.0.0.1:9003` | 内部维护 |
| MariaDB 11.8 | `127.0.0.1:13306` | `data/mysql` |
| 教学管理 API | `127.0.0.1:8101` | `grader` 数据库 |
| 编程教学 API | `127.0.0.1:8100` | `codemind_course` 数据库、`data/course-local` |
| 教学管理静态页面 | `127.0.0.1:3101` | 构建镜像 |
| 原生账号适配器 | `127.0.0.1:8080` | PHP 会话及 `jol` 数据库 |
| C/C++ 评测器 | 无对外 HTTP 页面，6 个评测任务槽 | `data/judge`、`data/judge-log` |

平台服务共用数据库容器的 bridge 网络命名空间，内部网页和 API 绑定该命名空间的 loopback，不使用主机网络。只向主机发布 3100 与 9002；数据库和内部端口不发布。数据库应用账户仍限定 localhost / 127.0.0.1。判题容器关闭 privileged，保留现有 chroot、ptrace、非特权 judge 用户及 SYS_ADMIN / SYS_PTRACE，移除 NET_RAW 并启用 no-new-privileges。SYS_ADMIN 仍较宽，同一平台的服务仍共享网络命名空间；这不等于完全隔离，不宜在此主机放无关敏感业务。

## 全新安装

准备已提交的源代码。现用判题与账号适配源码快照已纳入 `vendor/hustoj/`，文件哈希和来源见其中的 `snapshot.json`；评测器在 x86_64 上重新编译。

源码通过 Git bundle 或干净 Git checkout 同步，保留版本历史；构建使用 git archive，只包含已提交的源码。`.env`、`.local`、运行数据与私有账户文件由 `.gitignore` 和 `.dockerignore` 排除，单独传输备份。保留 `backend/.sqlx` 与公共题库数据。教师页面由镜像中的 Node 构建阶段编译，无需上传本机 `dist`。教学界面已移除监控和存储控制台页面，后台对象存储继续用于作业附件。

安装 Docker、Compose 与 Buildx 后，在全新部署目录中执行：

```bash
cd /opt/hoj
python3 deploy/remote/configure.py \
  --public-url http://10.249.12.21:3100 \
  --storage-url http://10.249.12.21:9002
bash deploy/remote/build.sh
bash deploy/remote/start.sh
python3 deploy/remote/create-admin.py
systemctl enable docker
```

`configure.py` 只用于全新安装；发现配置或已初始化的数据库时会停止，避免替换密码。MariaDB 必须保留 `utf8mb4_general_ci`，包括字符集默认排序规则；11.8 的 uca1400 默认值会影响与旧 `jol` 表联查的文本类型。编程 API 的两组数据库授权分别用于普通查询/提交与教师写操作。

如构建需使用代理，设置 `HOJ_BUILD_PROXY` 给 `build.sh`，并单独为 Docker 的镜像下载配置代理。本次使用的 SSH 反向代理只用于下载和构建，完成后移除；运行服务不需要本机 Mac 保持连接。

## 日常操作与备份

```bash
cd /opt/hoj
docker compose --env-file .env -f deploy/remote/compose.yml ps
docker compose --env-file .env -f deploy/remote/compose.yml logs --tail 100 api core management-api web
bash deploy/remote/backup.sh
```

`backup.sh` 调用 `backup.py`：先暂停统一入口，等待判题队列清空，再停止写入服务；数据库锁表转储、应用用户授权、私有配置、评测数据、附件与完整 Git bundle 一起保存。无论成功或失败都恢复原先运行的容器；超时未完成的判题会取消备份。备份在 `backups/sets/<时间>/`，完整后才发布 SHA-256 清单，默认保留 14 份。私有只读导出位于 `/home/lhy/.hoj-backups`。每日 04:00 的 systemd timer 运行备份，期间平台短暂停止服务；失败可用 `systemctl status hoj-backup` 检查。

`backup-pull.py` 使用受限制 SSH 密钥从独立机器下载并核对所有文件，保留 30 份。该密钥只能列出和读取已完成备份，不能开 shell、转发端口或修改文件。本机 Mac 的 LaunchAgent 在 04:30、登录及联网后定期重试；Mac 休眠或不能访问校园网时不会产生新的独立副本，成功时间见其 `last-success.json`。备份含密码，目录 0700、文件 0600。单机服务可用性仍需另一台服务器；备份本身不是高可用。

`active-release.json` 固定实际镜像源码版本，`active-deployment.json` 记录配置 Git commit、七个镜像 ID、网络及验证记录。应用镜像源码与部署配置允许使用不同 commit，分别记录；升级配置不冒充重新构建应用。`start.sh` 默认使用活动清单，不依赖可变 amd64 标签。容器设置 `unless-stopped`，Docker 已启用开机启动；不要删除数据目录来重启。

## 验证与边界

`smoke.py` 使用随机前缀创建临时学生和班级，验证统一登录、名单同步、C++ 真正判题、权重重算、成绩 CSV，以及普通教学附件的上传、下载、评分和权限。fixture 文件记录测试产生的 ID，便于只清理本次测试数据。

```bash
python3 deploy/remote/smoke.py \
  http://10.249.12.21:3100 \
  .local/remote-deploy/admin-account.json \
  .local/remote-deploy/test
```

测试脚本也支持通过 SSH 转发传输请求，同时保留真实远程 Origin 与存储 Host：`HOJ_TEST_CONNECT_URL` 和 `HOJ_TEST_STORAGE_CONNECT_URL`。浏览器单独验证原始远程地址和 CSV 下载。临时验证名单最终清理，保留 `admin`。

当前为内网 HTTP 测试部署。SSO、域名与 HTTPS 尚未配置；并发测试见压力测试记录。评分已使用真实 AC 结果与每题权重，不依赖 AI 服务。PDF 批改服务没有部署。

2026-10-05 教学管理与编程题库合为一套「HOJ 教学平台」导航，撤掉模块切换和两套导航。题库统一为 `/library`，评测为 `/judging`，作业为 `/assignments/:id`，教师出题/成绩为 `/programming/*`。页面和操作按持久化身份及课程关系开放；前端共用 `frontend/src/lib/platform-navigation.ts` 的导航策略，接口继续独立鉴权。旧网址保留重定向，选班/筛选参数随旧链接一起迁移。

2026-10-05 课程入口统一为「教学管理 → 课程」。课程页直接列出编程实验，提供教师选题、新建编程题单及成绩导出入口。编程题库仅提供题库和题单；独立编程课程列表、开班和名单页面已从前端删除。旧课程/名单链接按已授权的课程关联跳转，不假设管理课程 ID 与编程教学班 ID 相同。

学生没有全站或班级排行榜，旧 `/api/ranklist` 返回 404。后续按教师反馈加入的每题排行仅课程授权教师可用，学生不能查询其他学生的排行、代码或成绩。

服务器判题启用 C、C++ 和 Python 3。Java 尚未安装运行环境，提交接口会明确拒绝，避免进入无人处理的队列。Python 沙箱保留 chroot、ptrace 与资源限制；`patch-python-runtime.py` 使复制到沙箱的解释器及标准库可由 judge 用户读取、执行，不修改 bind mount 的系统库权限。

AI 已配置为 DeepSeek Flash。私有 `.env` 使用 `COURSE_AI_URL=https://api.deepseek.com/v1`、`COURSE_AI_MODEL=deepseek-flash`、`COURSE_AI_KEY`、`COURSE_AI_TIMEOUT`。若出口必须经过代理，在 `.env` 设置 `COURSE_AI_PROXY` 并重建/重启 API；代理只用于 AI 请求，内部账号请求不经过代理。凭据不写入仓库或前端。2026-10-04 的外网故障已定位为服务器未完成校园网准出。2026-10-05 用户在服务器终端完成短信 MFA 后，学校在线状态及 DeepSeek HTTPS 已验证恢复；平台真实出题 HTTP 200，模型学习建议 `mode=model`。复查草稿含 1 道题、1 个公开样例、3 组隐藏测试，保存后重读完整。认证脚本的在线状态误报已修复，使用 JSONP 查询。认证操作见 `campus-network-login.md`，验收指标见服务器 `/opt/hoj/qa-fixes/ai-recovery-verification-20261005.json`。健康接口的 `ai_configured` 表示配置存在，不代表外部模型已验证可达。

已发布题单的教师“复制为新草稿”会读取完整判题测试；缺失配对输出或无法读取目录时整次复制失败，不会保存一个悄悄缺少测试的副本。公开导出仍不含隐藏测试。

## 压力测试

压测方法见 [load-test-methodology.md](load-test-methodology.md)，复现脚本在 `load-test/`。原始结果保存在服务器 `/opt/hoj/load-test` 和本机 `.local/remote-deploy/load`。压测发现编程 API 默认软文件句柄上限为 1024；Compose 现在显式将两个 API 的 nofile 设为 65536，避免集中连接耗尽文件句柄。另将 PHP 账号适配器的工作进程上限设为 32、等待队列设为 4096；原默认队列在千人同时刷新会话时会返回资源不足。

脚本通过统一入口 3100 发起真实学生会话请求和 C++ 提交，不调用开发登录或模拟判题。`runner.js setup` 建立 1000 个临时学生、教学班、题目和 Cookie；`browse`、`login`、`judge` 分别施加日常、登录和判题负载。单档可以执行 `stage <名称> <并发数> <秒数> <间隔毫秒>`，单批判题可以执行 `burst <人数> [cpu]`。数据目录挂载到 `/work`，setup 另需只读挂载服务器 admin-account.json。负载容器使用 `hoj-web:amd64` 的 Node 运行时、host 网络、2 CPU 和 1GiB 内存，不安装常驻服务。

每次新压测使用空的私有工作目录；已清理的 fixture 不可复用。`monitor.py` 记录宿主与容器占用、数据库连接和队列；`cleanup.py` 先校验 fixture 并备份，再删除仅本次创建的数据和学生会话，恢复服务；`aggregate.py` 汇总结果。压测容器结束后删除，保留结果及备份。
