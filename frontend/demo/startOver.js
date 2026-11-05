// «Начать сначала»: ключи страницы (rpg_*, mimikin.*) и сессия стираются, память демо пропадает с перезагрузкой.
// Чужие ключи с этого же адреса (github.io общий для всех проектов владельца) не трогаем
export function startOver() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('rpg_') || key.startsWith('mimikin.')) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch { /* закрытое хранилище — стирать нечего */ }
  location.reload();
}
