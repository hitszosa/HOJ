# Grader 2 Frontend：基于 Vue 的作业管理平台

HITSZ Grader 2 作业平台的 Vue 3 + Vuetify 4 + TypeScript 前端，对接 Rust Axum 后端。

核心功能：学生提交作业，教师与助教批改统计，管理员管理用户与课程。

## 特性 Features

- 账户认证：统一身份认证（SSO）与本地账号登录，OAuth 授权页（含 PKCE），修改密码，登录态过期自动跳转
- 用户管理：学生、教师、管理员三种角色，以及课程内的助教
- 统一平台顶部栏：“教学管理 / 编程题库”在两边使用相同样式与固定位置，原页面内的跨模块入口合并到顶部；共享样式由主站 `/platform-shell.css` 提供
- 教学管理导航：总览、课程、用户；管理页面使用相同导航与外观，系统维护与显示偏好折叠收纳
- 课程管理：单一课程列表按学年学期分组，管理员在列表新建课程，在具体课程的“名单与课程设置”中维护负责人、助教和学生；负责教师仅可管理本课程学生与助教名单
- 显示偏好：支持卡片式和列表式两种显示方式切换，偏好持久化到浏览器；课程总览按学期标签分组；长标题右侧省略、悬停查看完整名称；明暗主题默认跟随系统
- 本地筛选：课程列表和作业页本地筛选已加载数据，不发送搜索请求
- 作业管理：创建、修改、发布、删除作业，可设截止时间、扩展名白名单、大小上限
- 提交：学生通过预签名 URL 直传 S3/MinIO，截止前可重复提交，可下载自己上一次的提交
- 批改：已交 / 未交名单，逐份打分与「下一份」连续批改，批量打包下载全部提交，PDF/Word 作业页面内打开工作区在线批改，拖动评分项到文档或点击项后点击文档生成批注，支持移动
- 多人协作：在线批改支持导入当前作业其他教师配置的去重列表，创建独立副本
- 退出进度保存：弹窗 Esc 使用取消路径，编辑课程有未保存修改时先确认放弃
- 统计：Highcharts 成绩图表、全课程分数表、CSV 导出；含学生信息、批改者姓名、成绩及批改详情的成绩汇总表格
- 管理面板：用户与课程管理、xlsx/csv 批量导入用户、站点公告、操作审计、存储与监控入口
- 文档中心：Markdown 用户文档页
- i18n：中英双语，用户友好

## 技术栈 Tech stack

- 框架：Vue 3 + Vuetify 4
- 构建：Vite 8 (Rolldown), TypeScript, lightningcss, Sass
- 路由：unplugin-vue-router + vite-plugin-vue-layouts
- 状态：Pinia + pinia-plugin-persistedstate
- HTTP：Axios（CSRF 取自 `csrftoken` cookie）
- 文件与可视化：Highcharts, @zip.js/zip.js, xlsx, filesize, date-fns
- 文档与 PDF：pdfjs-dist, pdf-lib
- 开发：unplugin-auto-import, unplugin-vue-components, unplugin-fonts, unplugin-vue-markdown, vue-tsc, ESLint, Prettier
- 包管理器：pnpm

## 快速开始 Quick start

前置要求 Prerequisites

- Node.js `^20.19.0 || >=22.12.0` (required by Vite 8); pnpm 10+
- 启动后端，默认 `http://127.0.0.1:8000`

```bash
git clone --recurse-submodules git@git.cs-lab.top:grader/frontend-fresh.git
cd frontend-fresh

# 若 clone 时漏掉子模块
git submodule update --init --recursive

pnpm install      # 安装依赖
pnpm dev          # 启动开发服务器
```

先启动本地后端及依赖。开发服务器监听 `http://localhost:3000`。

## 配置 Configuration

| 变量 | 描述 | 默认值 |
| --- | --- | --- |
| `VITE_GRADER_BACKEND_URL` | 后端服务器代理 `/api`, `/oauth`, `/admin`, `/static`, `/swagger*` | `http://127.0.0.1:8000/` |

`vite.config.mts` 从 `process.env` 读取该变量，因此只能在命令行上传入：

```bash
VITE_GRADER_BACKEND_URL=http://192.168.1.10:8000/ pnpm dev
```

写进 `.env` / `.env.local` 不生效。Vite 只把它们暴露给 `import.meta.env`，不会注入到配置文件的 `process.env`。

## 开发 Development

### 启动开发服务器

```bash
pnpm dev          # vite, port 3000
```

前端代码里一律使用后端相对路径（`/api/...`），由开发服务器代理转发。

### 构建与预览

```bash
pnpm build        # vue-tsc --noEmit && vite build, output in dist/
pnpm preview      # preview the build locally
```

静态资源输出到 `dist/static`。构建包含类型检查，`vue-tsc` 报错会导致构建失败。

### 其他脚本

| Command | Description |
| --- | --- |
| `pnpm lint` | `eslint . --fix`; 本项目现有部分 lint 错误 (`@typescript-eslint/no-explicit-any`, `no-empty-object-type`, `no-unused-vars`), 故不设为检查项 |
| `pnpm gen-mock-user` | 向 `tmp/mock-batch-users.csv` 写入 100000 条 mock 用户; 需要先 `mkdir -p tmp` 手动创建文件夹 |

### 目录结构

```text
src/
  api/          # Backend endpoints, all through api/axiosInstance.ts
  components/   # Reusable components, globally registered
  layouts/      # default, admin, hill (login/consent), docs
  locales/      # Global i18n messages
  pages/        # File-based routes; pages/docs/ is a git submodule
  plugins/      # vuetify, i18n, router, pinia registration
  router/       # Router instance and login guard
  stores/       # Pinia: app, theme (persisted), users
  styles/       # Global styles and Vuetify settings
  utils/        # Confirm dialogs, downloads, error messages, date and course helpers
vite.config.mts # Plugins, dev proxy, build options
```

### 开发约定

- 路由由 `src/pages/**` 的文件结构决定，页面元信息写在页面末尾的块里：

  ```yaml
  <route lang="yaml">
  name: my-page
  meta:
    title: 课程列表     # 文档标题（中文）
    titleEn: Courses   # 文档标题（英文）
    layout: default    # 可选，指定布局
    no_login: true     # 可选，跳过登录守卫
  </route>
  ```

  未标 `meta.no_login` 的路由先请求 `GET /api/auth/current_user/`，失败跳转 `/login?next=...`。
  前端没有角色级路由守卫，`/admin2/*` 为隐藏导航项，权限由后端判定。
- `vue` / `vue-router` API、`src/components`、Vuetify 组件、Markdown 页面自动导入；不要手工修改 `auto-imports.d.ts`、`components.d.ts`、`route-map.d.ts`，是随代码提交的生成产物，。
- `@` 是指向 `src` 的 alias。
- 页面文案写在 SFC 的 `<i18n lang="yaml">` 块内，通用文案放在 `src/locales/common/{zh,en}.yaml`；default & fallback 为 `zh`。
- 所有请求经 `src/api/axiosInstance.ts`（15s 超时，401 清空用户并跳登录，5xx 弹出常驻 Snackbar）；文件上传下载走预签名 S3 URL，单独放宽时限。
- `src/pages/docs` 是独立仓库，文档在子模块内提交，再更新本仓库的子模块指针。

## 可视化批改

- PDF/Word 受限作业在原评分入口打开文档工作区；ZIP 提交打开代码工作区，其他格式保留原下载评分流程。工作区固定到视口底部，只有文档和评分项列表内部滚动。文档右栏依次为学生信息、评分项列表、原文件/批改 PDF 下载、分数输入和保存；加号固定覆盖在评分项列表右下角。
- 文档和 ZIP 工作区的警告/错误条采用紧凑密度，并固定为内容高度（`flex: 0 0 auto`），不会挤占或拉伸预览区。错误条中“重新加载”右侧提供“去除原有批改”（Remove previous grading）：先按当前显示提交的文件标识获取独立版本令牌，再确认永久删除代码修改、所有批注和成绩；取消或请求失败不会清空本地批改。获取令牌不依赖原稿加载、补丁重放或旧批改 JSON 能否解析。
- 去除批改成功后重新读取原稿，清空撤销/重做和未保存状态，恢复未批改状态；沿用本轮基准分，没有会话基准分时重新询问。学生上传、评分项库和可用文档预览缓存保留；评分项弹窗有未保存输入时不可执行去除。操作及确认期间禁止重复执行、保存、切换提交或离开；存在待切换提交时也不可去除。服务端重新鉴权并校验版本，其他教师保存或学生重交导致的变化返回冲突，不会删除更新后的批改。ZIP 清空记录仍保留递增修订号，独立文档更新版本，旧页面不能通过保存恢复已去除的批改。
- 加号弹窗只填写分值与理由。导入页只显示当前作业其他教师配置的去重列表，不包含同课程的其他作业；点击未选项会创建新的独立副本，再次点击已选项会从自己的配置中移除。匹配按理由与分值进行，同理由不同分值可独立并存，不按来源 ID 覆盖修改，也不改变他人配置或已有批注。
- 拖动评分项到文档，或点击项后点击文档；选中批注后用 Backspace/Delete 删除，方向键微调位置。分数框显示即时总分，也可直接输入调整；分值精确到 0.01，不限制在作业满分以内。Enter 保存，Ctrl/Command+Enter 仅在保存成功后进入下一份；弹窗内不触发评分快捷键。预览左上角的信息按钮悬停显示操作技巧。
- 未批改的提交首次进入时输入本轮基准分，同一作业连续批改沿用该值；已批改的提交直接恢复已保存的批改和成绩，不再询问基准分。基准分只保存在当前会话，不写入浏览器长期偏好。
- 文档和代码批改共用 `gradingHistory.ts` 中的撤销/重做栈与快捷键识别。Ctrl/Command+Z 撤销，Ctrl/Command+Shift+Z 或 Ctrl+Y 重做，也可点击工具栏按钮。新增/删除批注、移动文档批注、代码编辑和改分按操作顺序恢复；保存不清空当前历史，重新加载或切换提交后重新开始。历史最多保留 100 步，并按快照内容保守估算限制在 16 MiB 内，超过时淘汰最旧记录；这不是浏览器总内存上限。ZIP 工作区用历史保存点判断未保存状态，不再反复序列化全部代码；保存后撤销、重做和分支编辑保持正确的保存点身份。评分项弹窗的输入框保留原生文本编辑快捷键。
- 删除或恢复批注后，焦点保留在批改工作区以便继续使用快捷键；工作区外壳不显示焦点框，具体批注与按钮仍保留选中和键盘聚焦提示。
- PDF/Word 预览按整份文档连续排列，可直接向下滚动到最后一页；页码随滚动更新，翻页按钮仅用于快速跳转。PDF.js 只渲染视口及附近页面，离开附近范围时回收画布，批注始终绑定各自页码和归一化位置；缩放保留当前阅读位置。字体、CMap、ICC 和图像解码资源按版本自托管，不依赖外部 CDN。批改 PDF 由 `pdf-lib` 按需生成，原文不栅格化，中文评分标记与预览使用同一绘制函数，支持旋转/裁剪页。保存前离开会确认；缓存页面停用时释放 PDF worker，返回时读取最新文档。
- 独立 PDF/Word 的准备响应不再包含原稿或 PDF 哈希，打开与导出均不计算或校验内容哈希。预览通过后端签发的地址从 S3 直接下载；已有预览的打开、批注保存及导出前版本检查不会让后端下载原稿。首次 PDF 元数据检查或 Word 转换仍由后端处理；提交文件标识、文档版本、批改修订号与页数检查保留。ZIP 成员转换缓存和批注标识不受影响。
- 作业列表导出的 Excel 只有一张“成绩汇总”表，不受当前筛选或分页限制，每个学生一行。保留学号、学生姓名、批改者姓名、成绩等列，最后增加“详细”：同一个单元格内按 `1. 理由 -5`、`2. 理由 +10` 编号、逐条换行，启用自动换行及对应行高。不再输出评分项汇总或逐条明细分表，也不显示数据库 ID 或提交编号。零分、未批改和未提交分别处理，文本按字符串单元格写入，不解释为公式；超过 Excel 单个单元格 32767 字符上限时明确报错，不静默截断。
- 弹窗 Esc 使用取消路径；编辑课程有未保存修改时先确认放弃。窄屏提交列表通过横向滚动保留表头和短字段完整文字。
- ZIP 混合批改工作区左侧是文件树，右侧是共用的评分项、已有批注和总分。代码使用 CodeMirror 6；选中代码后单击评分项直接添加批注，拖动评分项到代码时批注整行。点击扣分标签或右侧批注后可用 Backspace/Delete 删除，代码文本编辑不会误删批注；支持 Ctrl/Command+S 保存。不运行学生代码或渲染上传的 HTML。
- 文件树在侧栏内独立纵向及横向滚动，长文件名保持单行完整布局，可左右滚动查看后缀；不会撑宽编辑区。目录每层缩进 12px，根部留白及折叠按钮、文件图标间距收紧，文件选择与目录展开/收起行为不变。
- 点击 ZIP 内的 PDF、DOC、DOCX 会切换到与独立文档批改共用的 `GradingDocumentViewer`，保留连续预览、缩放、拖放/点击评分项、移动和删除批注。PDF 直接在浏览器打开；Word 先按成员哈希查询持久转换缓存，只有未命中才上传解压后的单个成员，重复打开不再上传原文或重新转换。代码与各报告共用总分、保存和撤销/重做记录；右侧批注按文件及行号/页码定位，代码位置使用共享换行索引，不再逐条扫描全文。支持下载原报告及当前已保存的批改 PDF，导出汇总采用整份提交的已保存总分。
- ZIP 内的 PNG、JPEG/JPG、WebP、BMP、GIF、AVIF、SVG、HEIC/HEIF、TIFF/TIF 可预览；静态图片复用文档的评分项、批注定位、移动/删除、撤销/重做和保存。JPEG 按 EXIF 方向显示；多页 TIFF 连续预览、逐页批注。动态 GIF/APNG/WebP/AVIF 只预览，不允许新增批注或把动画变成静态批改稿。图片批注保存成员路径、`image_sha256`、页码和归一化位置，与代码和文档共用总分；重开时校验图片及页码，不把失配批注静默忽略。
- “下载批改稿”下载整个 ZIP，仅使用已保存的批改；有未保存修改时不可导出。带批注的图片合成为 `_graded.png`，多页图片按 `_graded_1.png` 等逐页输出全部页面；带批注的 PDF/Word 生成 `_graded.pdf`，替代对应原成员。修改过的代码应用补丁并输出 UTF-8，保留解码后的换行和 BOM；未修改文件、动画、不支持预览的二进制及空目录原样保留。输出沿用原目录结构，派生文件名冲突时递增后缀，包含目录名冲突；不覆盖学生原稿，不向 S3 写回批改 ZIP，不只导出 diff 或批注 JSON。批改稿展开总大小限制为 200 MiB，导出前后核对已保存来源和修订号。
- HEIC/HEIF 使用按需加载的 `libheif-js` WASM，TIFF 使用 `tiff` 与 `utif2`；重型解码放在独立 Worker，切换文件可取消。`libheif-js` 声明 LGPL-3.0，另两者声明 MIT；构建保留这些依赖的许可证，Worker 标注 `/third-party/image-codecs.txt`，该文件提供准确源码版本、构建脚本及替换说明。升级解码依赖时同步更新来源说明。HEVC 专利许可不能由软件开源许可推定。
- 原 ZIP 保持不变。代码修改以 `{path, patch}` 保存，`patch` 为 `diff` 库生成的 Git 风格 unified diff：按行比较，默认保留 3 行上下文，远隔修改分成多个 hunk。每次保存都相对原稿重新生成，重新打开时重放；保留 Unicode、换行类型及文件末尾是否换行，不保留旧 UTF-16 替换数组格式。生成过程异步执行；极端重写的差异搜索超过单文件 1 秒预算时，改用完整删除/添加的标准 hunk，保证内容完整且仍可重放。只保留整份 ZIP 的来源哈希，不再为代码文件逐一计算和保存哈希。报告批注仍保存成员路径、原文/PDF 哈希、页码和归一化位置。后端将教师补丁作为文本存储，不解析补丁、不重新下载或解压 ZIP；保留权限、请求结构/大小、评分范围及来源/修订号检查。学生重新提交后清除旧批改和成员预览关联。
- ZIP 上限为压缩 50 MiB、展开 100 MiB、2000 项；单个可编辑文本原文件及修改后的 UTF-8 文本上限均为 2 MiB，单个 PDF/Word 上限 50 MiB、500 页。单张图片原文件上限 50 MiB，多页图片最多 100 页、每页每边最多 16384 像素且不超过 3200 万像素，总计不超过 8000 万像素，标准化图片输出不超过 128 MiB。BigTIFF、相机 RAW、外部资源 SVG、损坏或超限图片不进行预览/批注，仍可下载原文件；AVIF 等原生格式预览也受浏览器编解码支持限制。其他二进制和超大文件保留文件树入口但不预览；危险路径、重复项、符号链接和加密 ZIP 由浏览器拒绝。
- ZIP 成员路径遵循归档编码声明：优先使用 `zip.js` 校验原始文件名 CRC 后接受的 Unicode Path 扩展字段，否则遵循 UTF-8 标志；两者都使用严格 UTF-8 解码，错误字节不会替换或回退为其他编码。没有上述 Unicode 信息时，保留此前已支持的严格 UTF-8 路径；无法按 UTF-8 解码时采用 ZIP 标准 CP437，不用源码内容的编码探测来猜测路径。带有效 Unicode Path 的 GBK 等旧编码原始文件名可正常显示；完全没有编码声明的 GBK 等非 CP437 路径仍有歧义。危险路径、重复与冲突检查均针对最终解码路径，重新打开沿用相同规则，不重写原 ZIP。
- ZIP 源码内容不再限于 UTF-8：保留原有 UTF-8/BOM 文本，支持 UTF-16 LE/BE（带 BOM 或具有源码字节特征的无 BOM 文件），按需加载 `jschardet` 识别 GBK/GB18030、Big5、Shift-JIS、EUC-JP、ISO-2022-JP、EUC-KR、Windows-125x 等常用编码，再用浏览器 `TextDecoder` 严格解码。短源码及常见文本文件在无法识别时尝试 GB18030、Windows-1252；无编码标记的短文本仍可能有识别歧义。可执行文件等已知二进制类型、解码后包含二进制控制字符的内容不作为源码展示，不以替换字符掩盖解码错误。编码检测库仅在非 UTF-8/UTF-16 快速路径需要时下载。解码保留 BOM、原始换行与末尾换行状态，补丁及批注位置基于解码后的 Unicode 文本；重新打开使用相同解码规则重放，不修改或转码 S3 中的原 ZIP，无需更改后端存储格式。
- 作业创建和编辑提供“向学生显示分数”，默认关闭（包括迁移前的作业）。开启后学生只看到总分，不获得代码 diff、批注、扣分明细或教师成绩报表；该限制由后端执行，教师和课程助教的批改权限不变。

实现检查、类型检查和编译由助手负责；真实点击、快捷键及视觉效果由用户验收，不新增前端测试文件或测试框架。

教学界面不提供 Grafana 监控或 MinIO 存储控制台入口。旧的 `/admin2/dashboard`、`/admin2/storage` 地址跳转到教学总览。作业附件上传和下载仍使用后端对象存储服务，运维操作在服务器上进行。

## 故障排查 Troubleshooting

- **`/docs` 路由 404 或侧边栏为空**：`docs` 子模块没有检出，执行 `git submodule update --init --recursive`。

- **反复被踢回登录页或课程列表为空**：后端未启动或代理地址错误，`curl -i http://127.0.0.1:8000/api/auth/current_user/` 确认（应返回 401），并设置 `VITE_GRADER_BACKEND_URL`。401 时跳登录是预期行为。

- **浏览器能打开但 `curl 127.0.0.1:3000` 连接被拒**：开发服务器只监听 `localhost`（部分机器解析为 IPv6 `::1`）。用 `http://localhost:3000`，或 `pnpm dev --host 127.0.0.1`。

- **`pnpm gen-mock-user` 报 `ENOENT tmp/mock-batch-users.csv`**：脚本不会自建目录，先 `mkdir -p tmp`。

- **`pnpm build` 失败但 `pnpm dev` 正常**：类型检查只在构建阶段执行，请修复类型错误，不能跳过这一步。

- **Vuetify 的 SASS 变量定制不生效**：`vite.config.mts` 里的 `Vuetify({ styles: { configFile } })` 是注释状态，需要时取消注释并指向 `src/styles/settings.scss`。

- **大文件上传失败或卡住**：文件经预签名 URL 直传 S3/MinIO，需要该地址从浏览器可达，且桶上允许 CORS。

- **`pnpm install` 提示忽略依赖的构建脚本**：`pnpm-workspace.yaml` 已放行 `esbuild`、`core-js`、`@parcel/watcher`；`xlsx` 是本地 tarball（`file:vendor/xlsx-0.20.3.tgz`），不使用 registry。
