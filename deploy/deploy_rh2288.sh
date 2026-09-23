#!/bin/bash
# ==============================================================================
# HOJ 教学平台 - 华为 RH2288 V3 服务器一键自动化生产部署脚本
# 适用硬件：华为 RH2288 V3 (2*E5-2620 v3, 64GB RAM, 3*600G SAS)
# 操作系统支持：Ubuntu 20.04/22.04/24.04 LTS 或 Debian 11/12 (x86_64)
# ==============================================================================

set -e

COLOR_GREEN="\033[32m"
COLOR_YELLOW="\033[33m"
COLOR_RED="\033[31m"
COLOR_RESET="\033[0m"

log_info() { echo -e "${COLOR_GREEN}[INFO]${COLOR_RESET} $1"; }
log_warn() { echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $1"; }
log_err()  { echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $1"; }

# 1. 权限与架构检查
if [ "$EUID" -ne 0 ]; then
    log_err "请使用 root 权限执行此部署脚本 (sudo ./deploy_rh2288.sh)"
    exit 1
fi

ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
    log_warn "当前服务器架构为 $ARCH，非 x86_64。若为 ARM 需额外调整系统调用号白名单。"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COURSE_DIR="${BASE_DIR}/course-service"
HUSTOJ_DIR="${BASE_DIR}/hustoj"

log_info "=========================================================="
log_info "   HOJ 教学平台 - 华为 RH2288 V3 生产环境一键部署"
log_info "=========================================================="
log_info "基准目录: ${BASE_DIR}"

# 2. 硬件检测与参数自适应
CPU_CORES=$(nproc)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))
log_info "检测到 CPU 逻辑核心数: ${CPU_CORES}，物理内存: ${TOTAL_RAM_GB} GB"

# 针对双路 E5-2620 v3 (12物理核/24线程)，最佳判题并发设定为 10
if [ "$CPU_CORES" -ge 16 ]; then
    JUDGE_RUNNING=10
elif [ "$CPU_CORES" -ge 8 ]; then
    JUDGE_RUNNING=6
else
    JUDGE_RUNNING=2
fi
log_info "自适应设定沙箱评测并发数: OJ_RUNNING=${JUDGE_RUNNING}"

# 3. 内存盘优化（针对 10k SAS 机械硬盘加速，消除编译与用例执行 IO 瓶颈）
log_info ">>> 步骤 1/7: 配置判题沙箱内存盘 (tmpfs)..."
mkdir -p /home/judge
for i in $(seq 0 $((JUDGE_RUNNING - 1))); do
    RUN_DIR="/home/judge/run${i}"
    mkdir -p "${RUN_DIR}"
    if ! mount | grep -q "${RUN_DIR}"; then
        mount -t tmpfs -o size=256M,mode=700 tmpfs "${RUN_DIR}" || true
    fi
done
log_info "已成功将 run0 ~ run$((JUDGE_RUNNING - 1)) 挂载至内存，小文件 IO 延迟降至 0。"

# 4. 系统级高并发参数调优 (sysctl)
log_info ">>> 步骤 2/7: 优化 Linux 内核网络与连接数参数..."
sysctl -w net.core.somaxconn=4096 >/dev/null 2>&1 || true
sysctl -w fs.file-max=2097152 >/dev/null 2>&1 || true

# 5. 基础软件依赖安装检查
log_info ">>> 步骤 3/7: 检查并安装基础软件依赖 (Docker, Node.js, Python, Nginx)..."
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y docker.io python3 python3-pip python3-venv nginx curl net-tools
    # 安装 Node.js 18+ (若未安装)
    if ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
    fi
elif command -v yum >/dev/null 2>&1; then
    yum install -y docker python3 python3-pip nginx curl net-tools
    systemctl enable --now docker
fi

systemctl enable --now docker || true
systemctl enable --now nginx || true

# 6. 构建与启动 HUSTOJ 核心容器
log_info ">>> 步骤 4/7: 启动 HUSTOJ 判题与数据库引擎..."
if docker ps -a --format '{{.Names}}' | grep -Eq '^hustoj$'; then
    log_info "已有 hustoj 容器，正在检查运行状态..."
    if ! docker ps --format '{{.Names}}' | grep -Eq '^hustoj$'; then
        docker start hustoj
    fi
else
    log_info "正在从 ${HUSTOJ_DIR} 构建 hustoj-dev 镜像..."
    docker build -t hustoj-dev -f "${HUSTOJ_DIR}/codemind/docker/Dockerfile" "${HUSTOJ_DIR}"
    log_info "正在启动 hustoj 容器..."
    docker run -d \
        --name hustoj \
        --restart always \
        --privileged \
        -p 8080:80 \
        -v /home/judge/data:/home/judge/data \
        hustoj-dev
fi

# 等待 MySQL 启动完毕
log_info "等待 MariaDB / MySQL 服务就绪..."
for attempt in {1..30}; do
    if docker exec -i hustoj mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# 调整沙箱并发数并重启 judged
docker exec -i hustoj bash -c "sed -i 's#^OJ_RUNNING=.*#OJ_RUNNING=${JUDGE_RUNNING}#' /home/judge/etc/judge.conf"
docker exec -i hustoj bash -c "sed -i 's#^OJ_USE_PTRACE=.*#OJ_USE_PTRACE=1#' /home/judge/etc/judge.conf"
docker exec -i hustoj pkill -9 judged || true
docker exec -i hustoj /usr/bin/judged || true

# 7. 自动执行教学域数据库初始化
log_info ">>> 步骤 5/7: 初始化教学域数据库结构与账号..."
for sql_file in "${COURSE_DIR}/schema"/00*.sql; do
    if [ -f "$sql_file" ]; then
        log_info "执行数据库脚本: $(basename "$sql_file")"
        docker exec -i hustoj mysql --default-character-set=utf8mb4 -uroot < "$sql_file" || true
    fi
done

# 8. 安装与配置 Course Service (FastAPI) 与 前端 (Next.js)
log_info ">>> 步骤 6/7: 配置 Python 虚拟环境与编译前端页面..."
cd "${COURSE_DIR}"

if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# 生产环境 .env 配置
if [ ! -f ".env" ]; then
    cat <<EOF > .env
COURSE_AI_URL=https://api.deepseek.com
COURSE_AI_MODEL=deepseek-chat
COURSE_AI_KEY=
COURSE_AI_TIMEOUT=30
COURSE_DB_PASSWORD=codemind-dev-pw
COURSE_DEV_LOGIN=1
EOF
fi

# 前端依赖安装与构建
cd "${COURSE_DIR}/web"
npm install --production=false
npm run build

# 9. 配置并启动 Systemd 服务
log_info ">>> 步骤 7/7: 配置 Systemd 守护进程与 Nginx 网关..."
cp "${COURSE_DIR}/deploy/systemd/hoj-api.service" /etc/systemd/system/
cp "${COURSE_DIR}/deploy/systemd/hoj-web.service" /etc/systemd/system/

# 更新 service 文件中的真实运行路径
sed -i "s#/opt/oj/course-service#${COURSE_DIR}#g" /etc/systemd/system/hoj-api.service
sed -i "s#/opt/oj/course-service#${COURSE_DIR}#g" /etc/systemd/system/hoj-web.service

systemctl daemon-reload
systemctl enable --now hoj-api
systemctl enable --now hoj-web
systemctl restart hoj-api
systemctl restart hoj-web

# 配置 Nginx 统一网关
cp "${COURSE_DIR}/deploy/nginx_oj.conf" /etc/nginx/conf.d/hoj_platform.conf 2>/dev/null || \
cp "${COURSE_DIR}/deploy/nginx_oj.conf" /etc/nginx/sites-available/default
nginx -t
systemctl reload nginx

log_info "=========================================================="
log_info "        🎉 HOJ 教学平台在华为 RH2288 V3 部署成功！"
log_info "=========================================================="
LOCAL_IP=$(hostname -I | awk '{print $1}')
log_info "统一访问地址: http://${LOCAL_IP}/"
log_info "教师出题入口: http://${LOCAL_IP}/teacher"
log_info "学生做题入口: http://${LOCAL_IP}/student"
log_info "我的题库资产: http://${LOCAL_IP}/teacher/library"
log_info "HUSTOJ 原版: http://${LOCAL_IP}:8080/ 或 http://${LOCAL_IP}/oj/"
log_info "=========================================================="
