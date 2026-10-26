import { test, expect, openLibrary } from '../fixtures.js';

// Мимик в шапке (mimicMood.js, BrandMark live). Время ведут часы страницы (clock.pauseAt + runFor), пикселей и
// «примерно через секунду» нет: кадр читаем по атрибуту data-frame (а монету и обложку — по data-over) на заданных
// отметках времени от начала последовательности. Кадр = 80 мс, отметки берём в середине кадра. Вся остальная
// сьюта идёт с reduce (config), поэтому движение включается в тесте; «уменьшить движение» — свои тесты в конце

const mark = (page) => page.locator('header .brand-mark svg');
const frame = (page) => mark(page).getAttribute('data-frame');
const over = (page) => mark(page).getAttribute('data-over');
const eyes = (page) => mark(page).locator('.mood-eyes').getAttribute('d');
const mood = (page, call, arg) => page.evaluate(([c, a]) => window.__mimicMood[c](a), [call, arg]);
const landed = (page) => page.evaluate(() => window.dispatchEvent(new CustomEvent('rpg-landed', { detail: { id: null } })));

// Часы страницы: ставим до открытия, потом замораживаем — дальше время идёт только по runFor. По умолчанию — полдень
// по UTC: ночь (01–06 по часам устройства) иначе зависела бы от того, когда запустили тесты
test.use({ timezoneId: 'UTC' });
async function boot(page, { time = new Date('2026-10-03T12:00:00Z'), path = '/' } = {}) {
  await page.clock.install({ time });
  await page.goto(path);
  await expect(page.locator('.shelf-card').first()).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 100));
}

// [мс от начала, кадр, что поверх (null — ничего)] — идём по часам вперёд и сверяем
async function timeline(page, steps) {
  let t = 0;
  for (const [ms, f, o] of steps) {
    await page.clock.runFor(ms - t);
    t = ms;
    expect(await frame(page), `кадр на ${ms} мс`).toBe(f);
    if (o !== undefined) expect(await over(page), `поверх на ${ms} мс`).toBe(o);
  }
}

// Нажатие человека в пустом месте страницы (метка «последнего нажатия» для ошибки)
const press = async (page) => { await page.mouse.move(4, 500); await page.mouse.down(); await page.mouse.up(); };

const DONE = [[1, 'HALF', null], [90, 'SHUT', null], [170, 'HOP', null], [330, 'HALF', 'c0'], [410, 'HALF', 'c1'], [490, 'HALF', 'c2'], [570, 'OPEN', 'c3'], [650, 'OPEN', 'c4'], [740, 'OPEN', null]];

test.describe('мимик в шапке: движение включено', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('место знака 32 × 32, клетка — целое число точек, svg с запасом клеток не принимает мышь', async ({ page }) => {
    await boot(page);
    const geo = await page.evaluate(() => {
      const slot = document.querySelector('.brand-slot').getBoundingClientRect();
      const box = document.querySelector('.brand-mark.m16').getBoundingClientRect();
      const svg = document.querySelector('.brand-mark.m16 svg');
      const r = svg.getBoundingClientRect();
      return { slot: [slot.width, slot.height], box: box.width, svg: r.width, pe: getComputedStyle(svg).pointerEvents, dpr: devicePixelRatio, vb: svg.getAttribute('viewBox') };
    });
    expect(geo.slot).toEqual([32, 32]);
    expect(geo.box).toBeLessThanOrEqual(32);
    expect(geo.vb).toBe('-2 -4 24 22');
    expect(geo.pe).toBe('none');
    const cell = (geo.svg * geo.dpr) / 24;
    expect(Math.abs(cell - Math.round(cell))).toBeLessThan(1e-3);
  });

  test('покой: открыт, глаза видны; спустя 20–40 с моргает или глядит и возвращается', async ({ page }) => {
    await boot(page);
    expect(await frame(page)).toBe('OPEN');
    expect((await eyes(page)).length).toBeGreaterThan(0);
    await page.clock.runFor(19_000);
    expect(await frame(page)).toBe('OPEN');
    // Первое движение случается между 20 и 40 с; ловим его шагами по 80 мс
    let seen = null;
    for (let t = 0; t < 21_500 && !seen; t += 80) {
      await page.clock.runFor(80);
      const f = await frame(page);
      if (f !== 'OPEN') seen = f;
    }
    expect(['B:OPEN', 'L', 'R']).toContain(seen);
    await page.clock.runFor(1500);
    expect(await frame(page)).toBe('OPEN');
  });

  test('наведение: мышь на знаке 160 мс — крышка вверх и глаза к стороне курсора; ушла — назад', async ({ page }) => {
    await boot(page);
    const word = await page.locator('.brand-title').boundingBox();
    const slot = await page.locator('.brand-slot').boundingBox();
    await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2);
    await page.clock.runFor(100);
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(100);
    expect(await frame(page)).toBe('WR');
    await page.mouse.move(slot.x + 2, slot.y + 16);
    await page.clock.runFor(100);
    expect(await frame(page)).toBe('WR');
    await page.clock.runFor(100);
    expect(await frame(page)).toBe('WL');
    await page.mouse.move(slot.x + 16, slot.y + 16);
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('W');
    await page.mouse.move(700, 500);
    await page.clock.runFor(100);
    expect(await frame(page)).toBe('W');
    await page.clock.runFor(100);
    expect(await frame(page)).toBe('OPEN');
  });

  test('глаза за курсором над шапкой: влево и вправо от знака; проход быстрее 160 мс кадр не меняет; печать — не следит', async ({ page }) => {
    await boot(page);
    const nav = await page.locator('.main-nav').boundingBox();
    await page.mouse.move(nav.x + nav.width / 2, nav.y + nav.height / 2);
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('R');
    // Ушёл из шапки — глаза обратно
    await page.mouse.move(700, 500);
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('OPEN');
    // Прошёл через шапку и вышел за 100 мс — кадр не менялся
    await page.mouse.move(nav.x + nav.width / 2, nav.y + 4);
    await page.clock.runFor(60);
    await page.mouse.move(700, 500);
    await page.clock.runFor(300);
    expect(await frame(page)).toBe('OPEN');
    // 3 с после клавиши глаза не следят
    await page.keyboard.press('a');
    await page.mouse.move(nav.x + nav.width / 2, nav.y + nav.height / 2);
    await page.clock.runFor(400);
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(3000);
    await page.mouse.move(nav.x + nav.width / 2 + 3, nav.y + nav.height / 2);
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('R');
  });

  test('фокус с клавиатуры — крышка вверх сразу, без задержки; снял фокус — вниз', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('Shift');
    await page.locator('.brand').focus();
    expect(await frame(page)).toBe('W');
    await page.locator('.brand').blur();
    expect(await frame(page)).toBe('OPEN');
  });

  test('жуёт, пока идёт работа в фоне: HALF, открыт, HALF; пауза 3,2 с; кончилась — стоит; свой мимик на экране — молчит', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__mimicMood.work('lookup', true));
    await timeline(page, [[1, 'HALF'], [200, 'OPEN'], [361, 'HALF'], [561, 'OPEN'], [3100, 'OPEN'], [3300, 'HALF']]);
    await page.evaluate(() => window.__mimicMood.work('lookup', false));
    await page.clock.runFor(1000);
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(20_000);
    await page.evaluate(() => { window.__mimicMood.other(1); window.__mimicMood.work('queue', true); });
    await page.clock.runFor(15_000);
    expect(await frame(page)).toBe('OPEN');
    await page.evaluate(() => window.__mimicMood.other(-1));
    await page.clock.runFor(1);
    expect(await frame(page)).toBe('HALF');
  });

  test('не жуёт, пока печатают; жуёт через 3 с после последней клавиши', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('a');
    await page.evaluate(() => window.__mimicMood.work('lookup', true));
    await page.clock.runFor(2900);
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('HALF');
  });

  test('«готово»: прикрыл, захлопнул, подскочил, монета из щели; второе в течение минуты — без движения', async ({ page }) => {
    await boot(page);
    await landed(page);
    await timeline(page, DONE);
    await page.clock.runFor(1000);
    await landed(page);
    await page.clock.runFor(1500);
    expect(await frame(page)).toBe('OPEN');
    expect(await over(page)).toBeNull();
    await page.clock.runFor(60_000);
    await landed(page);
    await timeline(page, DONE);
  });

  test('«готово» поверх наведения: кончается на W; пока печатают — после паузы, но не позже 10 с', async ({ page }) => {
    await boot(page);
    const slot = await page.locator('.brand-slot').boundingBox();
    await page.mouse.move(slot.x + 16, slot.y + 16);
    await page.clock.runFor(2200);
    expect(await frame(page)).toBe('W');
    await landed(page);
    await page.clock.runFor(1);
    expect(await frame(page)).toBe('HALF');
    await page.clock.runFor(600);
    expect(await frame(page)).toBe('W');
    expect(await over(page)).toBe('c3');
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('W');
    expect(await over(page)).toBeNull();
    // Печатают: ждёт паузы
    await page.clock.runFor(61_000);
    await page.mouse.move(700, 500);
    await page.clock.runFor(2500);
    await page.keyboard.press('a');
    await landed(page);
    await page.clock.runFor(2900);
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(120);
    expect(await frame(page)).toBe('HALF');
  });

  test('«готово», пришедшее во время долгой печати, пропадает: ждёт дольше 10 с', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('a');
    await landed(page);
    await page.clock.runFor(9000);
    await page.keyboard.press('a');
    await page.clock.runFor(5000);
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(3000);
    expect(await frame(page)).toBe('OPEN');
    expect(await over(page)).toBeNull();
  });

  test('вкладка в фоне: «готово» не показывается', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await landed(page);
    await page.clock.runFor(1000);
    expect(await frame(page)).toBe('OPEN');
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await landed(page);
    await page.clock.runFor(1);
    expect(await frame(page)).toBe('HALF');
  });

  test('ошибка: крышка дрогнула влево-вправо, только на тост в течение 2 с после нажатия и не чаще раза в 10 с', async ({ page }) => {
    await boot(page);
    // Нажатия не было — без дрожи
    expect(await mood(page, 'error')).toBe('bg');
    await press(page);
    expect(await mood(page, 'error')).toBe('now');
    await timeline(page, [[1, 'K-:OPEN'], [90, 'K+:OPEN'], [170, 'OPEN']]);
    await page.clock.runFor(1000);
    await press(page);
    expect(await mood(page, 'error')).toBe('often');
    expect(await frame(page)).toBe('OPEN');
    await page.clock.runFor(10_000);
    // Нажатие давно было — дрожи нет, ошибка не «привязана» ни к чему
    expect(await mood(page, 'error')).toBe('bg');
    await press(page);
    await page.keyboard.press('a');
    expect(await mood(page, 'error')).toBe('typing');
    await page.clock.runFor(3500);
    await press(page);
    expect(await mood(page, 'error')).toBe('now');
  });

  test('ошибка через тост приложения: неверный файл после нажатия — дрожь', async ({ page }) => {
    await boot(page);
    await press(page);
    // Бросили файл не того вида (setInputFiles дал бы событие input, а это «печать»)
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'notes.txt'));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.toast.error.show')).toBeVisible();
    expect(await frame(page)).toBe('K-:OPEN');
    await page.clock.runFor(170);
    expect(await frame(page)).toBe('OPEN');
  });

  test('ошибка поверх наведения строится от W; не дрожит, пока на экране чужой мимик', async ({ page }) => {
    await boot(page);
    const slot = await page.locator('.brand-slot').boundingBox();
    await page.mouse.move(slot.x + 16, slot.y + 16);
    await page.clock.runFor(200);
    await page.mouse.down();
    await page.mouse.up();
    expect(await mood(page, 'error')).toBe('now');
    await timeline(page, [[1, 'K-:W'], [90, 'K+:W'], [170, 'W']]);
    await page.evaluate(() => window.__mimicMood.other(1));
    await page.clock.runFor(11_000);
    await page.mouse.down();
    await page.mouse.up();
    expect(await mood(page, 'error')).toBe('other');
  });

  test('обложки скрыты (H): глаза закрыты сразу, наведение крышку не поднимает, покой не тикает; ещё раз H — глаза вернулись', async ({ page }) => {
    await boot(page);
    expect((await eyes(page)).length).toBeGreaterThan(0);
    // H сразу после буквы — тоже сразу (это ответ на нажатие)
    await page.keyboard.press('a');
    await page.keyboard.press('h');
    expect(await frame(page)).toBe('OPEN');
    expect(await eyes(page)).toBe('');
    const slot = await page.locator('.brand-slot').boundingBox();
    await page.mouse.move(slot.x + 16, slot.y + 16);
    await page.clock.runFor(400);
    expect(await frame(page)).toBe('OPEN');
    await page.mouse.move(700, 500);
    // Покой молчит: за две минуты кадр ни разу не другой (шаги по 100 мс не ловят всё, но моргание — 160 мс)
    for (let t = 0; t < 120_000; t += 1000) {
      await page.clock.runFor(1000);
      if (t % 20_000 === 0) expect(await frame(page)).toBe('OPEN');
    }
    // «Готово» идёт без глаз
    await landed(page);
    await page.clock.runFor(1);
    expect(await frame(page)).toBe('HALF');
    expect(await eyes(page)).toBe('');
    await page.clock.runFor(1000);
    await page.keyboard.press('h');
    expect((await eyes(page)).length).toBeGreaterThan(0);
  });

  test('кнопка-глаз на панели закрывает глаза так же', async ({ page }) => {
    await boot(page);
    await page.locator('.cover-toggle').click();
    expect(await eyes(page)).toBe('');
    await page.locator('.cover-toggle').click();
    expect((await eyes(page)).length).toBeGreaterThan(0);
  });

  test('пять щелчков за 2 с: первый ведёт на главную, пятый — обложка изо рта и окно «Во что поиграть?»', async ({ page }) => {
    await boot(page);
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await page.locator('.brand').click();
    await expect(page.locator('.nav-tab.active')).toContainText('Главная');
    for (let i = 0; i < 3; i += 1) await page.locator('.brand').click();
    expect(await frame(page)).toBe('OPEN');
    await page.locator('.brand').click();
    await timeline(page, [[1, 'W', null], [170, 'W', 'p0'], [250, 'W', 'p1'], [330, 'WR', 'p2'], [410, 'WR', 'p3']]);
    await expect(page.locator('.picker-content')).toHaveCount(0);
    await page.clock.runFor(100);
    // Окно рисует React вне часов: отпускаем их
    await page.clock.resume();
    await expect(page.locator('.picker-content')).toBeVisible();
    await expect(page.locator('.picker-content h3')).not.toHaveText('');
  });

  test('щелчки медленнее (5 за 2,4 с) секрета не дают', async ({ page }) => {
    await boot(page);
    for (let i = 0; i < 5; i += 1) {
      await page.locator('.brand').click();
      await page.clock.runFor(600);
    }
    await page.clock.runFor(1000);
    await expect(page.locator('.picker-content')).toHaveCount(0);
  });

  test('«Играть» на карточке: нажато — W; отпущено — глоток SHUT, HALF; увёл курсор с нажатой — W опустилась', async ({ page }) => {
    await boot(page);
    const play = page.locator('.shelf-card .card-play').first();
    await page.locator('.shelf-card').first().hover();
    await play.hover();
    await page.mouse.down();
    expect(await frame(page)).toBe('W');
    await page.mouse.move(700, 120);
    expect(await frame(page)).toBe('OPEN');
    await page.mouse.up();
    await page.clock.runFor(3000);
    await page.locator('.shelf-card').first().hover();
    await play.hover();
    await page.mouse.down();
    expect(await frame(page)).toBe('W');
    await page.mouse.up();
    await timeline(page, [[1, 'SHUT'], [90, 'HALF'], [170, 'OPEN']]);
  });

  test('click, который глушат карточки (stopPropagation), всё равно опускает W, если переход не начался', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      document.body.addEventListener('click', (e) => e.stopPropagation());
      window.__mimicMood.arm(false);
    });
    expect(await frame(page)).toBe('W');
    await page.evaluate(() => document.body.click());
    await page.clock.runFor(50);
    expect(await frame(page)).toBe('OPEN');
  });
});

test.describe('мимик в шапке: ночь', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('01–06: крышка опущена, глаза под ней; наведение поднимает; курсор — DL/DR; «готово» и ошибка от D; до 06:00 ночь, после — день', async ({ page }) => {
    await boot(page, { time: new Date('2026-10-03T05:59:00Z') });
    expect(await frame(page)).toBe('D');
    const nav = await page.locator('.main-nav').boundingBox();
    await page.mouse.move(nav.x + nav.width / 2, nav.y + nav.height / 2);
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('DR');
    const slot = await page.locator('.brand-slot').boundingBox();
    await page.mouse.move(slot.x + 16, slot.y + 16);
    await page.clock.runFor(200);
    expect(await frame(page)).toBe('W');
    await page.mouse.move(700, 500);
    await page.clock.runFor(2300);
    await landed(page);
    await timeline(page, [[1, 'HALF'], [90, 'SHUT'], [170, 'HOP'], [570, 'D', 'c3'], [650, 'D', 'c4'], [740, 'D', null]]);
    await page.mouse.down();
    await page.mouse.up();
    expect(await mood(page, 'error')).toBe('now');
    await timeline(page, [[1, 'K-:D'], [90, 'K+:D'], [170, 'D']]);
    // 06:00:01 — день
    await page.clock.runFor(70_000);
    expect(await frame(page)).toBe('OPEN');
  });

  test('ночью покой — только медленное моргание глаз под крышкой (320 мс), раз в 40–80 с', async ({ page }) => {
    await boot(page, { time: new Date('2026-10-03T02:30:00Z') });
    expect(await frame(page)).toBe('D');
    await page.clock.runFor(39_000);
    expect(await frame(page)).toBe('D');
    let seen = null;
    for (let t = 0; t < 42_000 && !seen; t += 80) {
      await page.clock.runFor(80);
      const f = await frame(page);
      if (f !== 'D') seen = f;
    }
    expect(seen).toBe('B:D');
    await page.clock.runFor(400);
    expect(await frame(page)).toBe('D');
  });
});

test.describe('мимик на входе', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('спит, пока не начали печатать; первая буква — поднял крышку, открыл глаза, моргнул', async ({ context }) => {
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-10-03T12:00:00Z') });
    await page.goto('/');
    const brand = page.locator('.auth-brand svg');
    await expect(brand).toBeVisible();
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(new Date(now + 100));
    expect(await brand.getAttribute('data-frame')).toBe('SLEEP');
    await page.clock.runFor(60_000);
    expect(await brand.getAttribute('data-frame')).toBe('SLEEP');
    await page.locator('input[name=username]').pressSequentially('d');
    let t = 0;
    for (const [ms, f] of [[1, 'B:OPEN'], [90, 'OPEN'], [410, 'B:OPEN'], [570, 'OPEN']]) {
      await page.clock.runFor(ms - t);
      t = ms;
      expect(await brand.getAttribute('data-frame'), `${ms} мс`).toBe(f);
    }
  });
});

test.describe('мимик: «уменьшить движение»', () => {
  test('всегда открытый и без таймеров: наведение, «готово», работа, ошибка кадр не меняют; H закрывает глаза сразу', async ({ page }) => {
    await boot(page);
    expect(await frame(page)).toBe('OPEN');
    const slot = await page.locator('.brand-slot').boundingBox();
    await page.mouse.move(slot.x + 16, slot.y + 16);
    await page.clock.runFor(400);
    expect(await frame(page)).toBe('OPEN');
    await landed(page);
    await page.evaluate(() => window.__mimicMood.work('lookup', true));
    await page.mouse.down();
    await page.mouse.up();
    expect(await mood(page, 'error')).toBe('still');
    await page.clock.runFor(60_000);
    expect(await frame(page)).toBe('OPEN');
    expect(await over(page)).toBeNull();
    expect((await eyes(page)).length).toBeGreaterThan(0);
    await page.keyboard.press('h');
    expect(await frame(page)).toBe('OPEN');
    expect(await eyes(page)).toBe('');
  });

  test('пять щелчков — сразу окно, без обложки', async ({ page }) => {
    await boot(page);
    for (let i = 0; i < 5; i += 1) await page.locator('.brand').click();
    await page.clock.resume();
    await expect(page.locator('.picker-content')).toBeVisible();
    expect(await frame(page)).toBe('OPEN');
    expect(await over(page)).toBeNull();
  });

  test('на входе не спит', async ({ context }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.auth-brand svg')).toBeVisible();
    expect(await page.locator('.auth-brand svg').getAttribute('data-frame')).toBe('OPEN');
  });

  test('включили на лету: идущее жевание сразу встаёт открытым', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await boot(page);
    await page.evaluate(() => window.__mimicMood.work('lookup', true));
    await page.clock.runFor(1);
    expect(await frame(page)).toBe('HALF');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => frame(page)).toBe('OPEN');
    await page.clock.runFor(30_000);
    expect(await frame(page)).toBe('OPEN');
  });
});

// Библиотека открыта в другом виде: знак тот же
test('знак в шапке на вкладке «Библиотека» тот же, живой', async ({ page }) => {
  await openLibrary(page);
  await expect(mark(page)).toHaveAttribute('data-frame', 'OPEN');
});
