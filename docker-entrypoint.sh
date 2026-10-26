#!/bin/sh
set -e

# Контейнер стартует под root только для одного действия: выправить владельца
# смонтированной папки с играми. Сервер после этого запускается под пользователем
# node — процесс с правами root не остаётся.
if [ "$(id -u)" = "0" ]; then
  GAMES="${GAMES_DIR:-/games}"
  mkdir -p "$GAMES"
  # Без -R: рекурсивный chown по библиотеке в сотню гигабайт занял бы минуты
  # при каждом старте, а вложенные папки сервер создаёт сам и уже от себя.
  chown node:node "$GAMES"
  # База в режиме WAL: рядом с library.db живут library.db-wal и library.db-shm. Если их создал
  # процесс под root (копия с хоста, sqlite3 из консоли), сервер под node не смог бы в них писать
  chown node:node "$GAMES"/library.db-wal "$GAMES"/library.db-shm 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Если пользователь задал свой user: в compose — просто запускаем команду
exec "$@"
