#!/usr/bin/env bash
# Автотесты интерфейса Mimikin. Собирает образ библиотеки из рабочей копии, кладёт в него демо-библиотеку
# (api/scripts/demo-library.js) и гоняет Playwright против этого сервера. Аргументы уходят Playwright'у:
#   tests/e2e/run.sh                 — все тесты
#   tests/e2e/run.sh -g корзина      — только с «корзина» в названии
#   E2E_NO_BUILD=1 tests/e2e/run.sh  — без пересборки образов (быстрее, если код сервера не менялся)
# Отчёт с трассами упавших тестов — tests/e2e/report/html, журнал сервера — tests/e2e/report/app.log
set -euo pipefail
cd "$(dirname "$0")"
# Проект compose задаёт compose.yml; чужое имя из окружения увело бы down -v в другой проект
unset COMPOSE_PROJECT_NAME
mkdir -p report

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
[ -n "${E2E_NO_BUILD:-}" ] || docker compose build
# Снимкам экрана — один и тот же «сегодня» (fixtures.js, DEMO_NOW): даты игр демо считаются от него
docker compose run --rm --no-deps ${VISUAL:+-e DEMO_NOW=2026-10-03T12:00:00Z} mimikin node scripts/demo-library.js /games
docker compose up -d --wait mimikin

set +e
docker compose run --rm runner npx playwright test -c e2e/playwright.config.js "$@"
status=$?
set -e

docker compose logs --no-color mimikin > report/app.log 2>&1 || true
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
exit $status
