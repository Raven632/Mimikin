#!/usr/bin/env bash
# Проверка скрипта выкладки: настоящий git, поддельные docker и curl.
# Всё — во временной папке, прод и настоящие службы скрипты не видят. Запуск: tests/deploy/test.sh
set -Eeuo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export TMPDIR="$T"
mkdir -p "$T/bin"
failures=0
check() { if eval "$2"; then echo "  ok: $1"; else echo "  ПРОВАЛ: $1"; failures=$((failures + 1)); fi; }

# Поддельные команды пишут вызовы в журнал; DOCKER_MODE: fail — сборка не вышла, kill — сборку убили вместе со скриптом
cat > "$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$LOG"
case "$*" in
  "compose config --images") echo proj-rpg-library ;;
  "compose up -d --build"*)
    [ "${DOCKER_MODE:-}" != kill ] || kill -9 "$PPID"
    [ "${DOCKER_MODE:-}" != fail ] && [ "${DOCKER_MODE:-}" != fail-kill ] || exit 1 ;;
  "compose up -d --no-build"*) [ "${DOCKER_MODE:-}" != fail-kill ] || kill -9 "$PPID" ;;
esac
exit 0
FAKE
cat > "$T/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$LOG"
case "$*" in *sendMessage*) exit 0 ;; esac
[ "${CURL_MODE:-}" != fail ]
FAKE
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" LOG="$T/log" HEALTH_TRIES=1 HEALTH_SLEEP=0
: > "$LOG"
calls() { grep -c -- "$1" "$LOG" || true; }

# --- Выкладка: настоящий репозиторий и ветка deploy
export STATE_DIR="$T/state" DEPLOY_MIN_FREE_GB=0
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/app" 2>/dev/null
cd "$T/app"
git config user.email t@t; git config user.name t; git config commit.gpgsign false
mkdir deploy
cp "$ROOT/deploy/pull-deploy.sh" "$ROOT/deploy/notify.sh" deploy/
printf 'TELEGRAM_BOT_TOKEN=x\nTELEGRAM_CHAT_ID=1\n' > .env; echo .env > .gitignore
git add -A; git commit -qm one; git branch -M deploy; git push -q origin deploy
start=$(git rev-parse HEAD)
next() {   # новый коммит на GitHub; рабочая копия остаётся на прежнем
    git clone -q -b deploy "$T/origin.git" "$T/up" 2>/dev/null
    (cd "$T/up"; git config user.email t@t; git config user.name t; git config commit.gpgsign false; git commit -q --allow-empty -m "$1"; git push -q origin deploy; git rev-parse HEAD)
    rm -rf "$T/up"
}
deploy() { "$T/app/deploy/pull-deploy.sh" >> "$T/out" 2>&1 || true; }

echo "выкладка: обычная"
sha=$(next two)
deploy
check 'код обновлён' '[ "$(git rev-parse HEAD)" = "$sha" ]'
check 'образ сохранён в запас' '[ "$(calls "image tag proj-rpg-library:latest proj-rpg-library:previous")" = 1 ]'
check 'кэш оставлен с запасом' '[ "$(calls "max-used-space 20GB")" = 1 ]'
check 'следов сборки нет' '[ ! -e "$STATE_DIR/building" ]'
: > "$LOG"; deploy
check 'нового нет — ничего не делает' '[ ! -s "$LOG" ]'

echo "выкладка: мало места"
sha=$(next three); before=$(git rev-parse HEAD)
DEPLOY_MIN_FREE_GB=999999999 deploy
DEPLOY_MIN_FREE_GB=999999999 deploy
check 'код не тронут' '[ "$(git rev-parse HEAD)" = "$before" ]'
check 'сборки не было' '[ "$(calls "compose up")" = 0 ]'
check 'сообщение одно' '[ "$(calls "sendMessage")" = 1 ]'
: > "$LOG"; deploy
check 'место появилось — обновился' '[ "$(git rev-parse HEAD)" = "$sha" ] && [ ! -e "$STATE_DIR/low-disk" ]'

echo "выкладка: сборку убили"
before=$(git rev-parse HEAD); sha=$(next four); : > "$LOG"
DOCKER_MODE=kill deploy
check 'код новый, сборка помечена' '[ "$(git rev-parse HEAD)" = "$sha" ] && [ -e "$STATE_DIR/building" ]'
tags=$(calls "image tag")
deploy
check 'следующий запуск собрал заново' '[ "$(calls "compose up -d --build")" = 2 ] && [ ! -e "$STATE_DIR/building" ]'
check 'запас не перезаписан' '[ "$(calls "image tag proj-rpg-library:latest proj-rpg-library:previous")" = "$tags" ]'

echo "выкладка: убивают каждый раз"
before=$(git rev-parse HEAD); sha=$(next five); : > "$LOG"
for _ in 1 2 3; do DOCKER_MODE=kill deploy; done
check 'три попытки' '[ "$(calls "compose up -d --build")" = 3 ] && [ "$(git rev-parse HEAD)" = "$sha" ]'
deploy
check 'откат на работавшую версию' '[ "$(git rev-parse HEAD)" = "$before" ] && [ "$(cat "$STATE_DIR/failed")" = "$sha" ]'
check 'запас возвращён, сказано в Telegram' '[ "$(calls "image tag proj-rpg-library:previous proj-rpg-library:latest")" = 1 ] && [ "$(calls "sendMessage")" = 1 ]'
: > "$LOG"; deploy
check 'этот коммит больше не трогает' '[ "$(calls "compose up")" = 0 ] && [ "$(git rev-parse HEAD)" = "$before" ]'

echo "выкладка: не собралось"
sha=$(next six); before=$(git rev-parse HEAD); : > "$LOG"
DOCKER_MODE=fail deploy
check 'откат сразу, без повторов' '[ "$(git rev-parse HEAD)" = "$before" ] && [ ! -e "$STATE_DIR/building" ] && [ "$(cat "$STATE_DIR/failed")" = "$sha" ]'

echo "выкладка: не ответило"
sha=$(next seven); before=$(git rev-parse HEAD); : > "$LOG"
CURL_MODE=fail deploy
check 'откат, в Telegram сказано' '[ "$(git rev-parse HEAD)" = "$before" ] && [ "$(cat "$STATE_DIR/failed")" = "$sha" ] && [ "$(calls "sendMessage")" = 1 ]'

echo "выкладка: сборку убили, а места теперь мало"
before=$(git rev-parse HEAD); sha=$(next eight); : > "$LOG"
DOCKER_MODE=kill deploy
DEPLOY_MIN_FREE_GB=999999999 deploy
check 'всё равно доделывает' '[ "$(git rev-parse HEAD)" = "$sha" ] && [ ! -e "$STATE_DIR/building" ] && [ "$(calls "compose up -d --build")" = 2 ]'

echo "выкладка: новый коммит пришёл после убитой сборки"
before=$(git rev-parse HEAD); first=$(next nine); : > "$LOG"
DOCKER_MODE=kill deploy
sha=$(next ten)
DOCKER_MODE=fail deploy
check 'откат на то, что работало, а не на недостроенное' '[ "$(git rev-parse HEAD)" = "$before" ] && [ "$(cat "$STATE_DIR/failed")" = "$sha" ]'
check 'запас цел' '[ "$(calls "image tag proj-rpg-library:latest proj-rpg-library:previous")" = 1 ]'

echo "выкладка: убили посреди отката"
sha=$(next eleven); before=$(git rev-parse HEAD); : > "$LOG"
DOCKER_MODE=fail-kill deploy
check 'пометка «откачен» ещё не стоит' '[ "$(cat "$STATE_DIR/failed" 2>/dev/null)" != "$sha" ] && [ -e "$STATE_DIR/building" ]'
deploy
check 'следующий запуск довёл дело' '[ "$(git rev-parse HEAD)" = "$sha" ] && [ ! -e "$STATE_DIR/building" ]'

echo "выкладка: запись о сборке испорчена"
sha=$(next twelve); before=$(git rev-parse HEAD); : > "$LOG"
echo "$sha " > "$STATE_DIR/building"
deploy
check 'обычная выкладка, файл убран' '[ "$(git rev-parse HEAD)" = "$sha" ] && [ ! -e "$STATE_DIR/building" ]'

if [ "$failures" -gt 0 ]; then
    echo "Провалов: $failures. Вывод скриптов:"; tail -n 40 "$T/out"
    exit 1
fi
echo "Всё прошло"
