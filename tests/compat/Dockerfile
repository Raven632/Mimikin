# Лёгкий образ для проверки совместимости: только Chromium (headless shell),
# а не все три браузера из официального образа Playwright (1,2 ГБ против 3,5 ГБ)
FROM node:24-bookworm-slim

# Браузер — в общую папку, а не в ~/.cache root'а: иначе пользователь node его не увидит
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /work
COPY package.json package-lock.json ./
# Всё в одном RUN: удалённое в следующем слое не уменьшает образ, слои неизменяемы
RUN npm ci --no-audit --no-fund \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Скрипт копируем последним: правка скрипта не пересобирает браузер (кэш слоёв)
COPY check-games.mjs check-options.mjs check-rewind.mjs ./

USER node
CMD ["node", "check-games.mjs"]
