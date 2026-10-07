# Grader Backend

Rust / Axum 后端，使用 Diesel + MariaDB、Redis 缓存和 S3 兼容存储。部署编排在兄弟仓库 [`../deploy`](../deploy/README.md)，前端在 `../frontend-fresh`。

## 本地开发

需要 Rust 1.95+、Docker Compose；外部拨测另需 Bun。以下命令从本仓库根目录运行，仅使用本地开发数据库。

### 1. 启动依赖

```bash
docker compose --project-directory ../deploy -f ../deploy/compose/backend-local.yml up -d --wait
cp .env.example .env
```

修改 `.env` 中对应配置：

```dotenv
DATABASE_URL=mysql://grader:local-grader@127.0.0.1:13316/grader
REDIS_URL=redis://127.0.0.1:16379
BIND=127.0.0.1:8000
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
AWS_ACCESS_KEY_ID=local-grader
AWS_SECRET_ACCESS_KEY=local-grader-storage
S3_PUBLIC_URL=http://127.0.0.1:19016
S3_INTERNAL_URL=http://127.0.0.1:19016
S3_BUCKET_NAME=grader-uploads
SUGGEST_EXTRACTOR_ENDPOINT=http://127.0.0.1:50051
DOCUMENT_CONVERTER_URL=http://127.0.0.1:19080
```

- 分别运行 `openssl rand -base64 32`，为全新本地环境填写 `SESSION_SECRET_KEY`、`CSRF_SECRET`；不要提交 `.env`。
- 打开 MinIO 控制台 `http://127.0.0.1:19017`，使用上面的 AWS 用户名和密码登录，创建私有 bucket `grader-uploads`。
- 自动批阅需另行启动真实 `suggest-extractor`；学校 SSO 需配置 `HITIDS_*`。基础账号登录不依赖这两项。

### 2. 迁移、创建管理员、启动

```bash
cargo run -- migrate
read -r -s GRADER_ADMIN_PASSWORD
export GRADER_ADMIN_PASSWORD
cargo run -- create-admin --username admin --real-name 开发管理员
unset GRADER_ADMIN_PASSWORD
cargo run -- serve
```

`read` 时输入至少 12 字节的管理员密码并回车，不会回显。管理员只需创建一次。程序自动读取 `.env`；修改代码后重新运行 `cargo run -- serve`。

健康检查：`curl -fsS http://127.0.0.1:8000/healthz`。前端 Vite 默认将请求代理到该后端，默认开发端口为 `3000`。

只做前端开发时，可使用 [完整容器开发流程](../deploy/docs/development.md)；重建后端镜像仍需下述本机编译工具，使用已有镜像则不需要。不要同时运行两套后端占用 `8000`。

## 数据库变更与检查

`src/schema.rs` 由 Diesel CLI 生成，不手改。首次安装 CLI 需要本机 MySQL/MariaDB 开发库：

```bash
cargo install diesel_cli --version 2.3.12 --no-default-features --features mysql --root .local/diesel-cli --locked
.local/diesel-cli/bin/diesel migration generate change_name
```

填写新迁移的 SQL，版本号须大于现有最大版本；涉及 MariaDB DDL 时在该迁移目录的 `metadata.toml` 设置 `run_in_transaction = false`。不要修改已上线迁移。然后执行：

```bash
.local/diesel-cli/bin/diesel migration run  # 自动更新 src/schema.rs
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
```

运行中的服务应在迁移后重新启动。项目使用 `test/` 下的独立 Bun 外部拨测，不写 Rust 内嵌测试。`tool/` 只放可重复执行的运维或维护工具；仅执行一次的检查、修复和发布验证脚本放在 `/tmp`，不提交到仓库。拨测前执行 `bun install --cwd test --frozen-lockfile`，具体环境变量见 [AGENTS.md](AGENTS.md#local-external-verification)；拨测会创建、修改数据，禁止指向生产。

## 服务配置

- 默认数据库连接池为 50，请求体上限为 50 MiB；配置项及默认值见 [`.env.example`](.env.example)。
- S3 bucket 保持私有，客户端通过预签名 POST 上传，后端授权后提供下载链接。`S3_PUBLIC_URL` 必须能被客户端访问，`S3_INTERNAL_URL` 供后端访问。
- PDF/Word 可视化批改依赖私有 Gotenberg，使用 `DOCUMENT_CONVERTER_URL` 配置。本地 Compose 提供 `127.0.0.1:19080`；生产仅允许内网访问，不要公开转换器端口。支持 PDF、DOC、DOCX，文档上限 50 MiB / 500 页。
- 独立 PDF/Word 不计算、不保存也不校验原稿或预览哈希。首次准备仅为 PDF 元数据检查或 Word 转换读取原稿；已有预览的打开与导出前检查只查询数据库并签发 S3 下载地址，保存批注只执行数据库事务，不读取对象内容。浏览器从 S3 直接下载 PDF，不做内容哈希校验；保留提交文件标识、文档 `version`、批改 `revision`、页数及权限检查。重新提交清除旧文档与批改；绕过提交接口原地覆盖同一 S3 key 不再通过内容变化检测。
- 迁移 `20260929000001_document_identity` 删除 `grading_documents.source_sha256` 和 `pdf_sha256`，保留已有预览、批注及版本。必须停止旧后端、备份后应用，再同时发布新版前后端；哈希无法由 SQL 恢复，回退旧版需要恢复迁移前备份，不能直接降级应用。
- ZIP 混合批改使用 `GET/PUT /api/submissions/{id}/grading/code`，授权与文档批改一致。浏览器下载、解压和重放 ZIP 批改，后端不下载或解压原稿，也不读取 S3 内容校验差异或批注。GET 返回由提交文件标识和提交时间生成的 `source_version`；`source_sha256` 为已保存的客户端原稿哈希，未保存时为 `null`。PUT 携带上述来源字段、`revision`、`base_cents`、`files` 和 `marks`；`files` 元素固定为 `{path, patch}`，其中 `patch` 是相对原稿的标准 unified diff 文本。旧 `original_sha256`/`edits` 文件补丁格式直接移除，无兼容分支，也不需要改变数据库 JSON 列。后端不解析或执行教师补丁，去掉替换区间排序、重叠及逐文件哈希校验；保留元数据长度、批注/评分边界、权限与来源/修订号并发检查。保存时只读取现有来源和修订号，不加载旧补丁全文；总分与状态在同一事务更新。每份 review 最多 2000 个修改文件、500 条批注，序列化 files/marks 各小于 16 MiB。原 ZIP 不改写，PDF 成员直接在浏览器打开。
- ZIP 批改及成员文档预览只接受原文件名以 `.zip` 结尾的提交（不区分大小写），不再根据作业 ZIP-only 配置兼容 UUID/无扩展名历史文件名；真实 `.ZIP` 文件不受作业配置变化影响。新上传流程将客户端原文件名完整保存在 `file_info.file_name`，UUID 仅作为 `file_ident` 存储键。旧数据应在用户核验并明确批准后限定记录修复 `file_name`，不得据此改动 `file_ident`、S3 原对象或批改内容；不能从 UUID 还原已丢失的原文件名，也不能用删除后端校验掩盖错误元数据。发布此严格准入版本前须先完成获准的数据修复；未获准时仅允许本地实现和验收。
- 去除原有批改使用 `GET /api/submissions/{id}/grading/reset?source_file_ident=<当前显示的提交文件标识>` 获取 `{version}`，用户确认后向同一 URL 发送 `DELETE`，JSON body 为 `{"version":"…"}`；成功返回 `204`。两步都要求当前课程批改权限，DELETE 在与保存相同的课程/作业、用户、提交锁顺序下重新授权并比较版本。版本是提交来源、提交/更新时间、成绩/状态、代码修订号和文档版本/修订号的 SHA-256 元数据快照，不读取补丁或批注 JSON，不访问 S3；损坏的旧 JSON 也可去除。来源不匹配或确认期间已有更改返回 `409`，不改变任何批改。
- 去除会清空代码修改、全部批注及提交成绩/状态（数据库为 `0` / `0`，接口按未批改显示），但保留原始上传和教师评分项库。代码 review 保留递增修订号的空墓碑，即使此前尚未保存也创建墓碑，防止旧页面以修订号 `0` 恢复批改；空 `source_sha256` 仅为内部状态，GET 返回哈希、成绩、批改人及批改时间均为 `null`，起始分使用当前教师评分设置，后续 PUT 仍须提供合法哈希和当前修订号。空墓碑不计为已批改，不阻止直接评分。独立文档删除 review 并轮换文档 UUID 版本，保留仍匹配当前原稿的缓存预览；仅删除来源不匹配的派生文档记录。旧代码/文档页面保存均返回冲突，重新载入后可重新批改，无需数据库迁移。
- ZIP 中的 DOC/DOCX 成员先请求 `GET /api/submissions/{id}/grading/code/document?source_version=...&original_sha256=...`，返回 `{original_sha256, sha256, page_count, url}` 或未命中时的 `null`；命中只查询数据库并签发下载地址，不接收原文、不调用转换器。未命中才请求同一路径的 `POST ?source_version=...&extension=doc|docx`，类型为 `application/octet-stream`，body 仅含解压后的单个成员（最多 50 MiB），不是 ZIP。转换结果按提交和原文哈希持久缓存，重复打开使用同一份 PDF。准备阶段合并权限、来源和缓存查询；外部转换前释放数据库连接，写入时保留必要的锁定复查和并发首次提交结果。文档批注与代码批注共同计分和导出。预览上传前注册 pending 文件，清理排除被引用的预览；重新提交清除旧 review 和成员缓存，删除提交级联清除缓存，失去引用的预览由普通清理回收。
- ZIP 图片批注在同一 `marks` JSON 中保存 `{path, image_sha256, mark_id, id, reason, delta_cents, page, x, y, width, height}`。与文档批注共用页码/坐标、分值、标识去重及权限校验，和其他批注共同计分；保存恢复不需要新增数据库列或迁移。后端不下载或解码图片；格式、动画、实际页数和像素限制由浏览器在预览、重放和导出时检查。学生仍不能读取图片批注或扣分项目；完整批改 ZIP 在浏览器生成，不新增服务端归档输出或原文件改写接口。
- 新迁移 `20260928000000_code_grading`、`20260928000001_assignment_score_visibility`、`20260929000000_code_grading_documents` 必须在启动新版服务前应用。作业 `show_score` 默认 `false`，创建/修改可显式设置；隐藏时学生提交接口中的 `score` 为 `null`，公开时只返回总分。批注、代码差异和批改报表始终要求课程批改权限；教师和课程助教不受成绩公开开关影响。
- Redis 为可选缓存；留空 `REDIS_URL` 可禁用。多后端实例应连接同一数据库和 Redis，并使用一致的会话密钥及缓存前缀。

## iOS 统一身份认证

配置 `HITIDS_CLIENT_ID`、`HITIDS_CLIENT_SECRET` 及学校提供的认证地址。`HITIDS_REDIRECT_URI` 仍是后端 HTTPS 地址 `/api/auth/callback`，不需要把 App URL scheme 注册为学校 OAuth 回调。

客户端通过 `ASWebAuthenticationSession` 登录，回调 scheme 为 `grader`：

1. App 生成随机 `state` 并暂存，打开 `/api/login/sso?next=<URL 编码后的 /api/auth/mobile_bridge?state=…>`。
2. 学校认证成功后，浏览器获得后端会话并跳转到 `GET /api/auth/mobile_bridge?state=…`。该接口要求已登录，`state` 为 1–128 个 ASCII 字母、数字、`-`、`.` 或 `_`。
3. 后端返回 303，跳转到 `grader://auth/callback?ticket=…&state=…`。App 先核对 `state`，再发送 `POST /api/auth/mobile_exchange/`，JSON body 为 `{"ticket":"…"}`；兑换不要求已有 cookie 或 CSRF token。
4. 兑换成功返回当前用户的 `id`、`username`、`real_name`、`role`、`password_expired`，同时通过 `Set-Cookie` 设置独立的 `sessionid` 和 `csrftoken`。`URLSession` 保存 cookies，后续写请求发送 `X-CSRFTOKEN`。

ticket 有效期 60 秒、只能兑换一次；同一浏览器会话再次生成 ticket 会替换前一个。数据库只保存摘要，来源会话撤销或账号停用后不能兑换，无效、过期或已兑换的 ticket 返回 401。票据保存在共享数据库，不依赖 Redis 或单实例内存。回调 URL 不含会话 cookie；客户端及代理不要记录 ticket 或认证查询参数。

上线前执行普通 `migrate`，再启动新后端；学校 SSO 配置与网站登录共用。真机需要能访问校内服务，服务地址与兑换地址必须属于同一后端环境。

## 镜像构建

Rust 在本机原生运行，通过 `cargo zigbuild` 交叉编译 Linux GNU 目标（glibc 2.36，对应 Debian Bookworm）；Docker 只打包二进制，不在模拟架构容器内编译 Rust。迁移 SQL 在编译时嵌入，不需要向镜像复制源码或数据库配置。

### 本机工具与缓存

需要 Rust 1.95+、`cargo-zigbuild`、Zig、本机 C 编译器、Git，以及已启动的 Docker 和当前 Docker context 的本地 Buildx builder；推送前需 `docker login harbor.osa.moe`。macOS 的本机 C 工具链由 Xcode Command Line Tools 提供。脚本只检查工具，不自动安装。

```bash
cargo install cargo-zigbuild --locked
rustup target add x86_64-unknown-linux-gnu  # 生产 amd64
rustup target add aarch64-unknown-linux-gnu # 可选：arm64 本地容器
```

Zig 和 Docker 请按各自官方说明安装。CMake 不作为强制前置条件；仅当依赖选择 CMake 构建路径时，按编译报错安装。`build.rs` 使用 `protoc-bin-vendored` 的本机 protoc，不需要系统 protoc 或 Docker 编译器；后端不需要 MySQL 开发库（Diesel CLI 单独需要）。

- Cargo 产物默认复用本仓库 `target/`；设置 `CARGO_TARGET_DIR` 可改用其他持久目录，相对路径按仓库根目录解析。脚本对编译和打包使用同一路径，GNU 目标产物在 `<target-dir>/<triple>/release/`。
- Cargo 下载缓存位于 Cargo home，Zig 使用自己的本机缓存；它们都不是 Docker 缓存。清理 Docker build cache 不会清理这些目录；不要在日常构建前 `cargo clean`。
- 打包只临时复制 `grader-backend`、`register_oauth_client`、`migrate_upload_objects` 和 Dockerfile，成功或失败均清理暂存目录。仓库 `.dockerignore` 默认拒绝其他文件，`.local/`、`.env`、源码和主机缓存不会进入构建上下文。
- 数据卷和本地备份不属于编译缓存，不能随缓存一起清理。

### 低频构建运行时基础镜像

仅运行时依赖或基础系统需要更新时执行；日常后端构建直接复用已发布的运行时镜像：

```bash
scripts/build-runtime-image.sh harbor.osa.moe/grader/backend-runtime:bookworm-amd64 --push
```

默认 `BASE_IMAGE=debian:bookworm-slim`、平台 `linux/amd64`。脚本优先使用架构匹配的本地基础镜像，否则从其真实仓库拉取；可用 `BASE_IMAGE` 指定已加载的官方基础镜像或普通 Harbor 项目镜像，不依赖 Harbor 的 Docker Hub 拉取代理。若 Docker Hub 不可达，先在可访问处取得官方镜像并加载/推送到普通 Harbor 项目，不能假设代理中存在它。需要更新已经缓存的 Debian 基础镜像时，先显式 `docker pull --platform linux/amd64 debian:bookworm-slim`。

`Dockerfile.runtime` 安装 CA 证书、健康检查所需的 curl 和 C 运行库依赖，使用 UID:GID `10001:10001`。ARM 运行时使用独立标签，不能覆盖生产 amd64 标签：

```bash
scripts/build-runtime-image.sh harbor.osa.moe/grader/backend-runtime:bookworm-arm64 --platform linux/arm64 --push
```

基础镜像的 apt 步骤可能需要 Docker 的跨架构模拟，但 Rust 编译不需要。

### 日常构建后端镜像

```bash
IMAGE="harbor.osa.moe/grader/backend-rs:$(git rev-parse --short=12 HEAD)"
scripts/build-image.sh "$IMAGE" --push
```

`scripts/build-image.sh IMAGE [--platform linux/amd64|linux/arm64] [--push]` 默认生产 amd64，执行 `cargo zigbuild --release --locked --bins`，使用 glibc 2.36 目标。`RUNTIME_IMAGE` 默认按架构选择 `harbor.osa.moe/grader/backend-runtime:bookworm-amd64` 或 `bookworm-arm64`，可覆盖为相同架构的其他运行时标签或 digest。两个脚本均先将单平台镜像加载到本地 Docker，只有指定 `--push` 才推送。

发布构建要求 Git 工作区干净（包括未跟踪文件），镜像记录 `org.opencontainers.image.revision`；本地不推送的构建允许未提交源码，并以 `io.grader.source.dirty` 标注。生产只发布已提交源码，不重复使用可变的发布标签。

Apple Silicon 本地容器开发示例：

```bash
scripts/build-runtime-image.sh grader-backend-runtime:arm64 --platform linux/arm64
RUNTIME_IMAGE=grader-backend-runtime:arm64 \
  scripts/build-image.sh grader-backend:dev --platform linux/arm64
```

Compose 和 `dev-up` 使用该脚本生成的镜像；直接 `docker build .` 不再编译源码，也不能代替该脚本。已有三个二进制的入口和命令不变，Docker 中默认仍运行 `grader-backend serve`。

## 部署更新

唯一生产后端发布入口在兄弟仓库，完整说明见 [`../deploy/README.md`](../deploy/README.md)。准备并推送好后端镜像后，从部署仓库执行：

```bash
python3 scripts/release.py --host dell1 --image "$IMAGE"
```

该命令在维护前预拉镜像，然后停写、将一份压缩数据库备份直接流到本地并校验、迁移、启动后端、检查容器健康与 `/healthz`、恢复访问后结束；不发布前端、不做生产业务拨测、全库比较、恢复演练或 S3 复制。备份与旧镜像引用保留在本地，具体位置可由 `--backup-dir` 指定。

迁移或启动失败时保持维护，不自动恢复 schema 或切回旧镜像。保持会话密钥、配置和数据卷不变，不执行 `down -v`，不删除既有备份或已部署迁移。纯前端发布流程仍由部署仓库管理。
