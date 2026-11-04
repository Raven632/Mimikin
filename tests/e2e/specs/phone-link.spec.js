import { test, expect, menu } from '../fixtures.js';

// Окно «Открыть на телефоне» (PhoneLink.jsx). Код не расшифровываем: проверяем, что он нарисован и что адрес,
// который он несёт, виден текстом рядом
const TITLE = 'Открыть на телефоне';
const dialog = (page) => page.getByRole('dialog', { name: TITLE });

test('обычный адрес: код нарисован, под ним адрес и честные подсказки', async ({ page }) => {
  await page.goto('/');
  await menu(page, TITLE);
  const win = dialog(page);
  await expect(win.locator('.phone-link-code path')).toHaveAttribute('d', /^M/);
  const box = await win.locator('.phone-link-code').boundingBox();
  expect(box.width).toBeGreaterThan(150);
  await expect(win.locator('.phone-link-address')).toHaveText(`${new URL(page.url()).origin}/`);
  await expect(win).toContainText('На экран „Домой“');
  await expect(win).toContainText('Добавить на главный экран');
  // Адрес тестов — http: «без панелей» Android здесь не обещаем
  await expect(win).toContainText('только ярлык');
  await expect(win.locator('.phone-link-local')).toHaveCount(0);
});

test('большой экран: код растёт с --zoom, окно целиком на экране', async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.goto('/');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim())).toBe('2');
  await menu(page, TITLE);
  const code = await dialog(page).locator('.phone-link-code').boundingBox();
  const win = await dialog(page).boundingBox();
  expect(code.width).toBeGreaterThan(400);
  expect(win.y).toBeGreaterThanOrEqual(0);
  expect(win.y + win.height).toBeLessThanOrEqual(2160);
  expect(await dialog(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
});

for (const host of ['localhost', '127.0.0.1']) {
  test(`адрес ${host}: кода нет, объяснено, как открыть по адресу в сети`, async ({ page, context, baseURL }) => {
    // Сервер тестов в другом контейнере: страницу с адреса host отдаём его ответами, а вход переносим на этот адрес
    const real = new URL(baseURL);
    const local = `http://${host}:${real.port}`;
    const cookies = await context.cookies(baseURL);
    await context.addCookies(cookies.map((c) => ({ ...c, domain: host })));
    await page.route(`${local}/**`, async (route) => {
      await route.fulfill({ response: await route.fetch({ url: route.request().url().replace(local, real.origin) }) });
    });
    await page.goto(`${local}/`);
    await menu(page, TITLE);
    const win = dialog(page);
    await expect(win.locator('.phone-link-local')).toContainText(`http://192.168.1.20:${real.port}`);
    await expect(win.locator('.phone-link-code')).toHaveCount(0);
    await expect(win.locator('.phone-link-address')).toHaveCount(0);
    // Опрос socket.io висит на подмене до конца теста: без этого он падает, когда тест уже прошёл
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
}
