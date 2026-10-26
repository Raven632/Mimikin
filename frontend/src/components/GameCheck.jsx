import { useEffect, useRef, useState } from 'react';
import { timeAgo } from '../formatAgo';

const MAX_MS = 4 * 60 * 1000;

// «Проверить в игре»: игра с переводом открывается в маленькой рамке в режиме проверки (rpg-fixes,
// setupSelfTest — ?mimikin-check=1): сама проходит заголовок, настройки, начало игры и меню, без сохранений
// и звука, и присылает итог — шаги и ошибки («Failed to load», сбои кода). Итог хранит сервер. Идёт на
// этом устройстве: браузера на сервере нет, а проверка «как у игрока» и должна быть в браузере игрока
const GameCheck = ({ game, t, lang, last, auto, onSaved }) => {
  const [run, setRun] = useState(null);       // { url, origin, steps }
  const [error, setError] = useState('');
  const startedFor = useRef(0);
  const frameRef = useRef(null);

  const start = async () => {
    setError('');
    try {
      const res = await fetch(`/api/play/${encodeURIComponent(game.id)}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.mode !== 'frame') throw new Error();
      const origin = data.origin || `${window.location.protocol}//${window.location.hostname}:${data.port}`;
      setRun({ url: `${origin}${data.path}?mimikin-check=1&lang=${localStorage.getItem('rpg_lang') || 'ru'}`, origin, steps: [] });
    } catch {
      setError(t.chk_cant);
    }
  };

  // Перевод только что закончился при открытом окне — проверяем сами, один раз
  useEffect(() => {
    if (auto && auto !== startedFor.current && !run) {
      startedFor.current = auto;
      start();
    }
  }, [auto]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!run) return undefined;
    const finish = async (result) => {
      setRun(null);
      try {
        const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/translation/check-result`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
        });
        if (res.ok) onSaved(await res.json());
      } catch { /* итог не сохранился — увидим при следующей проверке */ }
    };
    const onMessage = (e) => {
      // Итог — только от своей рамки: другая открытая игра на том же адресе его не подменит
      if (e.origin !== run.origin || e.source !== frameRef.current?.contentWindow || e.data?.type !== 'mimikin-check') return;
      if (e.data.phase === 'step') setRun((r) => (r ? { ...r, steps: [...r.steps, { name: e.data.step, ok: e.data.ok }] } : r));
      if (e.data.phase === 'done') finish({ ok: e.data.ok, steps: e.data.steps, errors: e.data.errors });
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish({ ok: false, steps: run.steps, errors: [{ kind: 'check', message: t.chk_timeout, source: '' }] }), MAX_MS);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timer); };
  }, [run?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tl-gamecheck">
      {!run && (
        <div className="tl-gamecheck-head">
          <span className={`tl-state${last ? (last.ok ? ' tl-check-ok' : ' tl-error') : ''}`}>
            {last ? (last.ok ? t.chk_ok(timeAgo(last.at, lang)) : t.chk_bad(timeAgo(last.at, lang))) : t.chk_never}
          </span>
          <button type="button" className="meta-status-btn subtle" onClick={start}>{t.chk_run}</button>
        </div>
      )}
      {!run && last && !last.ok && (
        <ul className="tl-check-list">
          {/* Шаги, до которых игра не дошла (ошибок может и не быть: висит на заставке) */}
          {(last.steps || []).filter((x) => !x.ok).map((x) => <li key={`s-${x.name}`}><span className="tl-check-kind">{t.chk_step_failed}</span><span className="tl-check-text">{t.chk_step[x.name] || x.name}</span></li>)}
          {(last.errors || []).map((x, i) => <li key={i}><span className="tl-check-kind">{t.chk_kind[x.kind] || x.kind}</span><span className="tl-check-text">{[x.message, x.source].filter(Boolean).join(' — ')}</span></li>)}
        </ul>
      )}
      {error && <span className="tl-state tl-error">{error}</span>}
      {run && (
        <div className="tl-gamecheck-run">
          <span className="tl-state">{t.chk_running}</span>
          <ul className="tl-gamecheck-steps">
            {['title', 'options', 'play', 'menu'].map((name) => {
              const done = run.steps.find((x) => x.name === name);
              return <li key={name} className={done ? (done.ok ? 'ok' : 'bad') : ''}>{t.chk_step[name]}</li>;
            })}
          </ul>
          <iframe ref={frameRef} className="tl-gamecheck-frame" src={run.url} title={t.chk_frame}
            sandbox="allow-scripts allow-same-origin" />
        </div>
      )}
    </div>
  );
};

export default GameCheck;
