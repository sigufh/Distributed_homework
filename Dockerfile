FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./ 

RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 120000 \
    && npm install --omit=dev --no-audit

COPY src ./src

ENV PORT=8081

CMD ["node", "src/server.js"]

