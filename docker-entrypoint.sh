#!/bin/sh
set -e

# Контейнер стартует под root только для одного действия: выправить владельца
# смонтированной папки с играми. Сервер после этого запускается под пользователем
# node — процесс с правами root не остаётся.
if [ "$(id -u)" = "0" ]; then
  GAMES="${GAMES_DIR:-/games}"
  mkdir -p "$GAMES" || {
    echo "Mimikin did not start: cannot create the games folder ($GAMES). Check the path in GAMES_DIR and that the mount is writable." >&2
    exit 1
  }
  # Без -R: рекурсивный chown по библиотеке в сотню гигабайт занял бы минуты
  # при каждом старте, а вложенные папки сервер создаёт сам и уже от себя.
  # Отказ случается раньше Node, и страница «база не открылась» (api/src/utils/dbDown.js) его не покрывает: порт не
  # откроется, браузер скажет «сайт недоступен». Поэтому хотя бы одна понятная строка в журнале вместо голого chown
  chown node:node "$GAMES" || {
    echo "Mimikin did not start: cannot make the games folder ($GAMES) belong to the user node (uid 1000). Usual causes: a read-only mount, or a network folder (NFS, SMB) that refuses chown. Make the mount writable, or if uid 1000 can already write there, run the container with user: \"1000:1000\" in compose or --user 1000:1000 with docker run." >&2
    exit 1
  }
  # База в режиме WAL: рядом с library.db живут library.db-wal и library.db-shm. Если их создал
  # процесс под root (копия с хоста, sqlite3 из консоли), сервер под node не смог бы в них писать
  chown node:node "$GAMES"/library.db-wal "$GAMES"/library.db-shm 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Если пользователь задал свой user: в compose — просто запускаем команду
exec "$@"
