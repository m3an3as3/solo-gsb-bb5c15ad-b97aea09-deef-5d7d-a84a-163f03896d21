FROM node:20-bookworm

WORKDIR /app

# 先装依赖（利用镜像层缓存；bookworm 完整镜像自带编译链，better-sqlite3 无预编译包时可回退源码构建）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# SQLite 数据文件目录（首次启动自动建表并写入示例数据）
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server.js"]
