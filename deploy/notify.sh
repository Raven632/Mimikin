#!/usr/bin/env bash
# Сообщение о сбое в Telegram-чат библиотеки (тот, что подключён в меню «Telegram», services/telegram.js).
# Токен — из .env прода, чат — из .env (TELEGRAM_CHAT_ID) или из базы. Нет чего-то — молча выходим:
# уведомления не обязательны, и скрипт, который их зовёт, из-за них не падает.
# Подключается через source; APP_DIR — папка кода, DATA_DIR — папка игр с library.db
notify_telegram() {
    local text=$1
    local app_dir=${APP_DIR:-/opt/mimikin} data_dir=${DATA_DIR:-/srv/mimikin/games}
    local token chat
    token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$app_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"' \r") || true
    chat=$(grep -E '^TELEGRAM_CHAT_ID=' "$app_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"' \r") || true
    if [ -z "$chat" ]; then
        chat=$(sqlite3 -readonly "$data_dir/library.db" "SELECT json_extract(value, '\$.id') FROM settings WHERE key = 'telegram_chat'" 2>/dev/null) || true
    fi
    [ -n "$token" ] && [ -n "$chat" ] || return 0
    # Токен — в адресе запроса: команду не печатаем (set -x не включать)
    curl -fsS -m 20 -o /dev/null "https://api.telegram.org/bot$token/sendMessage" \
        --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" || true
}
