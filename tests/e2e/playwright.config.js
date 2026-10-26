import { defineConfig, devices } from '@playwright/test';

// Тесты идут по одному: у них один сервер и одна демо-библиотека, а многие меняют её (оценки, корзина,
// пароль). Сначала проект first-run заводит учётную запись через страницу первого запуска,
// потом остальные тесты входят ею (fixtures.js)
export default defineConfig({
  testDir: './specs',
  outputDir: './report/results',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: './report/html', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_URL || 'http://mimikin:3000',
    locale: 'ru-RU',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Анимации окон по 200 мс — тесты не ждут, пока они доиграют
    reducedMotion: 'reduce',
  },
  projects: process.env.VISUAL
    // VISUAL=1 — только снимки экранов (specs/visual.js): эталон до переделки стилей и сравнение после.
    //   VISUAL=1 tests/e2e/run.sh --update-snapshots   — снять эталон
    //   VISUAL=1 tests/e2e/run.sh                      — сравнить с ним
    // В CI их нет: эталон зависит от шрифтов и браузера той машины, где его сняли
    ? [
      { name: 'first-run', testMatch: /first-run\.setup\.js/ },
      { name: 'visual', testMatch: /visual\.js$/, dependencies: ['first-run'] },
    ]
    : [
      { name: 'first-run', testMatch: /first-run\.setup\.js/ },
      { name: 'desktop', testIgnore: /first-run|\.phone\.spec\.js/, dependencies: ['first-run'] },
      { name: 'phone', testMatch: /\.phone\.spec\.js/, dependencies: ['first-run'], use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    ],
  snapshotPathTemplate: '{testDir}/../report/visual-baseline/{arg}{ext}',
});
