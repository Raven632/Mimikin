#!/usr/bin/env bash
# Запись данных демо-сайта (описание — в шапке record.js). Из корня репозитория:
#   tests/demo/record.sh [папка]          — по умолчанию frontend/demo-data
#   DEMO_NO_BUILD=1 tests/demo/record.sh  — взять готовый образ demo-record-app, не собирать заново
# Контейнер без сети (--network none): сервер внутри ходит только сам к себе. Результат забираем через docker cp, а не
# через общую папку: в CI файлы из контейнера иначе достались бы root'у, и их нечем было бы стереть
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-frontend/demo-data}"
IMAGE="${DEMO_IMAGE:-demo-record-app}"
NAME="demo-record-$$"
NOW="${DEMO_NOW:-2026-10-03T12:00:00Z}"

trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
[ -n "${DEMO_NO_BUILD:-}" ] || docker build -q -t "$IMAGE" . >/dev/null

docker create --name "$NAME" --network none \
  -e TZ=UTC -e "DEMO_NOW=$NOW" -e DEMO_STRICT="${DEMO_STRICT:-}" -e DEMO_VERBOSE="${DEMO_VERBOSE:-}" \
  -v "$PWD/tests/demo:/demo:ro" -v "$PWD/frontend/demo:/frontend-demo:ro" \
  "$IMAGE" node /demo/record.js >/dev/null
timeout 900 docker start -a "$NAME"

rm -rf "$OUT.new"
mkdir -p "$OUT.new"
docker cp "$NAME:/tmp/demo-out/." "$OUT.new"
rm -rf "$OUT"
mv "$OUT.new" "$OUT"
echo "[record] готово: $OUT ($(find "$OUT" -type f | wc -l) файлов, $(du -sh "$OUT" | cut -f1))" >&2
