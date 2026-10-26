#!/usr/bin/env bash
# Pull-деплой: если на GitHub ветка deploy ушла вперёд — обновляемся до неё.
# Ветку deploy двигает CI (.github/workflows/ci.yml), когда тесты и сборка коммита в main прошли:
# всё, что в ней, уже проверено. Спрашивать у API GitHub, зелёный ли CI, не нужно — у приватного
# репозитория без токена это и не спросить. Забираем по SSH (ключ — в ~/.ssh/config для github.com)
# Запускается таймером rpg-deploy.timer; вручную: systemctl start rpg-deploy
set -Eeuo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR=$REPO_DIR
# shellcheck source=deploy/notify.sh
source "$REPO_DIR/deploy/notify.sh"
BRANCH=${DEPLOY_BRANCH:-deploy}

# Где помним коммит, который не поднялся и был откачен: его больше не выкатываем, следующий — да
STATE_DIR=${STATE_DIR:-/var/lib/rpg-deploy}

env_value() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"' \r" || true; }

# Сайт отвечает: страница входа библиотеки и (если игры на своём адресе) сервер игр. Сервер слушает
# порт, только когда сверил библиотеку, — ждём до двух минут
healthy() {
    local port game_port isolation
    port=$(env_value HTTP_PORT)
    game_port=$(env_value GAME_PORT)
    isolation=$(env_value GAME_ISOLATION)
    for _ in $(seq "${HEALTH_TRIES:-40}"); do
        if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${port:-80}/api/setup/status" \
            && { [ "$isolation" = off ] || curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${game_port:-8081}/rpg-fixes.js"; }; then
            return 0
        fi
        sleep "${HEALTH_SLEEP:-3}"
    done
    return 1
}

main() {
    cd "$REPO_DIR"

    # 1. Есть незакоммиченные правки — значит, кто-то работает прямо на сервере. Не мешаем.
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        echo "Есть незакоммиченные изменения, деплой пропущен"
        return 0
    fi

    # 2. Что нового на GitHub? Ветки deploy нет — CI её ещё не ставил
    if ! git fetch --quiet origin "$BRANCH"; then
        echo "Ветка $BRANCH на GitHub не получена (её ставит CI после зелёных тестов) — ждём"
        return 0
    fi
    local local_sha remote_sha
    local_sha=$(git rev-parse HEAD)
    remote_sha=$(git rev-parse "origin/$BRANCH")

    if [ "$local_sha" = "$remote_sha" ]; then
        return 0
    fi
    if [ "$(cat "$STATE_DIR/failed" 2>/dev/null)" = "$remote_sha" ]; then
        echo "${remote_sha:0:7} уже не поднимался и был откачен — ждём следующий коммит"
        return 0
    fi

    # 3. Обновляемся только "перемоткой вперёд": локальных коммитов поверх origin быть не должно
    if ! git merge-base --is-ancestor HEAD "$remote_sha"; then
        echo "Локальная ветка впереди origin или разошлась с ним, деплой пропущен"
        return 0
    fi

    # 4. Обновляемся ровно до проверенного коммита и пересобираем контейнеры. Нынешний образ — в
    #    запас (тег :previous): не соберётся или не ответит новая версия — вернёмся на него
    echo "Деплой ${local_sha:0:7} -> ${remote_sha:0:7}"
    local image
    image=$(docker compose config --images | grep -- '-rpg-library$' | head -n1)
    docker image tag "$image:latest" "$image:previous" 2>/dev/null || true

    rollback() {
        local why=$1
        echo "Откат на ${local_sha:0:7}: $why" >&2
        mkdir -p "$STATE_DIR"
        echo "$remote_sha" > "$STATE_DIR/failed"
        git reset --hard --quiet "$local_sha"
        if docker image inspect "$image:previous" >/dev/null 2>&1; then
            docker image tag "$image:previous" "$image:latest"
            docker compose up -d --no-build --remove-orphans || true
        else
            docker compose up -d --build --remove-orphans || true
        fi
        if healthy; then
            notify_telegram "⚠️ Обновление библиотеки до ${remote_sha:0:7} $why — вернул прежнюю версию ${local_sha:0:7}, сайт работает. Следующий коммит выкатится как обычно"
        else
            notify_telegram "🚨 Обновление до ${remote_sha:0:7} $why, и прежняя версия ${local_sha:0:7} тоже не отвечает — нужна помощь: docker logs ${image}-1"
        fi
    }

    git merge --ff-only --quiet "$remote_sha"
    if ! docker compose up -d --build --remove-orphans; then
        rollback "не собралось"
        return 0
    fi
    if ! healthy; then
        rollback "не ответило за две минуты"
        return 0
    fi
    rm -f "$STATE_DIR/failed"
    # Убираем за собой: без этого старые образы и кэш сборки растут бесконечно (:previous остаётся)
    docker image prune -f >/dev/null
    docker builder prune -f --max-used-space 2GB >/dev/null
    echo "Готово"
}

main "$@"; exit
