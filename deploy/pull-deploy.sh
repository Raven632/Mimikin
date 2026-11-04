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
# Сборка с нуля занимает около 12 ГБ: меньше этого запаса — не начинаем, иначе заполним диск вместе с работающим сайтом
MIN_FREE_GB=${DEPLOY_MIN_FREE_GB:-15}
# Столько раз пробуем собрать один коммит, если сборку убивают (таймаут службы, перезагрузка)
MAX_ATTEMPTS=3

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

    # Прошлый запуск убит посреди сборки: код уже новый, а контейнер старый. Сравнение коммитов этого не видит —
    # помним сами: что собирали, куда откатываться и которая это попытка
    local building=$STATE_DIR/building pending='' previous='' attempt=0
    if [ -f "$building" ]; then read -r pending previous attempt < "$building" || true; fi
    # Запись оборвана или коммита уже нет — откатываться некуда, считаем обычным запуском
    if ! git cat-file -e "${previous:-none}^{commit}" 2>/dev/null; then pending=''; previous=''; attempt=0; fi

    if [ "$local_sha" = "$remote_sha" ] && [ "$pending" != "$remote_sha" ]; then
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

    # Места мало — код не трогаем и сборку не начинаем. Таймер срабатывает каждую минуту, сообщение — одно на коммит.
    # Сборку, которую убили, продолжаем при любом месте: код уже новый, кэш от неё занят и сам не освободится
    local free_gb docker_root
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
    free_gb=$(df --output=avail -BG "${docker_root:-$REPO_DIR}" | tail -n1 | tr -dc 0-9)
    if [ "$pending" != "$remote_sha" ] && [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
        echo "Свободно ${free_gb} ГБ, нужно ${MIN_FREE_GB}: деплой ждёт места"
        if [ "$(cat "$STATE_DIR/low-disk" 2>/dev/null)" != "$remote_sha" ]; then
            mkdir -p "$STATE_DIR"
            echo "$remote_sha" > "$STATE_DIR/low-disk"
            notify_telegram "⚠️ Обновление библиотеки до ${remote_sha:0:7} ждёт места: свободно ${free_gb} ГБ, нужно ${MIN_FREE_GB}. Сайт работает на прежней версии, обновится сам, когда место появится"
        fi
        return 0
    fi

    # 4. Обновляемся ровно до проверенного коммита и пересобираем контейнеры. Нынешний образ — в
    #    запас (тег :previous): не соберётся или не ответит новая версия — вернёмся на него.
    #    После убитой сборки работает всё ещё прежний образ: откат — к нему, и запас не перезаписываем
    local back_sha=$local_sha
    if [ -n "$pending" ]; then back_sha=$previous; fi
    if [ "$pending" = "$remote_sha" ]; then attempt=$((attempt + 1)); else attempt=1; fi
    echo "Деплой ${back_sha:0:7} -> ${remote_sha:0:7} (попытка $attempt)"
    local image
    image=$(docker compose config --images | grep -- '-rpg-library$' | head -n1)
    if [ -z "$pending" ]; then docker image tag "$image:latest" "$image:previous" 2>/dev/null || true; fi

    rollback() {
        local why=$1
        echo "Откат на ${back_sha:0:7}: $why" >&2
        git reset --hard --quiet "$back_sha"
        if docker image inspect "$image:previous" >/dev/null 2>&1; then
            docker image tag "$image:previous" "$image:latest"
            docker compose up -d --no-build --remove-orphans || true
        else
            docker compose up -d --build --remove-orphans || true
        fi
        # Пометки — только теперь: убьют посреди отката, и следующий запуск его не потеряет
        mkdir -p "$STATE_DIR"
        echo "$remote_sha" > "$STATE_DIR/failed"
        rm -f "$building"
        if healthy; then
            notify_telegram "⚠️ Обновление библиотеки до ${remote_sha:0:7} $why — вернул прежнюю версию ${back_sha:0:7}, сайт работает. Следующий коммит выкатится как обычно"
        else
            notify_telegram "🚨 Обновление до ${remote_sha:0:7} $why, и прежняя версия ${back_sha:0:7} тоже не отвечает — нужна помощь: docker logs ${image}-1"
        fi
    }

    if [ "$attempt" -gt "$MAX_ATTEMPTS" ]; then
        rollback "не собралось за $MAX_ATTEMPTS попытки: сборку убивало"
        return 0
    fi
    mkdir -p "$STATE_DIR"
    echo "$remote_sha $back_sha $attempt" > "$building"

    git merge --ff-only --quiet "$remote_sha"
    if ! docker compose up -d --build --remove-orphans; then
        rollback "не собралось"
        return 0
    fi
    if ! healthy; then
        rollback "не ответило за две минуты"
        return 0
    fi
    rm -f "$STATE_DIR/failed" "$STATE_DIR/low-disk" "$building"
    # Убираем за собой: без этого старые образы и кэш сборки растут бесконечно (:previous остаётся). Кэш оставляем с запасом:
    # при 2 ГБ вытеснялись слои зависимостей, и каждая выкладка собиралась с нуля — полчаса и 12 ГБ
    docker image prune -f >/dev/null
    docker builder prune -f --max-used-space "${BUILD_CACHE_KEEP:-20GB}" >/dev/null
    echo "Готово"
}

main "$@"; exit
