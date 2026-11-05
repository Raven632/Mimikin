#!/usr/bin/env bash
# Модели поиска картинок по словам для записи демо (record.sh): те же файлы и те же суммы, что у сервера
# (api/src/services/galleryVision.js и galleryText.js), только адрес привязан к ревизии репозитория модели, а не к main.
# Единственное, ради чего запись ходит в сеть: качает один раз в кэш и проверяет sha256; дальше запись идёт без сети.
#   tests/demo/models.sh [папка кэша]      — по умолчанию $DEMO_CACHE или ~/.cache/mimikin-demo
# В папке кэша появляется models/ (≈360 МБ); в git она не попадает. Кэш Pages-сборки — actions/cache на эту папку.
set -euo pipefail
CACHE="${1:-${DEMO_CACHE:-$HOME/.cache/mimikin-demo}}/models"
mkdir -p "$CACHE"

CLIP_VISION=https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/6b7c523703ae26e39be4b03774966f8571c7f523
CLIP_TEXT=https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/58edf8cada9e398793dca955574a48cbb7f18be2

# имя файла в _media/_models | адрес | sha256 (как в сервере)
FILES=(
  "clip-vit-b32-vision-q8.onnx|$CLIP_VISION/onnx/vision_model_quantized.onnx|583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299"
  "clip-multilingual-text-fp16.onnx|$CLIP_TEXT/onnx/model_O4.onnx|c477ffcac84a350f654d0c1b27e68b038056f0922c933b146a67cd301f8092fd"
  "clip-multilingual-dense.safetensors|$CLIP_TEXT/2_Dense/model.safetensors|d12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74"
  "clip-multilingual-vocab.txt|$CLIP_TEXT/vocab.txt|fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c"
)

for row in "${FILES[@]}"; do
  IFS='|' read -r name url sum <<<"$row"
  if [ -f "$CACHE/$name" ] && [ "$(sha256sum "$CACHE/$name" | cut -d' ' -f1)" = "$sum" ]; then continue; fi
  echo "[models] качаю $name" >&2
  rm -f "$CACHE/$name.part"
  timeout 1800 curl -fsSL --retry 3 --retry-delay 5 -o "$CACHE/$name.part" "$url"
  got="$(sha256sum "$CACHE/$name.part" | cut -d' ' -f1)"
  if [ "$got" != "$sum" ]; then rm -f "$CACHE/$name.part"; echo "[models] $name: сумма $got, ждали $sum" >&2; exit 1; fi
  mv "$CACHE/$name.part" "$CACHE/$name"
done
echo "$CACHE"
