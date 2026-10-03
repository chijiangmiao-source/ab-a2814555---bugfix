FROM node:20-alpine

WORKDIR /app

# 本应用零运行时第三方依赖（仅 Node 内置模块），直接复制源码即可
COPY package.json ./
COPY src ./src
COPY test ./test
COPY verify.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
