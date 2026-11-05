import { defineConfig, devices } from '@playwright/test';

// Обход собранного демо (frontend/dist-demo): раздаёт его serve.mjs под /Mimikin/demo/, как GitHub Pages.
// Проекты: настольный экран 1440 и телефон 390, оба в Chromium и в WebKit (Safari). В WebKit тот же обход: звук там
// не проверяется (Ogg в старом Safari молчит и в самом продукте). Без WebKit на машине — DEMO_NO_WEBKIT=1
const PORT = process.env.DEMO_PORT || '4173';
const URL = `http://127.0.0.1:${PORT}/Mimikin/demo/`;
const webkit = !process.env.DEMO_NO_WEBKIT;

export default defineConfig({
  testDir: '.',
  testMatch: /tour\.spec\.mjs$/,
  outputDir: './report/results',
  timeout: 60_000,
  expect: { timeout: 7_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: './report/html', open: 'never' }]],
  webServer: {
    command: 'node serve.mjs',
    cwd: import.meta.dirname,
    url: URL,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
    env: { DEMO_PORT: PORT, ...(process.env.DEMO_DIST ? { DEMO_DIST: process.env.DEMO_DIST } : {}) },
  },
  use: {
    baseURL: URL,
    locale: 'en-GB',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    ...(webkit ? [
      { name: 'desktop-webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
      { name: 'phone-webkit', use: { ...devices['iPhone 13'] } },
    ] : []),
  ],
});
