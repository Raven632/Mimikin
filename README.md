# Mimikin — a library for RPG Maker games

🇷🇺 [Русский](README.ru.md) | 🇩🇪 [Deutsch](README.de.md)

[![GitHub Release](https://img.shields.io/github/v/release/Raven632/rpg-library?style=for-the-badge&color=blue)](https://github.com/Raven632/rpg-library/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-yellow.svg?style=for-the-badge)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Raven632/rpg-library/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Raven632/rpg-library/actions)
![Tests](https://img.shields.io/badge/Tests-287_API_%2B_197_UI_%2B_13_OCR-brightgreen?style=for-the-badge&logo=node.js&logoColor=white)

![Node.js](https://img.shields.io/badge/Node.js-22.x-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)

A self-hosted web library for RPG Maker games (MV/MZ): keep them on your home server, play them in the
browser on a phone, tablet or PC, and let the server find everything about them. Version 7.0.

![The library — a demo collection of fictional games](rest/img/library.png)

<p align="center">
  <img src="rest/img/game.png" alt="The game window" width="70%">
  <img src="rest/img/phone.png" alt="On a phone" width="24%">
</p>

## ✨ Features

### Play

- **In any browser.** `rpg-fixes.js` stands in for NW.js, so the PC builds of RPG Maker games run on a
  phone too: sound on iPhone, videos, fonts, folders named in any letter case.
- **Cloud saves with history.** Saves go to the server — start on the PC, go on on the phone. Every
  overwritten slot is kept for a while, and "Save history" puts any version back; a save made offline
  never overwrites a newer one from another device.
- **Moments and rewind.** `P` (on a phone, "Screenshot" in the game menu) saves a picture together with
  a save, so you can come back to that very place. The game sets rewind points by itself — before a
  scene, a choice, a battle, on a new map — and `Backspace` takes you back, also line by line.
  "Path" lists what you went through, day by day.
- **A menu in the game:** turbo ×3, an own cheat menu (party, items, variables and switches, teleport,
  scene unlocking), save anywhere on the map, an on-screen gamepad and keyboard, a real gamepad,
  stretch and smoothing, a frame counter.
- **Games run on their own address**, apart from the library: a game's code cannot reach the
  library's data or other sites.

### Library

- **Data found by itself** from itch.io, VNDB and Steam: cover, screenshots, description, tags,
  developer, release date. Every match is checked against all of the game's names; when nothing fits,
  the game window says what exactly was not found and lists near misses.
- **A gallery from the game's own files** — CG, characters, backgrounds in albums, frames played as an
  animation, scenes with their dialogue and sound, videos, a sound room, Spine and Live2D models — all
  without playing the game. **Search by what is drawn**, in your own language; favourites with a heart.
- **Translation of MV/MZ games** on the server, like MTool: texts, plugin parameters, and the labels
  drawn on pictures (PaddleOCR and manga-ocr). The game's own files are never touched.
- **Statuses set themselves** ("Playing", "Not started"), and **"What to play?"** picks a game among
  the ones not started, by genre.
- **New games** from the itch.io catalog — by tag, period, price and platform — with a "Want to play"
  list and a mark on the games you already have.
- **Stats and audit:** time played, gaps in the data, duplicates, heavy games, disk space, errors that
  games hit on your devices. A trash keeps a deleted game for 30 days.

### Uploads and downloads

- **Any size, from a phone too.** A broken upload resumes where it stopped — after a reload or from
  another device. Archives with a password, a game packed inside another archive, several at once.
- **A link to a file host** (mega, gofile, pixeldrain…) goes to your own MyJDownloader, and the library
  installs what comes back. An `_inbox` folder and an SFTP seedbox work the same way.
- **Update a game with its new version** — saves, time and data stay; **install a patch or a mod** on
  top. The previous version is set aside and comes back with one button.

### Notifications and safety

- **Telegram** (optional, your own bot): finished uploads, a daily backup of the database and saves
  when something changed, problems. Silent except for problems, at most ten messages an hour.
- **Backup** of the database and saves from the menu, **restore** from the library; a nightly backup
  on the server.
- **Hardened:** login attempts are limited, the API answers only the library's own pages, keys saved in
  Settings are encrypted in the database, a backup file carries no sign-in key, a deploy that does not
  come up is rolled back.
- **Interface** in English, Russian and German; hide covers with one button (`H`); live sync between
  devices.

## 🧩 Under the hood

- **Game isolation.** Games are served from a separate origin (`GAME_PORT`). A game gets its files and
  saves only by a key in its address — an HMAC of the session secret, the game and its folder — so
  signing out or replacing the game changes it, and a path has to stay inside that game's folder. A
  Content-Security-Policy keeps the game's code from calling other sites, and the library's API checks
  Fetch Metadata (`Sec-Fetch-Site`), so a game cannot call it either. The library opens the game
  full-screen in a sandboxed frame and talks to it with `postMessage`.
- **NW.js in the browser.** `api/public/rpg-fixes.js` gives PC builds what they expect from NW.js:
  stand-ins for Node's `fs` and `path`, a per-game `localStorage` namespace, cloud saves with an offline
  queue and conflict detection, a touch gamepad, the iOS audio unlock, and error reports back to the
  server.
- **Resumable uploads.** Archives go up in pieces sized to the connection (16–256 MB) and resume by a
  file fingerprint — name, size and a hash of the first and last megabyte — after a reload or from
  another device. Unpacking runs in the background and is finished after a server restart. On iOS a
  large request's response never resolves, so the page confirms each piece through a short status
  request instead.
- **Saves and rewind.** Atomic writes (temporary file + rename), a thinned history per slot (the last
  five, then one per 10 minutes, at most 30) and a conflict check by the client's save time. Rewind
  points are saves that carry their playthrough, so rewinding follows the run you are in.
- **Updates and patches without copies.** A patch is laid over a hard-linked copy of the game
  (`cp -al`); changed files are unlinked before being replaced, so the previous version keeps its own.
  Where a patch's files go is found by matching them against the game's files, case-insensitively.
- **Gallery index.** Only the first 40 bytes of each picture are read: PNG `IHDR`, WebP `VP8`/`VP8L`/
  `VP8X` and RPG Maker's encrypted headers give the size; size and byte density sort pictures into CG,
  characters, backgrounds and layers; names group frames into albums, and the game's own events (read
  from its map and common-event files) give scenes with dialogue. Thumbnails are WebP made once by
  FFmpeg. Picture search runs a quantized CLIP model in `onnxruntime-node`.
- **Metadata lookup.** Each lookup tracks which sources did not answer (`AsyncLocalStorage`), so "not
  found" and "could not ask" are different results with their own retry schedule; titles are cleaned
  and compared by a Dice coefficient; ScraperAPI requests are capped by a daily credit budget.
- **Translation.** Texts are taken from the game's data files (what is shown and what is code is told
  apart), translated by the engine of your choice (DeepL, Microsoft, Google, LibreTranslate) and kept
  in the database, one record per string for all games. The game server swaps them in as it serves a
  file, so the game on disk stays the original and switching translation off brings it back at once.
  Labels on pictures are read by a separate OCR service (`ocr/`, Python, ONNX) and drawn over the
  picture in the page.
- **Operations.** Docker Compose; a pull-based deploy that checks health and rolls back to the
  previous image; SQLite in WAL mode; nightly backups; Telegram alerts; CI runs the tests and the build
  and then moves the `deploy` branch the server follows.
- **Tests.** 287 server and HTTP tests, 197 interface tests, 13 OCR tests. Node's test runner, no network: sources are faked, uploads and the game server
  run on real HTTP servers on free ports. Playwright runs the interface in Docker without internet,
  including phone widths, and a separate check opens every game of a library in headless Chromium and
  reports the scene it reached. The README screenshots are taken from a demo library of made-up games
  (`api/scripts/demo-library.js`).

## 🛠 Tech Stack

- **Backend:** Node.js 22, Express, Socket.io, Redis (games list cache), SQLite.
- **Frontend:** React 19 + Vite, pixi.js for Spine and Live2D.
- **Services:** an OCR service in Python (`ocr/`); LibreTranslate optionally.
- **Tools:** 7-Zip (`7zz`), FFmpeg, Docker Engine.
- **Tests:** Node test runner (unit and HTTP), Playwright (interface, game compatibility), unittest (OCR).

## 🚀 Installation

Built for **native Docker Engine** (Linux). Docker Desktop is not recommended: file I/O through its VM
is slow with large archives. The image is built from this repository; there is no ready-made one.

1. Clone the repository:
   ```bash
   git clone https://github.com/Raven632/rpg-library.git
   cd rpg-library
   ```

2. (Optional) Create your settings — the server also starts without them:
   ```bash
   cp .env.example .env
   ```
   Every setting is described in the file. Worth a look:
   - `SESSION_SECRET` — your own key: `openssl rand -hex 64`. Without it one is made on first start.
   - `SCRAPER_API_KEY` — a free ScraperAPI key (1000 credits a month) opens itch.io game pages; VNDB
     and Steam work without it.
   - `HTTP_PORT` (80) — the library; `GAME_PORT` (8081) — the games. **Both must be reachable** from
     your devices (home network, Tailscale).
   - `TELEGRAM_BOT_TOKEN` — for notifications; then "⋯ → Settings → Notifications → Connect".
   - `COMPOSE_PROFILES=libretranslate` — a translator of your own next to the library (several GB of
     models, 2–4 GB of memory).

3. Start (the first build downloads the text-recognition models, a few hundred MB):
   ```bash
   docker compose up -d --build
   ```

4. Open `http://<server>` (port `HTTP_PORT`) and create the master account.

To try it with made-up games first, `docker compose exec rpg-library node scripts/demo-library.js /games`
fills the library with sixteen demo titles.

### Upgrading from 6.0

Make a backup first ("⋯ → Settings → Backups"); the database updates itself on the first start. The
project is now AGPL-3.0, the data comes from itch.io, VNDB and Steam, and the settings live in the
library ("⋯ → Settings"). **6.0 has a hole: a game's address key could read the whole library folder
— update.** Details in [CHANGELOG.md](CHANGELOG.md).

## 📂 Directory Structure

The `./games` folder (`GAMES_HOST_DIR`) is mounted into the container as `/games`:

- `/games/<game>` — the games, unpacked. Nothing is ever written into a game's folder.
- `/games/library.db` — the database.
- `/games/_saves` — cloud saves; `_saves/.history` — previous versions of slots.
- `/games/_media` — covers, screenshots, gallery index and thumbnails.
- `/games/_old` — previous versions of updated or patched games.
- `/games/_trash` — deleted games for 30 days.
- `/games/_inbox` — archives to install by themselves.
- `/games/_tmp_uploads` — uploads in progress.

## 🧪 Tests

```bash
cd api && npm ci && npm test             # server and HTTP tests (needs a Redis for http.test.js)
cd frontend && npm ci && npm run lint    # interface
tests/e2e/run.sh                         # the interface in Docker, with a demo library
```

## 📜 Changelog

What changed in each version — in [CHANGELOG.md](CHANGELOG.md).

## 📝 When the lookup misses

Open the game, press "Edit" and paste a link — an itch.io page, a Steam store page or a VNDB entry.
The data is found again at once.

## 📄 License

Copyright © 2026 Raven. Mimikin is free software under the
[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only): you may use, study, change and share
it. If you share a changed version, or run one for other people over a network, you must publish its
source code under the same license. Release 6.0 (tag v6.0) was published under MIT for its own code; the
third-party cheat menu plugin it included was never covered and has been removed.
Borrowed components and their licenses — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
