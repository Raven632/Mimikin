import { expect, openLibrary, openGame } from './fixtures.js';

// Общее для тестов плеера сцены (SceneView): оглавление галереи Starfall_Inn с альбомами со сценарием, ответы сцены и
// картинки подставляем — в демо-играх сценариев нет. Шаги ответа — как отдаёт сервер (services/gallery.js, scene).
// Крошечный WebM (16×16, VP9 с прозрачностью, 0,1 с): ролики подставляем им; все остальные — 404
const WEBM = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJGEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEiTbuMU6uEHFO7a1OsggIw7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNTkuMjcuMTAwV0GNTGF2ZjU5LjI3LjEwMESJiEBUAAAAAAAAFlSua8WuAQAAAAAAADzXgQFzxYhSa89XcCNYSJyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDgjbCBELqBEJqBAlPAgQESVMNnQIFzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjU5LjI3LjEwMHNz22PAi2PFiFJrz1dwI1hIZ8ilRaOHRU5DT0RFUkSHmExhdmM1OS4zNy4xMDAgbGlidnB4LXZwOWfIokWjiERVUkFUSU9ORIeUMDA6MDA6MDAuMDgwMDAwMDAwAAAfQ7Z1QIHngQCgyaGggQAAAIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///1IjAB1oaSmou6BAaWdgkmDQgAA8AD2ADgkHBhKAAAwYAAAEL///aXMAACgsaGTgQAoAIYAQJKcAFAAAAMgAABCQHWhlqaU7oEBpY+GAECSnABQAAADIAAAQkD7gdgcU7trkbuPs4EAt4r3gQHxggGp8IED', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// albums — ключи альбомов или { key, scenes, album } (сцены-гости: [{ t, f }]; album — остальные поля альбома: kind, files, sum, script…); scene(url) → тело ответа /scene (объект) или { status } для ошибки; delay(f) → мс,
// сколько ждать с картинкой f; video(f) → отдавать ли ролик f (иначе 404); cast — ответ /cast («Кто в сцене», по умолчанию {} —
// ряда нет). Возвращает { urls }: адреса запросов сцены по порядку
export async function mockScene(page, { albums = ['events/00001/Night scene'], scene, delay = () => 0, video = () => false, cast = {} } = {}) {
  const urls = [];
  await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
    state: 'ready', v: 28, screen: { w: 816, h: 624 }, counts: { cg: albums.length },
    albums: albums.map((a) => ({ key: a.key || a, kind: 'cg', w: 816, h: 624, files: ['pic0.png', 'pic1.png'], cover: 'pic0.png', script: true, ...(a.scenes ? { scenes: a.scenes } : {}), ...(a.album || {}) })),
  } }));
  await page.route(/\/api\/gallery\/Starfall_Inn\/scene\?/, (route) => {
    const url = new URL(route.request().url());
    urls.push(url);
    const body = scene(url);
    return body.status ? route.fulfill({ status: body.status, body: '' }) : route.fulfill({ json: body });
  });
  await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image)\?/, async (route) => {
    const f = new URL(route.request().url()).searchParams.get('f');
    const ms = delay(f);
    if (ms) await new Promise((done) => setTimeout(done, ms));
    return route.fulfill({ body: PNG, contentType: 'image/png' });
  });
  await page.route(/\/api\/gallery\/Starfall_Inn\/cast$/, (route) => route.fulfill({ json: cast }));
  await page.route(/\/api\/gallery\/Starfall_Inn\/audio\?/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.route(/\/api\/gallery\/Starfall_Inn\/video\?/, (route) => (video(new URL(route.request().url()).searchParams.get('f')) ? route.fulfill({ body: WEBM, contentType: 'video/webm' }) : route.fulfill({ status: 404, body: '' })));
  return { urls };
}

// Звуки плеера: каждый new Audio запоминаем, play/pause только отмечают «играет» (в тестах звук 404 и не играл бы).
// audios(page) → [{ f, on }] по порядку создания
export async function watchAudio(page) {
  await page.addInitScript(() => {
    const Real = window.Audio;
    window.__audio = [];
    window.Audio = function Audio(src) {
      const el = new Real(src);
      el.__on = false;
      el.play = () => { el.__on = true; return Promise.resolve(); };
      el.pause = () => { el.__on = false; };
      window.__audio.push(el);
      return el;
    };
  });
}
export const audios = (page) => page.evaluate(() => window.__audio.map((a) => ({ f: new URL(a.src).searchParams.get('f'), on: a.__on })));

// Касания пальцем через CDP: настоящие pointer-события pointerType=touch
export async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  return {
    down: (x, y) => send('touchStart', x, y),
    move: (x, y) => send('touchMove', x, y),
    up: () => send('touchEnd'),
  };
}

// Галерея игры → первый альбом (или альбом с этим названием), открытый в просмотре
export async function openAlbum(page, title = '') {
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await page.locator('.act-gallery').click();
  await page.locator('.gallery-tabs .chip', { hasText: 'Всё' }).click({ timeout: 20_000 });
  await page.locator('.gallery-tile', title ? { hasText: title } : {}).first().click();
}

// Галерея игры → первый альбом → «Смотреть сцену» (или альбом с этим названием)
export async function openScene(page, title = '') {
  await openAlbum(page, title);
  await page.locator('.gallery-play', { hasText: 'Смотреть сцену' }).click();
  await expect(page.locator('.scene')).toBeVisible();
}
