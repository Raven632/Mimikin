// Ссылки на /api/ (резервная копия, выгрузка сейвов, архив игры) в демо ведут в никуда: файлов нет. Не даём браузеру
// уйти по ним — спрашиваем роутер, и если он отвечает «в демо этого нет», показываем заметку.
// Слушаем на захвате и глушим событие: окно игры при клике на архив само шлёт HEAD и показало бы вторую ошибку.
export function captureLinks({ ask, onOff }) {
  document.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    e.stopPropagation();
    ask(url).then((res) => { if (res.body?.reason === 'demo-off') onOff(res.body.params?.what); });
  }, true);
}
