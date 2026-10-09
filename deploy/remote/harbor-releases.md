# Harbor 发布与 dell0 迁移记录

## 当前进度（2026-10-09）

现用服务器仍为 `10.249.12.21`（Huawei RH2288 V3，主机名 `proj317`）。没有切换到 dell0。

Harbor 暂按用户要求停止推进。项目 17 名称为 `hoj`；OIDC CLI 登录已成功，但当前账号只有 pull，没有 push，因此没有上传镜像。部署不依赖 Harbor：现网使用本地已验证、固定 ID 的七个应用/数据库镜像。dell0 的 SSH 地址、端口及登录配置尚待提供。

现网应用镜像源码版本为 `fbb4668096b2baf7c5caf0cc739e184976ee8083`；部署配置在后续 Git commit 中单独记录。`active-release.json` 固定应用版本和镜像 ID，`active-deployment.json` 记录配置 commit、配置哈希和验证结果。候选镜像已替换旧运行镜像；业务表记录数量保持，统一登录及实际 C/C++/Python AC/WA 验证通过，测试数据已清理。服务不使用 host 网络，core 的 privileged 已关闭；SYS_ADMIN/SYS_PTRACE 仍保留，不能视为完整沙箱安全验收。

已移除 96 个旧 HOJ 镜像标签，只保留七个当前镜像标签和七个上一运行版本的回退标签。没有执行全局 prune，其他服务镜像与运行数据未删除。旧源码、构建标记保留在归档和 Git 历史中。

定时备份使用 `backup.py`，每天 04:00 暂停入口并等待判题结束，停止写入后保存数据库、应用授权、配置、判题测试、附件及 Git bundle，最后恢复服务。服务器保留 14 份完整备份。Mac 的只读 SSH 下载任务保留 30 份，04:30 及每小时重试，逐文件核对大小和 SHA-256；Mac 休眠或校园网不可达时独立副本不会更新。三库恢复及应用授权恢复已验证。服务仍只有一台机器，独立备份不消除停机风险。

已回收 `/opt/hoj` 的源码和运行版本清单，对 815 份文件逐一核对哈希。功能代码与本机一致，仅有生成缓存、macOS 资源文件及两个旧补丁 Dockerfile 的差异。已检查容器可写层：没有发现额外功能源码修改；生成的 PHP 数据库配置和 judge.conf 属于私有运行配置。服务器数据仍需在切换前重新备份和同步，不能用旧的测试备份代替。

原有功能源码基线为 Git commit `0c992f3`（上游基线 `d0ac7d7`）。本机私有目录 `.local/dell0-migration` 保存服务器源码归档、SHA-256 清单、运行镜像清单及 Git bundle。账号、课程、学生代码、判题测试和附件不会放入镜像仓库。

已将 2026-10-07 18:35:38 的数据库、应用授权 SQL、私有配置、判题文件、题单数据及附件备份复制到本机私有目录，验证文件大小、SHA-256 和权限。三个数据库已在临时 MariaDB 中恢复，表数分别为 jol 23、grader 26、codemind_course 9，8 条平台数据库账号授权恢复成功。临时数据库使用 network-none，无端口映射，结束后已移除。该备份仍是迁移前在线备份；正式切换必须重新冻结写入后备份，包含这之后的改动。

已用新构建的判题镜像，在隔离临时数据库及现网中验证 `privileged=false`、额外 capability `SYS_ADMIN` / `SYS_PTRACE`、移除 `NET_RAW` 和 `no-new-privileges`。C、C++、Python 各一组正确解 AC 和错误解 WA，均通过。设置已进入基础 Compose 并在现网生效；兼容 override 保留为 `compose.judge-caps.yml`。平台共享 bridge 网络命名空间，仅发布 3100 和 9002，内部接口绑定该命名空间的 loopback。SYS_ADMIN 仍较宽，迁移目标上需复验。

## 后续发布入口

在干净、已提交的 Git checkout 中构建 Linux amd64 镜像：

```bash
python3 deploy/remote/release.py build
```

脚本从 `git archive HEAD` 构建六个应用镜像，同时镜像化 MariaDB。迁移时必须通过 `--db-image <现网镜像digest或ID>` 沿用当前数据库构建；不可根据版本字符串猜测镜像标签。已缓存的不可变镜像可直接验证并使用；普通标签会重新拉取，实际 ID 和上游摘要写入清单。每个应用镜像附带 Git revision 和源码归档 SHA-256，使用完整 commit 标签 `git-<40位SHA>`；不覆盖当前运行的 `amd64` 标签。`releases/<commit>/release.json` 记录每个镜像的本地 ID。构建失败保持 `building` 状态，不能发布。

源码身份由 Git 与归档哈希固定；基础镜像、apt 软件源仍会随时间更新，因此这不是逐字节可重复构建。发布后以 registry digest 固定实际运行镜像。

`build.sh` 仅转调上述发布构建入口。`start.sh [release.json路径]` 先验证完整清单，构建版本还会核对本机七个镜像的 ID 与源码标签，发布版本先拉取固定 digest，再启动。省略清单参数时使用当前 Git commit 对应的清单；不会因文件时间新旧而猜选版本。原 `amd64` 标签留在基础 Compose 中用于旧部署兼容，新启动入口会对七个服务全部覆盖。

功能补丁 Dockerfile 已合并到六个正式 Dockerfile，旧文件可在 Git 基线 `0c992f3` 中查阅。服务器当前运行镜像与旧回退镜像尚未删除，清理应在迁移验收后按明确的保留清单执行。

使用已有项目 robot 凭据或 OIDC 用户的 CLI secret 登录 Docker。凭据放在私有文件中，通过 `docker login --password-stdin` 输入；不能把学校 SSO 网页密码当成 robot secret。项目 robot 仅需此项目的 pull 和 push 权限，不需要删除权限。

```bash
python3 deploy/remote/release.py publish releases/<commit>/release.json
```

发布脚本先检查全部镜像的平台、ID 和源码标签，再逐个上传至 `harbor.osa.moe/hoj/<service>:git-<commit>`，按 digest 拉回验证 ID。全部成功后才生成 `compose.images.json`。后续启动使用原配置加此 override，七个服务都会按 Harbor digest 拉取：

上传前还会检查远端同名 commit 标签。标签已存在且内容不同时停止发布，避免用同一源码版本的第二次构建覆盖已部署镜像；需要提交明确的版本更新后再构建。无法读取标签（权限或网络故障）时也会停止。若 Harbor 项目启用标签不可变策略，还可在仓库端防止其他客户端覆盖。

```bash
docker compose --env-file .env -f deploy/remote/compose.yml \
  -f releases/<commit>/compose.images.json pull
docker compose --env-file .env -f deploy/remote/compose.yml \
  -f releases/<commit>/compose.images.json up -d --wait
```

Harbor 官方说明：[推拉镜像](https://goharbor.io/docs/2.14.0/working-with-projects/working-with-images/pulling-pushing-images/)、[项目 robot 账号](https://goharbor.io/docs/2.14.0/working-with-projects/project-configuration/create-robot-accounts/)。项目为公开状态；上述构建不会携带 `.env`、私有配置、运行数据库、隐藏测试或学生附件。每次入库源码仍应审查是否误提交秘密。

## 迁移执行顺序

1. 登录 dell0，核实机器身份、磁盘、CPU、内存、现有服务和端口。Harbor 未启用时，采用 docker save/load 传输清单中七个本地镜像，再逐个核对镜像 ID 和源码标签；不用拉取可变标签。当前 Compose 仅发布 3100/9002，不能覆盖其他服务端口。目标机须重复实际判题验证。
2. 在独立目录拉取并验证发布镜像。保留原服务器运行版本和配置，先完成空环境恢复演练，不在演练期间接受真实写入。
3. 正式切换前核对服务器最新源码和配置，暂停平台新写入，等待判题队列清空。备份账号、课程、题目、成绩和授权，保存配置、评测文件、题单私有数据和对象附件。现有 jol 含 MyISAM 表，不能仅依赖 InnoDB 的 single-transaction 备份；需要一致的锁表转储或全部停止后冷备份。
4. 将完整备份复制到 dell0 和本机私有目录，并验证哈希。不能直接复制正在写入的 `data/mysql`；数据库用户授权和表排序规则也必须保留。迁移时沿用密码和会话密钥，不运行生成新秘密的 `configure.py`。
5. 更新目标访问 Origin 和对象存储公共地址。验证教师/学生登录、学生权限、C++ AC/WA、权重成绩、代码浏览、附件下载及 AI 出题。通过后开放新入口；原入口停止写入，避免出现两套分叉数据。
6. 记录最终配置、数据备份与镜像 digest。原机保留回退副本；历史 Dockerfile/镜像仅在新版本完成验证且回退方案落实后清理。不得用全局 prune 删除无关服务镜像。

源机本地备份仍是单机备份；只有数据实际复制到独立机器并完成恢复验证后，才能声称解决了异地备份问题。
