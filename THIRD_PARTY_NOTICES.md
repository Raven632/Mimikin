# Third-party software and assets

this project's own code is licensed under the GNU AGPL-3.0 (see [LICENSE](LICENSE)). This file lists what
this project uses from other people, under which license, and where it comes from. None of these components
were changed, unless said otherwise.

## In this repository

| What | Where | License | Source |
|---|---|---|---|
| M PLUS Rounded 1c font (Latin and Cyrillic subsets, weight 500) | `api/public/fonts/` | SIL Open Font License 1.1 — text in `api/public/fonts/OFL-M-PLUS-Rounded-1c.txt` | [Google Fonts](https://fonts.google.com/specimen/M+PLUS+Rounded+1c), © The M+ Project Authors |
| Fira Sans font (Latin and Cyrillic subsets, weights 400–800) | `frontend/public/ui-fonts/` | SIL Open Font License 1.1 — text in `frontend/public/ui-fonts/OFL-FiraSans.txt` | [Google Fonts](https://fonts.google.com/specimen/Fira+Sans), © The Mozilla Foundation and Telefonica S.A. |
| Tiny5 font (Latin and Cyrillic subsets, weight 400), used for headings | `frontend/public/ui-fonts/` | SIL Open Font License 1.1 — text in `frontend/public/ui-fonts/OFL-Tiny5.txt` | [Google Fonts](https://fonts.google.com/specimen/Tiny5), © The Tiny5 Project Authors |
| Logos of the sites the library links to (Steam, VNDB, itch.io) | `frontend/public/*-logo.*` | Trademarks of their owners, **not** covered by this project's license | Used only to mark links to those sites |

The cheat menu (`api/public/cheats.js`) is this project's own code. Version 6.0 shipped a third-party
cheat menu plugin instead; it was removed.

## Installed when the server and the interface are built (npm)

Server (`api/package.json`):

| Package | License |
|---|---|
| express, compression, cookie-parser, multer, express-rate-limit, helmet | MIT |
| socket.io, redis (node-redis), sqlite, lz-string, bcrypt | MIT |
| sqlite3 | BSD-3-Clause |
| dotenv | BSD-2-Clause |
| onnxruntime-node, ssh2 | MIT |

Interface (`frontend/package.json`): react, react-dom, socket.io-client, pixi.js, pixi-live2d-display, @pixi-spine/* — MIT.
`@pixi-spine/*` (the Spine animation player in the gallery) is MIT-licensed code that plays Spine skeletons
which are subject to the [Spine Runtimes License](http://esotericsoftware.com/spine-runtimes-license): the
skeletons and atlases belong to the games and are only played, never created or edited here. The Live2D
Cubism Core is **not** shipped; a game's own copy is loaded from the game when one of its models is opened. Build and check tools
(not shipped to users): vite, @vitejs/plugin-react, eslint and its plugins, globals, @types/* — MIT.
Tests (`tests/`): Playwright — Apache-2.0.

Each package brings its own dependencies; their licenses are in `node_modules/<package>/` after
`npm ci`. Almost all are permissive (MIT, ISC, BSD, Apache-2.0 and similar); the build tools also pull in
MPL-2.0 packages (lightningcss) and CC-BY-4.0 data (caniuse-lite), which are used only while building and
are not shipped. SQLite itself, built into sqlite3, is in the public domain.

## In the Docker image of the library

| What | License | Source |
|---|---|---|
| Node.js 22 (`node:22-slim`, Debian) | MIT; Debian packages — their own licenses | [nodejs.org](https://nodejs.org/), [debian.org](https://www.debian.org/) |
| FFmpeg (Debian package `ffmpeg`), run as a separate program | LGPL-2.1+ / GPL-2.0+ | [ffmpeg.org](https://ffmpeg.org/), sources in Debian |
| 7-Zip `7zz` 26.00, run as a separate program | GNU LGPL-2.1+ with the unRAR license restriction; some parts BSD-3-Clause | [7-zip.org](https://www.7-zip.org/), [github.com/ip7z/7zip](https://github.com/ip7z/7zip) |

## Services in `docker-compose.yml`

| What | License | Note |
|---|---|---|
| Redis 7 (`redis:7-alpine`) | 7.4 and later: RSALv2 / SSPLv1 (source-available); earlier 7.x: BSD-3-Clause | Used unchanged, as its own container |
| Text-on-pictures service (`ocr/`) | this project's own code (AGPL-3.0) | Its parts are listed below |
| LibreTranslate (`libretranslate/libretranslate`) with Argos Translate language models — optional, profile `libretranslate` | AGPL-3.0; the models — their own open licenses | Used unchanged, as its own container; Docker downloads it from its authors only when the profile is on |

### The text-on-pictures service (`ocr/`)

Base image `python:3.12-slim` (Python — PSF License; Debian packages — their own licenses).

Models, downloaded and checked by SHA-256 when the image is built (`ocr/fetch_models.py`):

| Model | License | Source |
|---|---|---|
| PaddleOCR PP-OCRv6 small, text detection and recognition (ONNX) | Apache-2.0 | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), ONNX files from [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) |
| manga-ocr (`kha-white/manga-ocr-base`) | Apache-2.0 | [kha-white/manga-ocr](https://github.com/kha-white/manga-ocr) |
| manga-ocr in ONNX (`mayocream/manga-ocr-onnx`); quantized to int8 when the image is built | Apache-2.0 | [huggingface.co/mayocream/manga-ocr-onnx](https://huggingface.co/mayocream/manga-ocr-onnx) |

Python packages (`ocr/requirements.txt`):

| Package | License |
|---|---|
| rapidocr, opencv-python-headless (OpenCV), requests | Apache-2.0 |
| onnxruntime, pyclipper, six, PyYAML, colorlog, urllib3, charset-normalizer | MIT |
| numpy | BSD-3-Clause (with 0BSD, MIT and Zlib parts) |
| shapely, omegaconf, antlr4-python3-runtime, idna | BSD-3-Clause |
| pillow | MIT-CMU |
| tqdm | MPL-2.0 and MIT |
| certifi | MPL-2.0 |
| onnx (build stage only, to quantize the model; not in the final image) | Apache-2.0 |

These packages bring their own dependencies (installed by pip; licenses in `site-packages`). The
opencv-python-headless wheel includes FFmpeg libraries under LGPL-2.1+.

## Models downloaded by the server at run time

Fetched once from Hugging Face by the gallery's picture search and kept in the library folder; not part
of this repository or the image.

| Model | License | Source |
|---|---|---|
| `Xenova/clip-vit-base-patch32` (quantized vision model, ONNX), runs in `onnxruntime-node` | MIT | [huggingface.co/Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32) |
| `sentence-transformers/clip-ViT-B-32-multilingual-v1` (text encoder) | Apache-2.0 | [huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1](https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1) |

## Games

Games are not part of Mimikin: each one belongs to its authors and is kept, unchanged, in your own
library folder.
