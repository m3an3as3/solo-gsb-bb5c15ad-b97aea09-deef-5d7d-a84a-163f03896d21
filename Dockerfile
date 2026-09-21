# ---- 构建阶段：编译 better-sqlite3 原生模块 ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/app.db

# better-sqlite3 运行时需要的共享库
RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "server.js"]
