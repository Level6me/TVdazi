#!/usr/bin/env bash
# ==============================================================================
# WeSaver - 微信端 AI 影视资源转存与种草助手 一键部署安装脚本
# 支持单行链接执行: bash <(curl -fsSL https://raw.githubusercontent.com/Level6me/wesaver/main/install.sh)
# ==============================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# 打印日志函数
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 确保在管道输入 (curl | bash) 场景下也能正常从终端读取用户输入
read_input() {
  local prompt="$1"
  local default_val="$2"
  local user_val=""

  if [ -t 0 ]; then
    read -r -p "$prompt" user_val
  elif [ -e /dev/tty ]; then
    read -r -p "$prompt" user_val < /dev/tty
  else
    user_val=""
  fi

  if [ -z "$user_val" ]; then
    echo "$default_val"
  else
    echo "$user_val"
  fi
}

clear_screen() {
  clear 2>/dev/null || true
}

clear_screen
echo -e "${CYAN}${BOLD}"
cat << 'EOF'
 __      __       _________                               
/  \    /  \ ____/   _____/____ ___  __ ___________ 
\   \/\/   // __ \_____  \\__  \\  \/ // __ \_  __ \
 \        /\  ___//        \/ __ \\   /\  ___/|  | \/
  \__/\  /  \___  >_______  (____  /\_/  \___  >__|   
       \/       \/        \/     \/          \/       
EOF
echo -e "${NC}"
echo -e "${BOLD}================================================================${NC}"
echo -e "${BOLD}  WeSaver - 微信端 AI 影视资源转存与种草助手 (DeepSeek 驱动)${NC}"
echo -e "${BOLD}  全网50+频道检索 | AI实体纠错 | 小红书种草笔记 | 智能防和谐还原${NC}"
echo -e "${BOLD}================================================================${NC}\n"

# 1. 检查操作系统与基础包
log_info "正在检查运行环境..."
OS="$(uname -s)"
case "$OS" in
  Linux*)     PLATFORM=Linux;;
  Darwin*)    PLATFORM=Mac;;
  *)          PLATFORM="UNKNOWN";;
esac

if [ "$PLATFORM" != "Linux" ] && [ "$PLATFORM" != "Mac" ]; then
  log_error "本脚本仅支持 Linux 或 macOS 系统部署！"
  exit 1
fi

# 检查 git
if ! command -v git &>/dev/null; then
  log_warn "未检测到 git，正在尝试自动安装..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update && sudo apt-get install -y git curl
  elif command -v yum &>/dev/null; then
    sudo yum install -y git curl
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y git curl
  else
    log_error "请先手动安装 git 工具后再运行安装脚本。"
    exit 1
  fi
fi

# 2. 检查 Node.js 环境 (需 Node 18+)
NEED_NODE_INSTALL=false
if ! command -v node &>/dev/null; then
  NEED_NODE_INSTALL=true
else
  NODE_VER=$(node -v | sed 's/v//' | cut -d'.' -f1)
  if [ "$NODE_VER" -lt 18 ]; then
    log_warn "当前 Node.js 版本 (v$(node -v)) 过低，WeSaver 需要 Node.js 18 或更高版本！"
    NEED_NODE_INSTALL=true
  fi
fi

if [ "$NEED_NODE_INSTALL" = true ]; then
  log_info "正在为你安装 Node.js 20 LTS 运行环境..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
  else
    log_error "未能自动安装 Node.js，请先手动安装 Node.js 18+ (https://nodejs.org/)！"
    exit 1
  fi
fi

log_success "Node.js 环境检测正常: $(node -v) (npm: $(npm -v))"

# 检查 PM2
if ! command -v pm2 &>/dev/null; then
  log_info "正在全局安装 PM2 守护进程管理器..."
  sudo npm install -g pm2 || npm install -g pm2
fi
log_success "PM2 守护管理器就绪: $(pm2 -v)"

# 3. 定位或克隆代码仓库
REPO_URL="https://github.com/Level6me/wesaver.git"
INSTALL_DIR="wesaver"

# 判断当前是否已处于 wesaver 项目根目录下
if [ -f "package.json" ] && grep -q '"name": "wesaver"' package.json 2>/dev/null; then
  PROJECT_ROOT="$(pwd)"
  log_info "检测到当前目录即为 WeSaver 项目目录: ${PROJECT_ROOT}"
else
  log_info "准备在当前目录克隆最新代码仓库..."
  if [ -d "$INSTALL_DIR" ]; then
    log_warn "检测到目标目录 ./${INSTALL_DIR} 已存在，正在拉取最新代码..."
    cd "$INSTALL_DIR"
    git pull || true
    PROJECT_ROOT="$(pwd)"
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    PROJECT_ROOT="$(pwd)"
  fi
fi

# 确保目录存在
mkdir -p data data/accounts data/users

# 4. 交互式配置向导 (写入 .env)
echo -e "\n${PURPLE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${PURPLE}${BOLD}  🛠️  WeSaver 核心参数交互式配置向导 (可直接按回车使用默认值)${NC}"
echo -e "${PURPLE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

EXISTING_DEEPSEEK_KEY=""
EXISTING_QUARK_COOKIE=""
EXISTING_SAVE_DIR="/我的资源"
EXISTING_PORT="3001"

if [ -f ".env" ]; then
  log_info "检测到本地已存在 .env 配置文件，将优先提取现有配置作为默认值..."
  EXISTING_DEEPSEEK_KEY=$(grep -E '^DEEPSEEK_API_KEY=' .env | cut -d'=' -f2- || true)
  EXISTING_QUARK_COOKIE=$(grep -E '^QUARK_COOKIE=' .env | cut -d'=' -f2- || true)
  EXISTING_SAVE_DIR=$(grep -E '^DEFAULT_SAVE_DIR=' .env | cut -d'=' -f2- || true)
  EXISTING_PORT=$(grep -E '^PORT=' .env | cut -d'=' -f2- || true)
fi

[ -z "$EXISTING_SAVE_DIR" ] && EXISTING_SAVE_DIR="/我的资源"
[ -z "$EXISTING_PORT" ] && EXISTING_PORT="3001"

# Step 1: DeepSeek API Key
echo -e "${CYAN}1. DeepSeek API Key 配置${NC}"
echo -e "   DeepSeek 是找片推荐、小红书种草笔记与火星文剧名还原的大脑（注册送额度）。"
echo -e "   获取地址: https://platform.deepseek.com/api_keys"
PROMPT_KEY="   请输入您的 DeepSeek API Key [回车跳过]: "
[ -n "$EXISTING_DEEPSEEK_KEY" ] && PROMPT_KEY="   请输入您的 DeepSeek API Key [当前已配置，回车保留]: "
USER_DEEPSEEK_KEY=$(read_input "$PROMPT_KEY" "$EXISTING_DEEPSEEK_KEY")

# Step 2: 夸克网盘 Cookie
echo -e "\n${CYAN}2. 夸克网盘 Cookie 凭证配置 (可选)${NC}"
echo -e "   用于转存网盘资源与自动重命名。也可以稍后直接在微信发送「/set-quark 你的Cookie」随时绑定。"
echo -e "   获取方法: 电脑打开 pan.quark.cn 登录，按 F12 在网络请求标头中复制 Cookie。"
PROMPT_COOKIE="   请输入夸克 Cookie [回车跳过稍后微信绑定]: "
[ -n "$EXISTING_QUARK_COOKIE" ] && PROMPT_COOKIE="   请输入夸克 Cookie [当前已配置，回车保留]: "
USER_QUARK_COOKIE=$(read_input "$PROMPT_COOKIE" "$EXISTING_QUARK_COOKIE")

# Step 3: 网盘默认转存路径
echo -e "\n${CYAN}3. 夸克网盘默认转存目录${NC}"
echo -e "   资源转存入网盘时的存放根目录，支持多级目录（系统会自动逐层创建）。"
PROMPT_DIR="   默认转存目录 [回车默认: ${EXISTING_SAVE_DIR}]: "
USER_SAVE_DIR=$(read_input "$PROMPT_DIR" "$EXISTING_SAVE_DIR")

# Step 4: 服务端口
echo -e "\n${CYAN}4. 本地服务端口${NC}"
PROMPT_PORT="   服务监听端口 [回车默认: ${EXISTING_PORT}]: "
USER_PORT=$(read_input "$PROMPT_PORT" "$EXISTING_PORT")

# 写入 .env 文件
log_info "正在生成 .env 配置文件..."
cat > .env << EOF
# ==============================================================================
# WeSaver 自动化配置
# ==============================================================================
DEEPSEEK_API_KEY=${USER_DEEPSEEK_KEY}
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

QUARK_COOKIE=${USER_QUARK_COOKIE}
DEFAULT_PAN=quark
DEFAULT_SAVE_DIR=${USER_SAVE_DIR}

PORT=${USER_PORT}
DEBUG=false
EOF
chmod 600 .env
log_success ".env 配置文件保存完成！"

# 5. 安装依赖与构建编译
echo -e "\n${BLUE}正在安装 npm 生产与构建依赖 (初次安装约需 1~2 分钟)...${NC}"
npm install --production=false

echo -e "\n${BLUE}正在编译 TypeScript 代码 (npm run build)...${NC}"
npm run build
log_success "代码构建与打包成功 (dist 产物已就绪)！"

# 6. PM2 守护服务管理
echo -e "\n${PURPLE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${PURPLE}${BOLD}  🚀  启动 WeSaver 微信机器人后台服务${NC}"
echo -e "${PURPLE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# 停止已有的老实例 (如果有)
pm2 delete wesaver 2>/dev/null || true

# 启动实例
pm2 start ecosystem.config.js
pm2 save

log_success "WeSaver 微信机器人后台服务已通过 PM2 成功启动！"

# 7. 完成提示与扫码指南
echo -e "\n${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}  🎉  恭喜！WeSaver 已经成功安装并启动运行！${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}\n"

echo -e "${BOLD}📱 微信扫码授权指南：${NC}"
echo -e "1. 查看登录二维码与实时日志："
echo -e "   ${CYAN}pm2 logs wesaver${NC}"
echo -e "2. 终端会输出登录二维码链接与图片路径，使用微信扫码授权即可接管消息！"
echo -e "\n${BOLD}🛠️  常用管理指令：${NC}"
echo -e "• 查看运行日志：  ${CYAN}pm2 logs wesaver${NC}"
echo -e "• 重启机器人服务：${CYAN}pm2 restart wesaver${NC}"
echo -e "• 查看状态与资源：${CYAN}pm2 status${NC}"
echo -e "• 停止服务：      ${CYAN}pm2 stop wesaver${NC}"
echo -e "\n${BOLD}💬 微信常用功能与指令：${NC}"
echo -e "• 直接搜片：在微信聊天框发「想看流浪地球2」或「周星驰功夫」"
echo -e "• 小红书种草：在微信发「推荐一部最近比较火的电影」或「推荐好看的韩剧」"
echo -e "• 一键转存：在搜索或推荐结果中，回复序号（如「1」或「看第2个」）自动存入网盘"
echo -e "• 绑定网盘：向机器人发送「/set-quark 你的夸克Cookie」"
echo -e "• 防和谐规整：向机器人发送「/clean-names」一键自动洗白网盘中的火星文剧名"
echo -e "• 邀请好友共用：向机器人发送「/share」生成你的专属带参裂变二维码"
echo -e "\n如遇任何问题，欢迎访问 GitHub 项目主页提 Issue 交流！"
echo -e "GitHub: ${REPO_URL}\n"
