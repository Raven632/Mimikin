import { test, expect } from '@playwright/test';
import { USER } from '../fixtures.js';

// Первые минуты нового человека: язык берётся из браузера, переключатель виден без прокрутки, сокет ждёт входа.
// Тест без входа, поэтому test — обычный, а не из fixtures.js. Учётная запись уже есть (проект first-run):
// страницу первого запуска показываем, подменив ответ сервера
const firstRun = (page) => page.route('**/api/setup/status', (route) => route.fulfill({ json: { initialized: false } }));

async function openFirstRun(page, title) {
  await firstRun(page);
  await page.goto('/');
  await expect(page.locator('#auth-title')).toHaveText(title);
}

// Переключатель и знак проекта видны сразу: прежде один был ниже края экрана, а второй — выше, где его не достать
async function expectTopInView(page) {
  await expect(page.locator('.auth-langs')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.auth-brand')).toBeInViewport({ ratio: 1 });
}

for (const [locale, code, title] of [
  ['en-US', 'en', 'First launch'],
  ['de-DE', 'de', 'Erster Start'],
]) {
  test.describe(`браузер на ${locale}`, () => {
    test.use({ locale });

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      test(`первый запуск ${viewport.width}x${viewport.height}: на языке браузера, переключатель виден, русского нет`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openFirstRun(page, title);
        await expectTopInView(page);
        await expect(page.locator('.auth-lang.active')).toHaveText(code.toUpperCase());
        await expect(page.locator('html')).toHaveAttribute('lang', code);
        // Меток языков на первом экране нет: знакомым считается язык страницы, остальные — в «Настройках»
        await expect(page.locator('.known-langs')).toHaveCount(0);
        expect(await page.locator('body').innerText()).not.toMatch(/[А-Яа-яЁё]/);
        // Вся страница досягаема: кнопка отправки — прокруткой, и обратно наверх
        await page.locator('.auth-submit').scrollIntoViewIfNeeded();
        await expect(page.locator('.auth-submit')).toBeInViewport();
        await page.locator('.auth-page').evaluate((el) => { el.scrollTop = 0; });
        await expectTopInView(page);
      });
    }
  });
}

test.describe('браузер на языке, которого у нас нет', () => {
  test.use({ locale: 'fr-FR' });

  test('первый запуск — по-английски', async ({ page }) => {
    await openFirstRun(page, 'First launch');
  });
});

test.describe('браузер на en-US, язык уже выбран', () => {
  test.use({ locale: 'en-US' });

  test('сохранённый выбор важнее браузера, смена языка меняет и страницу', async ({ page }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('kept')) { sessionStorage.setItem('kept', '1'); localStorage.setItem('rpg_lang', 'de'); } });
    await openFirstRun(page, 'Erster Start');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await page.locator('.auth-lang', { hasText: 'RU' }).click();
    await expect(page.locator('#auth-title')).toHaveText('Первый запуск');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.reload();
    await expect(page.locator('#auth-title')).toHaveText('Первый запуск');
  });
});

test('страница входа не стучится в сокет; после входа он подключается без перезагрузки', async ({ page }) => {
  const sockets = [];
  const polls = [];
  page.on('request', (req) => {
    if (req.url().includes('/socket.io')) sockets.push(req.url());
    if (req.url().includes('/api/downloads')) polls.push(req.url());
  });
  await page.goto('/');
  await expect(page.locator('#auth-title')).toHaveText('Вход в библиотеку');
  await expectTopInView(page);
  // Сокет без autoConnect: подключись он сам, запрос ушёл бы сразу при загрузке
  await page.waitForTimeout(1500);
  expect(sockets).toEqual([]);
  // Опрос загрузок — тоже после входа: без него сервер отвечает 401, красная строка в консоли
  expect(polls).toEqual([]);

  await page.locator('input[name=username]').fill(USER.username);
  await page.locator('input[name=password]').fill(USER.password);
  const connected = page.waitForResponse((res) => res.url().includes('/socket.io') && res.ok());
  await page.locator('.auth-submit').click();
  await connected;
  await expect(page.locator('.shelf-card').first()).toBeVisible();
});
