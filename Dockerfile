# Образ собирается в три этапа. Всё, что нужно только для сборки (компилятор, Python, wget, npm-кэш),
# остаётся в промежуточных этапах, а в итоговый образ попадают готовые файлы: сайт, node_modules и 7zz

# ==========================================
# ЭТАП 1: интерфейс (React + Vite)
# ==========================================
FROM node:22-alpine AS frontend

WORKDIR /app/frontend

COPY frontend/package*.json ./
# npm ci ставит пакеты строго по lock-файлу
RUN npm ci

COPY frontend/ ./
RUN npm run build
# На выходе — готовая папка /app/frontend/dist

# ==========================================
# ЭТАП 2: пакеты сервера и 7-Zip
# ==========================================
FROM node:22-slim AS deps

WORKDIR /app/api

# python3, make и g++ — чтобы собрать sqlite3 (ниже); в итоговый образ они не попадают
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget xz-utils python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 7-Zip — официальная сборка 7zz: p7zip из Debian старый и не знает новых версий RAR.
# Образ собирается для x86 и ARM (Raspberry Pi, Mac на M-чипах): у 7-Zip под каждую своя сборка
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in arm64) arch=arm64 ;; *) arch=x64 ;; esac \
    && wget -q "https://github.com/ip7z/7zip/releases/download/26.00/7z2600-linux-${arch}.tar.xz" -O 7z.tar.xz \
    && tar xf 7z.tar.xz 7zz \
    && mv 7zz /usr/local/bin/7zz \
    && rm -f 7z.tar.xz \
    && 7zz i > /dev/null

COPY api/package*.json ./
# Готовая сборка sqlite3 рассчитана на glibc 2.38+, а в Debian 12 (основа node:22-slim) — 2.36:
# с ней сервер падает на старте. Поэтому sqlite3 собираем из исходников под этот образ
# onnxruntime-node (распознавание картинок в галерее) везёт сборки под все системы, а на linux/x64 ещё докачивает
# CUDA — 500 МБ. Серверу нужен только процессор и своя система: CUDA не качаем, чужие сборки удаляем (~25 МБ остаётся)
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev \
    && npm rebuild sqlite3 --build-from-source \
    && case "${TARGETARCH:-amd64}" in arm64) arch=arm64 ;; *) arch=x64 ;; esac \
    && ort=node_modules/onnxruntime-node/bin/napi-v3 \
    && find "$ort" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
    && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$arch" -exec rm -rf {} + \
    && rm -f "$ort/linux/$arch"/libonnxruntime_providers_cuda.so "$ort/linux/$arch"/libonnxruntime_providers_tensorrt.so \
    && node -e "require('sqlite3'); require('bcrypt'); require('onnxruntime-node')"

# ==========================================
# ЭТАП 3: итоговый образ
# ==========================================
# slim-версия: ~200 МБ вместо 1,1 ГБ полного образа node
FROM node:22-slim

WORKDIR /app/api

# Системного серверу нужно немного: ffmpeg (обложки, кадры, миниатюры, звук для iOS)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /usr/local/bin/7zz /usr/local/bin/7zz
COPY --chown=node:node --from=deps /app/api/node_modules ./node_modules

# Исходники сервера и собранный сайт
COPY --chown=node:node api/ ./
COPY --chown=node:node --from=frontend /app/frontend/dist/ ./public/

# Без Redis рядом (docker run одним контейнером) — кэш в памяти. docker-compose.yml задаёт свой Redis
ENV REDIS_URL=memory

# Точка входа: готовит смонтированную папку и сбрасывает права до пользователя node
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 3000 — библиотека, 3001 — игры на своём адресе (api/src/routes/play.js)
EXPOSE 3000 3001
VOLUME ["/games"]
ENV GAMES_DIR=/games NODE_ENV=production
# Готовый образ (выпуск, .github/workflows/release.yml) знает своё имя: «О программе» подскажет, как обновиться
ARG MIMIKIN_IMAGE=
ENV MIMIKIN_IMAGE=$MIMIKIN_IMAGE

LABEL org.opencontainers.image.title="Mimikin" \
      org.opencontainers.image.description="Self-hosted library for RPG Maker MV/MZ games: play in the browser, saves on the server" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
