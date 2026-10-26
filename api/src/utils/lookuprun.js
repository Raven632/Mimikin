// Протокол одного поиска данных игры (services/scraper.js, lookupMetadata): какие сайты не ответили,
// что каждый нашёл и что было похоже, но не подошло. Из него — итог поиска и журнал «Как искали» в окне
// игры. AsyncLocalStorage держит протокол отдельно для каждого поиска, даже когда фоновая очередь и ручная
// правка ищут одновременно, и его не надо протаскивать параметром через все функции сайтов
const { AsyncLocalStorage } = require('async_hooks');

const lookupRun = new AsyncLocalStorage();

// Похожее ниже этого — случайное совпадение слов, в журнал и в подсказки не идёт
const NEAR_MIN = 0.4;
const MAX_STEPS = 40;
const MAX_NEAR = 8;

// onStep(step) — шаг сразу, по ходу поиска (окно игры показывает его вживую); credits — кредиты ScraperAPI
// этого поиска по сайтам
const newRun = (onStep = null) => ({ failed: new Set(), unreachable: new Set(), failures: 0, steps: [], near: [], credits: {}, onStep });

// Сайт не ответил: сеть, 403, лимит, 5xx
function noteFailed(label) {
    const run = lookupRun.getStore();
    if (!run) return;
    run.failed.add(label);
    run.failures++;
}

// Сайт не ответил, но спрашивали его просто так, по названию, а не по ссылке игры: это не сбой
// поиска (игры там скорее всего и нет), но и не ответ «такой игры нет» — найденную там раньше
// ссылку не убираем
function noteUnreachable(label) {
    const run = lookupRun.getStore();
    if (!run) return;
    run.unreachable.add(label);
    run.failures++;
}

// Шаг поиска: site — 'itch', 'vndb', 'steam'; by — 'link' или 'title'; q — что спрашивали;
// result — 'found', 'none' (ответил: нет такой), 'down' (не ответил), 'refused' (ссылку убрали руками)
function noteStep({ site, by, q = '', result, link = '' }) {
    const run = lookupRun.getStore();
    if (!run || run.steps.length >= MAX_STEPS) return;
    const step = { site, by, q: String(q).slice(0, 120), result, ...(link ? { link } : {}) };
    run.steps.push(step);
    // n — номер шага: окно, открытое посреди поиска, склеивает снимок и живые шаги без повторов
    try { run.onStep?.(step, run.steps.length - 1); } catch (e) { /* показ вживую — не повод ронять поиск */ }
}

// Кредиты ScraperAPI, потраченные на страницу url: в журнал — по сайту. Сайт — по адресу страницы
const CREDIT_SITES = [[/itch\.io$/, 'itch'], [/steampowered|steamcommunity/, 'steam']];
function noteCredits(url, cost) {
    const run = lookupRun.getStore();
    if (!run || !(cost > 0)) return;
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = 'other'; }
    const site = CREDIT_SITES.find(([re]) => re.test(host))?.[1] || host.replace(/^www\./, '');
    run.credits[site] = (run.credits[site] || 0) + cost;
}

// Похожее, но не подошедшее: лучшее из выдачи сайта, которое не прошло сверку названий. Это и
// объяснение «почему не нашлось», и подсказка «возможно, это она»
function noteNear(site, { title, link, score }) {
    const run = lookupRun.getStore();
    if (!run || !title || !link || !(score >= NEAR_MIN)) return;
    const rounded = Math.round(score * 100) / 100;
    const same = run.near.find((n) => n.link === link);
    if (same) { same.score = Math.max(same.score, rounded); return; }
    run.near.push({ site, title: String(title).slice(0, 160), link, score: rounded });
}

// Сколько сбоев было до сих пор — чтобы понять, не ответил ли сайт именно на этот вопрос
const failuresSoFar = () => lookupRun.getStore()?.failures || 0;

// Журнал для базы: шаги и лучшие из похожих
const journalOf = (run, at = Date.now()) => ({
    at,
    steps: run.steps,
    near: [...run.near].sort((a, b) => b.score - a.score).slice(0, MAX_NEAR),
    ...(Object.keys(run.credits).length ? { credits: run.credits } : {}),
});

module.exports = { lookupRun, newRun, noteFailed, noteUnreachable, noteStep, noteNear, noteCredits, failuresSoFar, journalOf, NEAR_MIN };
