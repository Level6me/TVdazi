#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR" || exit 1
nohup node dist/login.js >> "${PROJECT_DIR}/wechat_bot.log" 2>&1 &
echo $! > "${PROJECT_DIR}/wechat_bot.pid"
echo "WeSaver WeChat Bot started with PID: $(cat "${PROJECT_DIR}/wechat_bot.pid")"
