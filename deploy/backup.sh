#!/usr/bin/env bash
# Бэкап незаменимых данных прода: сейвы, база, .env прода и опись игр.
# Сами игры (117 ГБ) не копируем: их можно скачать заново, а опись сохраняем.
# Запускается таймером rpg-backup.timer; вручную: systemctl start rpg-backup
set -Eeuo pipefail

DATA_DIR=${DATA_DIR:-/srv/mimikin/games}
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=deploy/notify.sh
source "$APP_DIR/deploy/notify.sh"
# Любая ошибка — сообщение в Telegram (если он подключён), а не только строка в журнале
trap 'notify_telegram "⚠️ Ночной бэкап библиотеки не удался — подробности: journalctl -u rpg-backup"' ERR
BACKUP_DIR=${BACKUP_DIR:-/var/backups/rpg-library}
KEEP_DAYS=${KEEP_DAYS:-30}

main() {
    local stamp archive
    stamp=$(date +%Y-%m-%d_%H%M)
    # Временная папка; trap удалит её при любом выходе — и при успехе, и при ошибке
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT

    # 1. База: .backup делает согласованную копию, даже если сервер в этот момент пишет.
    #    Простой cp работающей SQLite-базы может скопировать её «посередине записи».
    sqlite3 "$DATA_DIR/library.db" ".backup '$TMP/library.db'"
    if [ "$(sqlite3 "$TMP/library.db" 'PRAGMA integrity_check;')" != "ok" ]; then
        echo "Копия базы повреждена, бэкап не создан" >&2
        notify_telegram "⚠️ Ночной бэкап: копия базы повреждена, бэкап не создан"
        exit 1
    fi

    # 2. Сейвы и настройки прода (в .env секреты — поэтому ниже права 600/700).
    #    История сейвов (_saves/.history) — страховка на ближайшие часы, в ночную копию не идёт
    tar -C "$DATA_DIR" --exclude='_saves/.history' -cf - _saves | tar -C "$TMP" -xf -
    cp -a "$APP_DIR/.env" "$TMP/prod.env"
    # Ключ шифрования секретов в базе (без SECRETS_KEY в .env он здесь): без него ключи служб из копии не прочитать
    if [ -f "$DATA_DIR/_media/.secrets.key" ]; then cp -a "$DATA_DIR/_media/.secrets.key" "$TMP/secrets.key"; fi

    # 3. Опись игр: сами игры не копируем, но будем знать, что восстанавливать
    ls -1 "$DATA_DIR" > "$TMP/games.txt"

    # 4. Архив пишем во временный файл и только потом переименовываем:
    #    недописанный архив (сбой, нет места) никогда не будет выглядеть как готовый
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    archive="$BACKUP_DIR/rpg-backup_$stamp.tar.gz"
    tar -czf "$archive.part" -C "$TMP" .
    tar -tzf "$archive.part" > /dev/null   # архив читается целиком — иначе ошибка
    mv "$archive.part" "$archive"
    chmod 600 "$archive"

    # 5. Ротация: удаляем архивы старше KEEP_DAYS дней
    find "$BACKUP_DIR" -name 'rpg-backup_*.tar.gz' -mtime +"$KEEP_DAYS" -delete

    echo "Бэкап готов: $archive ($(du -h "$archive" | cut -f1)), архивов всего: $(find "$BACKUP_DIR" -name 'rpg-backup_*.tar.gz' | wc -l)"
}

main "$@"; exit
