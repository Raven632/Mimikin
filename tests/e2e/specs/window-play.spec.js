import { test, expect, openLibrary, openGame } from '../fixtures.js';

// Окно игры из карточки (windowFly.js) и «Играть» (LaunchIntro). Время кадров не меряем: проверяем, что полёт
// был, чем кончился и что «уменьшить движение» обходится без него. Вся остальная сьюта идёт с reduce (config)

// Видел ли страница обложку-призрак в полёте и слой перехода — их держит только само движение
const watch = (page) => page.addInitScript(() => {
  window.__seen = { ghost: false, intro: false };
  new MutationObserver(() => {
    if (document.querySelector('.modal-ghost.fly')) window.__seen.ghost = true;
    if (document.querySelector('.frame-intro')) window.__seen.intro = true;
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
});
const seen = (page) => page.evaluate(() => window.__seen);
const cardFor = (page, title) => page.locator('.library > .game-card').filter({ hasText: title }).first();

test.describe('окно игры из карточки', () => {
  test('обложка летит из карточки, потом всё на месте: ни призрака, ни transform, настоящая обложка видна', async ({ page }) => {
    await watch(page);
    await openLibrary(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await cardFor(page, 'Starfall Inn').locator('.card-title').click();
    await expect(page.locator('.modal-content')).toBeVisible();
    await expect.poll(async () => (await seen(page)).ghost).toBe(true);
    await expect(page.locator('.modal-ghost.fly')).toHaveCount(0);
    // Отложенное до посадки (скриншоты, landed) встаёт чуть позже призрака и запускает свои переходы — ждём и его
    await expect(page.locator('.modal-content .screen-thumb img').first()).toBeAttached();
    // После полёта ещё может доигрывать проявление настоящей обложки (80 мс) — ждём, пока анимаций не останется
    await expect.poll(() => page.evaluate(() => document.querySelector('.modal-content').getAnimations({ subtree: true }).length
      + document.querySelector('.modal-overlay').getAnimations().length)).toBe(0);
    const end = await page.evaluate(() => {
      const win = document.querySelector('.modal-content');
      const ov = document.querySelector('.modal-overlay');
      return {
        anims: win.getAnimations({ subtree: true }).length + ov.getAnimations().length,
        flying: win.dataset.flying ?? null,
        transform: getComputedStyle(win).transform,
        opacity: getComputedStyle(ov).opacity,
        blur: getComputedStyle(ov).backdropFilter,
      };
    });
    expect(end).toMatchObject({ anims: 0, flying: null, transform: 'none', opacity: '1', blur: 'none' });
    await expect(page.locator('#modal-cover')).toBeVisible();
    expect(await page.locator('#modal-cover').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
  });

  test('закрыли на полпути открытия: окно разворачивается и уходит, страница под ним снова доступна', async ({ page }) => {
    await openLibrary(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await cardFor(page, 'Starfall Inn').locator('.card-title').click();
    await expect(page.locator('.modal-content')).toBeAttached();
    // Подложка нажата, пока окно ещё растёт: раньше такое нажатие игнорировалось
    await page.locator('.modal-overlay').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelectorAll('.modal-ghost.fly').length)).toBe(0);
    // Карточка цела и снова открывается
    await openGame(page, 'Starfall Inn');
  });

  test('закрытие крестиком из открытого окна: окно уходит, переоткрыть можно', async ({ page }) => {
    await openLibrary(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openGame(page, 'Starfall Inn');
    await expect.poll(() => page.evaluate(() => document.querySelector('.modal-content').getAnimations({ subtree: true }).length)).toBe(0);
    await page.locator('.modal-close').click();
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
    await openGame(page, 'Starfall Inn');
  });

  test('анимацию закрытия отменили со стороны (узел окна пересоздан): окно всё равно закрывается', async ({ page }) => {
    await openLibrary(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openGame(page, 'Starfall Inn');
    await expect.poll(() => page.evaluate(() => document.querySelector('.modal-content').getAnimations({ subtree: true }).length)).toBe(0);
    // Нажали крестик и тут же отменили анимации прямых детей окна — как при их пересоздании React'ом
    await page.evaluate(() => {
      document.querySelector('.modal-close').click();
      document.querySelector('.modal-content').getAnimations({ subtree: true }).forEach((a) => a.cancel());
    });
    await expect(page.locator('.modal-overlay')).toHaveCount(0, { timeout: 2_000 });
  });

  test('«уменьшить движение»: окно сразу на месте, призрака не было, закрывается сразу', async ({ page }) => {
    await watch(page);
    await openLibrary(page);
    await cardFor(page, 'Starfall Inn').locator('.card-title').click();
    await expect(page.locator('.modal-content')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('.modal-content').getAnimations({ subtree: true }).length)).toBe(0);
    await page.locator('.modal-close').click();
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
    expect((await seen(page)).ghost).toBe(false);
  });

  test('открыли без карточки (полка «Недавно играли» с обложкой за краем не нужна): окно просто появляется', async ({ page }) => {
    await watch(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/?game=Starfall%20Inn');
    await page.waitForTimeout(300);
    expect((await seen(page)).ghost).toBe(false);
  });
});

// Датчик перерисовок окна: самодельный хук инструментов React (прод-React его вызывает на каждом коммите).
// Окно — компонент над .game-overlay; перерисовалось — у него новый список хуков (memoizedState).
// Полёт — пока у окна есть data-flying (windowFly.js)
const watchRenders = (page) => page.addInitScript(() => {
  const R = window.__renders = { flying: 0, after: 0 };
  let last = null;
  const find = (fiber) => {
    for (const stack = [fiber]; stack.length;) {
      const f = stack.pop();
      if (f.stateNode instanceof Element && f.stateNode.matches('.modal-overlay.game-overlay')) return f;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE() {},
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(id, root) {
      let modal = find(root.current)?.return;
      while (modal && typeof modal.type !== 'function') modal = modal.return;
      const state = modal?.memoizedState ?? null;
      // Первый коммит с окном — само открытие, его не считаем
      if (state && last && state !== last) {
        if (document.querySelector('.modal-content[data-flying]')) R.flying++; else R.after++;
      }
      last = state;
    },
  };
});

test.describe('окно игры в полёте', () => {
  test('в полёте окно не перерисовывается: ни ответы сервера, ни общие хранилища', async ({ page }) => {
    await watch(page);
    await watchRenders(page);
    // Ответы, которые окно ждёт при открытии, — с задержкой, чтобы пришли ровно посреди полёта (240 мс)
    let langs = 0;
    const late = async (route) => { await new Promise((r) => setTimeout(r, 60)); await route.continue(); };
    await page.route('**/api/settings/known-langs', (route) => { langs++; return late(route); });
    for (const url of ['**/api/settings/favorite-tags', '**/api/games/*/guides', '**/api/marks/*', '**/api/saves/**']) await page.route(url, late);
    await openLibrary(page);
    // Знакомые языки грузятся вместе с играми, до открытия окна
    await expect.poll(() => langs).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const before = langs;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await cardFor(page, 'Starfall Inn').locator('.card-title').click();
    await expect.poll(async () => (await seen(page)).ghost).toBe(true);
    await expect(page.locator('.modal-content[data-flying]')).toHaveCount(0);
    // После посадки ворота отдают отложенное — датчик обязан это увидеть, иначе он сломан (новый React)
    await expect.poll(() => page.evaluate(() => window.__renders.after)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__renders.flying)).toBe(0);
    expect(langs).toBe(before);
  });
});

test.describe('«Играть»: обложка становится экраном', () => {
  test('слой перехода появился, игра открылась, слой ушёл, обложка на месте; игра проявляется', async ({ page }) => {
    await watch(page);
    await openLibrary(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect.poll(async () => (await seen(page)).intro).toBe(true);
    await expect(page.frameLocator('.game-frame iframe').locator('#demo-game')).toContainText('Ember & Frost', { timeout: 15_000 });
    await expect(page.locator('.frame-intro')).toHaveCount(0);
    await expect(page.locator('.game-frame.intro.revealed')).toBeAttached();
    await expect.poll(() => page.locator('.game-frame iframe').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await page.locator('#modal-cover').evaluate((el) => el.style.visibility)).toBe('');
  });

  test('запуск не удался: слой убран сразу, обложка на месте, ошибка в уведомлении', async ({ page }) => {
    await watch(page);
    await page.route('**/api/play/*', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
    await openLibrary(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect.poll(async () => (await seen(page)).intro).toBe(true);
    await expect(page.locator('.frame-intro')).toHaveCount(0);
    await expect(page.locator('.game-frame')).toHaveCount(0);
    expect(await page.locator('#modal-cover').evaluate((el) => el.style.visibility)).toBe('');
    await expect(page.locator('#modal-play-btn')).toBeEnabled();
  });

  test('«уменьшить движение»: сразу чёрный экран, без роста обложки', async ({ page }) => {
    await page.route('**/api/play/*', async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue(); });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    const back = page.locator('.frame-intro-back');
    await expect(back).toBeVisible();
    expect(await back.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await page.locator('.frame-intro-cv').evaluate((el) => el.getAnimations().length)).toBe(0);
    await expect(page.frameLocator('.game-frame iframe').locator('#demo-game')).toContainText('Ember & Frost', { timeout: 15_000 });
    await expect(page.locator('.frame-intro')).toHaveCount(0);
  });

  test('сервер завис: через 3 с на чёрном мимик, Escape отменяет запуск без ошибки', async ({ page }) => {
    await page.route('**/api/play/*', () => {});
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.frame-intro-back')).toBeVisible();
    await expect(page.locator('.frame-intro .mimic-wait')).toHaveCount(0);
    // Фокус ушёл с кнопки «Играть» под слоем: Enter её второй раз не нажмёт
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('modal-play-btn');
    await expect(page.locator('.frame-intro .mimic-wait')).toBeAttached({ timeout: 6_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.frame-intro')).toHaveCount(0);
    await expect(page.locator('.game-frame')).toHaveCount(0);
    await expect(page.locator('.toast.show')).toHaveCount(0);
  });
});
