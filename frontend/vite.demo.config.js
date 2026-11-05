import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Сборка демо для GitHub Pages: тот же интерфейс, а ответы «сервера» даёт сама страница (frontend/demo/).
// Обычная сборка (vite.config.js) об этом файле не знает и не содержит ни байта демо.
const here = path.dirname(fileURLToPath(import.meta.url))
// Записанные ответы и файлы (tests/demo/record.js кладёт их сюда). DEMO_DATA — другая папка, для проверок
const dataDir = process.env.DEMO_DATA || path.join(here, 'demo-data')

const demoPage = () => ({
  name: 'mimikin-demo-page',
  // Вход подменяем в index.html на лету, а не держим вторую копию страницы: правки шапки не разойдутся.
  // order 'pre' — чтобы Vite собрал уже подставленный вход
  transformIndexHtml: {
    order: 'pre',
    handler: (html) => html
      // установленное «приложение демо» только путало бы; manifest.json ведёт на start_url "/"
      .replace(/\s*<link rel="manifest"[^>]*>/, '')
      .replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n    <meta name="robots" content="noindex">')
      .replace('<title>Mimikin</title>', '<title>Mimikin demo</title>')
      .replace('/src/main.jsx', '/demo/entry.js'),
  },
  buildStart() {
    // Без записи демо пустое: лучше остановить сборку, чем выложить страницу, где ничего нет
    if (!fs.existsSync(path.join(dataDir, 'boot.json'))) {
      this.error(`Нет ${path.join(dataDir, 'boot.json')}: сначала запись (tests/demo/record.js)`)
    }
  },
  // Записанное лежит рядом со страницей: boot.json, d/ (ответы), m/ (картинки, звуки), play/ (страницы игр)
  writeBundle(options) {
    fs.cpSync(dataDir, options.dir, { recursive: true })
  },
})

export default defineConfig({
  // Относительный путь: демо работает под любым адресом (переименование репозитория, свой домен, подпапка)
  base: './',
  plugins: [react(), demoPage()],
  define: { 'import.meta.env.VITE_DEMO': '"1"' },
  resolve: {
    // Сервера нет — сокет подменён пустышкой, иначе страница стучалась бы в /socket.io/ и сыпала ошибками
    alias: [{ find: /^socket\.io-client$/, replacement: path.join(here, 'demo/fakeSocket.js') }],
  },
  build: { outDir: 'dist-demo', emptyOutDir: true },
})
