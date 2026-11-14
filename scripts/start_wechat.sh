#!/bin/bash
cd /home/ubuntu/wesaver
nohup node dist/login.js >> /home/ubuntu/wesaver/wechat_bot.log 2>&1 &
echo $! > /home/ubuntu/wesaver/wechat_bot.pid
echo "WeSaver WeChat Bot started with PID: $(cat /home/ubuntu/wesaver/wechat_bot.pid)"
