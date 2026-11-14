FROM node:20-alpine

WORKDIR /app

# 安装构建必要工具
RUN apk add --no-cache python3 make g++ git

# 拷贝依赖配置
COPY package*.json tsconfig.json ./

# 安装依赖
RUN npm install

# 拷贝源代码与配置文件
COPY . .

# 编译 TypeScript
RUN npm run build

# 暴露服务端口
EXPOSE 3001

# 启动微信机器人
CMD ["node", "dist/login.js"]
