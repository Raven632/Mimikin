// Скриншоты для README — из демо-библиотеки (api/scripts/demo-library.js), игры и обложки выдуманные.
//   VISUAL=1 tests/e2e/run.sh -g README   →   tests/e2e/report/readme/*.png, оттуда — в rest/img
// Английский интерфейс — для README.md и README.de.md, русский (*.ru.png) — для README.ru.md.
// Ничего не сравнивают: только снимают
import { test, expect, imagesLoaded, openHome, DEMO_NOW } from '../fixtures.js';

const OUT = '/runner/e2e/report/readme';
// Картинки — раскодированные начисто: уменьшенную обложку браузер сначала рисует грубо
const settle = async (page) => {
  await imagesLoaded(page);
  await page.waitForTimeout(600);
  await page.evaluate(() => Promise.race([
    Promise.all([...document.images].filter((img) => img.complete && img.naturalWidth).map((img) => img.decode().catch(() => {}))),
    new Promise((done) => setTimeout(done, 2000)),
  ]));
  await page.waitForTimeout(150);
};

for (const lang of ['en', 'ru']) {
  const suffix = lang === 'en' ? '' : `.${lang}`;
  test.describe(`README ${lang}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem('rpg_lang', l), lang);
      await page.route('**/api/storage**', (route) => route.fulfill({ json: { used: 10307921510, free: 412316860416 } }));
      await page.clock.setFixedTime(DEMO_NOW);
    });

    test(`главная и окно игры ${lang}`, async ({ page }) => {
      await openHome(page); await settle(page);
      await page.screenshot({ path: `${OUT}/library${suffix}.png` });
      await page.locator('.nav-tab').nth(1).click();
      await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).first().click();
      await expect(page.locator('.modal-content')).toBeVisible(); await settle(page);
      await page.screenshot({ path: `${OUT}/game${suffix}.png` });
    });

    test.describe('телефон', () => {
      test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      test(`главная на телефоне ${lang}`, async ({ page }) => {
        await openHome(page); await settle(page);
        await page.screenshot({ path: `${OUT}/phone${suffix}.png` });
      });
    });
  });
}
