# Mimikin — eine Bibliothek für RPG-Maker-Spiele

🇬🇧 [English](README.md) | 🇷🇺 [Русский](README.ru.md)

[![GitHub Release](https://img.shields.io/github/v/release/Raven632/rpg-library?style=for-the-badge&color=blue)](https://github.com/Raven632/rpg-library/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-yellow.svg?style=for-the-badge)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Raven632/rpg-library/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Raven632/rpg-library/actions)
![Tests](https://img.shields.io/badge/Tests-287_API_%2B_197_UI_%2B_13_OCR-brightgreen?style=for-the-badge&logo=node.js&logoColor=white)

![Node.js](https://img.shields.io/badge/Node.js-22.x-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)

Eine eigene Web-Bibliothek für RPG-Maker-Spiele (MV/MZ): Die Spiele liegen auf dem Heimserver, gespielt
wird im Browser auf Handy, Tablet oder PC, und alles über die Spiele findet der Server selbst. Version 7.0.

![Die Bibliothek — eine Demo-Sammlung erfundener Spiele](rest/img/library.png)

<p align="center">
  <img src="rest/img/game.png" alt="Das Spielfenster" width="70%">
  <img src="rest/img/phone.png" alt="Auf dem Handy" width="24%">
</p>

## ✨ Funktionen

### Spielen

- **In jedem Browser.** `rpg-fixes.js` ersetzt NW.js, deshalb laufen die PC-Versionen von
  RPG-Maker-Spielen auch auf dem Handy: Ton auf dem iPhone, Videos, Schriften, Ordner in beliebiger
  Groß- und Kleinschreibung.
- **Cloud-Spielstände mit Verlauf.** Spielstände liegen auf dem Server — am PC anfangen, am Handy
  weiterspielen. Ein überschriebener Slot bleibt eine Weile erhalten, und „Spielstand-Verlauf“ holt
  jede Version zurück; ein ohne Netz gespeicherter Stand überschreibt keinen neueren von einem anderen
  Gerät.
- **Momente und Zurückspulen.** `P` (auf dem Handy „Screenshot“ im Spielmenü) speichert ein Bild
  zusammen mit einem Spielstand, sodass du an genau diese Stelle zurückkehren kannst. Das Spiel setzt
  Rücksprungpunkte selbst — vor einer Szene, einer Wahl, einem Kampf, auf einer neuen Karte — und
  `Backspace` bringt dich zurück, auch Zeile für Zeile. „Weg“ zeigt, was du durchlaufen hast, nach Tagen.
- **Menü im Spiel:** Turbo ×3, ein eigenes Cheat-Menü (Gruppe, Gegenstände, Variablen und Schalter,
  Teleport, Szenen freischalten), Speichern überall auf der Karte, Bildschirm-Gamepad und -Tastatur,
  echtes Gamepad, Strecken und Glätten, Bildzähler.
- **Spiele laufen unter eigener Adresse**, getrennt von der Bibliothek: der Code eines Spiels erreicht
  weder die Daten der Bibliothek noch fremde Seiten.

### Bibliothek

- **Daten finden sich selbst** — von itch.io, VNDB und Steam: Cover, Screenshots, Beschreibung, Tags,
  Entwickler, Erscheinungsdatum. Jeder Treffer wird mit allen Namen des Spiels abgeglichen; passt nichts,
  sagt das Spielfenster, was genau nicht gefunden wurde, und zeigt knappe Fehlschläge.
- **Eine Galerie aus den Dateien des Spiels** — CG, Figuren, Hintergründe in Alben, Bilder als
  Animation abspielbar, Szenen mit Dialog und Ton, Videos, ein Klangraum, Spine- und Live2D-Modelle —
  alles ohne das Spiel zu spielen. **Suche nach dem, was zu sehen ist**, in deiner Sprache; Favoriten mit
  einem Herz.
- **Übersetzung von MV/MZ-Spielen** auf dem Server, wie MTool: Texte, Plugin-Parameter und Beschriftungen
  auf Bildern (PaddleOCR und manga-ocr). Die Dateien des Spiels bleiben unangetastet.
- **Status setzen sich selbst** („Spiele gerade“, „Nicht begonnen“), und **„Was spielen?“** schlägt
  ein noch nicht angefangenes Spiel vor, nach Genre.
- **Neue Spiele** aus dem itch.io-Katalog — nach Tag, Zeitraum, Preis und Plattform — mit einer
  „Will ich spielen“-Liste und einer Markierung für Spiele, die schon da sind.
- **Statistik und Prüfung**: Spielzeit, Lücken in den Daten, Duplikate, schwere Spiele, Speicherplatz,
  Fehler, auf die Spiele auf deinen Geräten stoßen. Ein gelöschtes Spiel liegt 30 Tage im Papierkorb.

### Hochladen und Herunterladen

- **Jede Größe, auch vom Handy.** Ein abgebrochener Upload geht an derselben Stelle weiter — nach dem
  Neuladen oder von einem anderen Gerät. Archive mit Passwort, ein Spiel in einem Archiv im Archiv,
  mehrere auf einmal.
- **Ein Link zu einem Filehoster** (mega, gofile, pixeldrain…) geht an deinen eigenen MyJDownloader, und
  die Bibliothek installiert, was ankommt. Ein `_inbox`-Ordner und eine SFTP-Seedbox funktionieren genauso.
- **Ein Spiel mit seiner neuen Version aktualisieren** — Spielstände, Zeit und Daten bleiben; **einen
  Patch oder Mod installieren**. Die vorige Version wird beiseitegelegt und kommt mit einem Knopf zurück.

### Benachrichtigungen und Sicherheit

- **Telegram** (optional, eigener Bot): fertige Uploads, einmal am Tag eine Sicherung von Datenbank und
  Spielständen, wenn sich etwas geändert hat, Probleme. Alles außer Problemen lautlos, höchstens zehn
  Nachrichten pro Stunde.
- **Sicherung** von Datenbank und Spielständen aus dem Menü, **Wiederherstellung** in der Bibliothek;
  eine nächtliche Sicherung auf dem Server.
- **Abgesichert:** Anmeldeversuche begrenzt, die API antwortet nur den Seiten der Bibliothek, Schlüssel
  aus den Einstellungen liegen verschlüsselt in der Datenbank, eine Sicherungsdatei enthält keinen
  Anmeldeschlüssel, ein Deploy, der nicht hochkommt, wird zurückgerollt.
- **Oberfläche** auf Deutsch, Englisch und Russisch; Cover mit einem Knopf ausblenden (`H`); Änderungen
  sofort auf allen Geräten.

## 🧩 Unter der Haube

- **Isolierte Spiele.** Spiele werden von einem eigenen Origin ausgeliefert (`GAME_PORT`). Ein Spiel
  bekommt seine Dateien und Spielstände nur über einen Schlüssel in seiner Adresse — ein HMAC aus dem
  Sitzungsgeheimnis, dem Spiel und seinem Ordner —, ein Abmelden oder Austauschen des Spiels ändert ihn,
  und ein Pfad muss im Ordner dieses Spiels bleiben. Eine Content-Security-Policy hindert den Code des
  Spiels daran, fremde Seiten aufzurufen, und die API der Bibliothek prüft Fetch Metadata
  (`Sec-Fetch-Site`), sodass ein Spiel auch sie nicht aufrufen kann. Die Bibliothek öffnet das Spiel
  im Vollbild in einem Sandbox-Frame und spricht mit ihm über `postMessage`.
- **NW.js im Browser.** `api/public/rpg-fixes.js` gibt PC-Versionen, was sie von NW.js erwarten:
  Ersatz für `fs` und `path` von Node, einen eigenen `localStorage`-Namensraum pro Spiel,
  Cloud-Spielstände mit Offline-Warteschlange und Konflikterkennung, ein Touch-Gamepad, die
  Audio-Freischaltung auf iOS und Fehlerberichte an den Server.
- **Uploads zum Fortsetzen.** Archive gehen in Stücken hoch, passend zur Verbindung (16–256 MB), und
  setzen sich anhand eines Datei-Fingerabdrucks fort — Name, Größe und ein Hash des ersten und letzten
  Megabytes —, nach dem Neuladen oder von einem anderen Gerät. Das Entpacken läuft im Hintergrund und wird
  nach einem Serverneustart beendet. Auf iOS kommt die Antwort auf eine große Anfrage nie an, deshalb
  bestätigt die Seite jedes Stück über eine kurze Statusanfrage.
- **Spielstände und Zurückspulen.** Atomares Schreiben (temporäre Datei + Umbenennen), ein ausgedünnter
  Verlauf pro Slot (die letzten fünf, dann einer je 10 Minuten, höchstens 30) und eine Konfliktprüfung
  nach der Speicherzeit des Clients. Rücksprungpunkte sind Spielstände, die ihren Durchlauf kennen;
  das Zurückspulen folgt also dem Durchlauf, in dem du gerade bist.
- **Updates und Patches ohne Kopien.** Ein Patch wird über eine Hardlink-Kopie des Spiels gelegt
  (`cp -al`); geänderte Dateien werden vor dem Ersetzen gelöst, sodass die vorige Version ihre eigenen
  behält. Wohin die Dateien eines Patches gehören, ergibt der Abgleich mit den Dateien des Spiels, ohne
  Beachtung der Groß- und Kleinschreibung.
- **Galerie-Index.** Von jedem Bild werden nur die ersten 40 Bytes gelesen: PNG `IHDR`, WebP `VP8`/
  `VP8L`/`VP8X` und die verschlüsselten Header von RPG Maker liefern die Größe; Größe und Bytedichte
  sortieren Bilder in CG, Figuren, Hintergründe und Ebenen; Namen fassen Bilder zu Alben zusammen, und
  die Ereignisse des Spiels (aus seinen Karten- und Common-Event-Dateien) ergeben Szenen mit Dialog.
  Vorschaubilder sind WebP, einmal von FFmpeg erzeugt. Die Bildersuche lässt ein quantisiertes CLIP-Modell
  in `onnxruntime-node` laufen.
- **Datensuche.** Jede Suche merkt sich, welche Quellen nicht geantwortet haben (`AsyncLocalStorage`),
  sodass „nicht gefunden“ und „konnte nicht fragen“ verschiedene Ergebnisse mit eigenem
  Wiederholungsplan sind; Titel werden bereinigt und per Dice-Koeffizient verglichen; Anfragen an
  ScraperAPI sind durch ein tägliches Kreditbudget begrenzt.
- **Übersetzung.** Texte kommen aus den Datendateien des Spiels (was angezeigt wird und was Code ist,
  wird unterschieden), werden vom gewählten Dienst übersetzt (DeepL, Microsoft, Google, LibreTranslate)
  und in der Datenbank gehalten, ein Eintrag je Zeile für alle Spiele. Der Spielserver setzt sie beim
  Ausliefern einer Datei ein; das Spiel auf der Platte bleibt das Original, und ein Abschalten der
  Übersetzung bringt es sofort zurück. Beschriftungen auf Bildern liest ein eigener OCR-Dienst (`ocr/`,
  Python, ONNX); sie werden auf der Seite über das Bild gezeichnet.
- **Betrieb.** Docker Compose; ein Pull-Deploy, der die Gesundheit prüft und auf das vorige Image
  zurückrollt; SQLite im WAL-Modus; nächtliche Sicherungen; Telegram-Warnungen; die CI führt die Tests
  und den Build aus und setzt dann den Branch `deploy` weiter, dem der Server folgt.
- **Tests.** 287 Server- und HTTP-Tests, 197 Oberflächentests, 13 OCR-Tests. Node-Tests ohne Netz: Quellen sind nachgebaut, Uploads und Spielserver laufen auf
  echten HTTP-Servern an freien Ports. Playwright führt die Oberfläche in Docker ohne Internet aus,
  auch in Handybreite, und eine eigene Prüfung öffnet jedes Spiel einer Bibliothek in headless Chromium
  und meldet, bis zu welcher Szene es kam. Die Screenshots in der README stammen aus einer
  Demo-Bibliothek erfundener Spiele (`api/scripts/demo-library.js`).

## 🛠 Tech-Stack

- **Backend:** Node.js 22, Express, Socket.io, Redis (Cache der Spieleliste), SQLite.
- **Frontend:** React 19 + Vite, pixi.js für Spine und Live2D.
- **Dienste:** ein OCR-Dienst in Python (`ocr/`); optional LibreTranslate.
- **Werkzeuge:** 7-Zip (`7zz`), FFmpeg, Docker Engine.
- **Tests:** Node-Testrunner (Unit und HTTP), Playwright (Oberfläche, Spielkompatibilität), unittest (OCR).

## 🚀 Installation

Gedacht für die **native Docker Engine** (Linux). Docker Desktop wird nicht empfohlen: Datei-I/O über
seine VM ist bei großen Archiven langsam. Das Image wird aus diesem Repository gebaut, ein fertiges gibt es nicht.

1. Repository klonen:
   ```bash
   git clone https://github.com/Raven632/rpg-library.git
   cd rpg-library
   ```

2. (Optional) Eigene Einstellungen anlegen — der Server startet auch ohne sie:
   ```bash
   cp .env.example .env
   ```
   Jede Einstellung ist in der Datei beschrieben. Einen Blick wert:
   - `SESSION_SECRET` — ein eigener Schlüssel: `openssl rand -hex 64`. Ohne ihn wird beim ersten Start einer erzeugt.
   - `SCRAPER_API_KEY` — ein kostenloser ScraperAPI-Schlüssel (1000 Credits im Monat) öffnet
     itch.io-Spieleseiten; VNDB und Steam funktionieren ohne ihn.
   - `HTTP_PORT` (80) — die Bibliothek; `GAME_PORT` (8081) — die Spiele. **Beide müssen von deinen
     Geräten erreichbar sein** (Heimnetz, Tailscale).
   - `TELEGRAM_BOT_TOKEN` — für Benachrichtigungen; danach „⋯ → Einstellungen → Benachrichtigungen → Verbinden“.
   - `COMPOSE_PROFILES=libretranslate` — ein eigener Übersetzer neben der Bibliothek (mehrere GB Modelle,
     2–4 GB Arbeitsspeicher).

3. Starten (der erste Build lädt die Modelle zur Texterkennung, einige hundert MB):
   ```bash
   docker compose up -d --build
   ```

4. `http://<Server>` (Port `HTTP_PORT`) öffnen und das Hauptkonto anlegen.

Um es zuerst mit erfundenen Spielen auszuprobieren, füllt `docker compose exec rpg-library node scripts/demo-library.js /games`
die Bibliothek mit sechzehn Demo-Titeln.

### Update von 6.0

Zuerst eine Sicherung machen („⋯ → Einstellungen → Sicherungen“); die Datenbank aktualisiert sich beim
ersten Start selbst. Das Projekt steht jetzt unter AGPL-3.0, die Daten kommen von itch.io, VNDB und Steam,
und die Einstellungen liegen in der Bibliothek („⋯ → Einstellungen“). **6.0 hat eine Sicherheitslücke:
Mit dem Schlüssel in der Adresse eines Spiels ließ sich der ganze Bibliotheksordner lesen — bitte
aktualisieren.** Einzelheiten in [CHANGELOG.md](CHANGELOG.md).

## 📂 Verzeichnisstruktur

Der Ordner `./games` (`GAMES_HOST_DIR`) wird als `/games` in den Container eingebunden:

- `/games/<Spiel>` — die Spiele, entpackt. In den Ordner eines Spiels wird nie etwas geschrieben.
- `/games/library.db` — die Datenbank.
- `/games/_saves` — Cloud-Spielstände; `_saves/.history` — frühere Versionen der Slots.
- `/games/_media` — Cover, Screenshots, Galerie-Index und Vorschaubilder.
- `/games/_old` — vorige Versionen aktualisierter oder gepatchter Spiele.
- `/games/_trash` — gelöschte Spiele für 30 Tage.
- `/games/_inbox` — Archive, die sich von selbst installieren.
- `/games/_tmp_uploads` — laufende Uploads.

## 🧪 Tests

```bash
cd api && npm ci && npm test             # Server- und HTTP-Tests (für http.test.js wird ein Redis gebraucht)
cd frontend && npm ci && npm run lint    # Oberfläche
tests/e2e/run.sh                         # die Oberfläche in Docker, mit einer Demo-Bibliothek
```

## 📜 Changelog

Was sich in jeder Version geändert hat — in [CHANGELOG.md](CHANGELOG.md).

## 📝 Wenn die Suche danebenliegt

Spiel öffnen, „Bearbeiten“ drücken und einen Link einfügen — eine itch.io-Seite, eine Steam-Shopseite oder
einen VNDB-Eintrag. Die Daten werden sofort neu gefunden.

## 📄 Lizenz

Copyright © 2026 Raven. Mimikin ist freie Software unter der
[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only): Du darfst sie nutzen, untersuchen,
ändern und weitergeben. Gibst du eine geänderte Version weiter oder betreibst du eine für andere über ein
Netzwerk, musst du ihren Quelltext unter derselben Lizenz veröffentlichen. Das Release 6.0 (Tag v6.0)
erschien für den eigenen Code unter MIT; das Cheat-Menü-Plugin von Dritten, das darin enthalten war,
wurde nie davon abgedeckt und ist entfernt.
Übernommene Komponenten und ihre Lizenzen — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
