# Запуск автотестов интерфейса: Node и Chromium (только headless shell — как у tests/compat).
# Тесты и конфиг не копируются, а подключаются при запуске (compose.yml): правка теста не пересобирает образ
FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /runner
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
