// Как слот зовётся в игре: «RPG File3» и «MZ_file3» — слот 3, «MZ_file0» — автосохранение MZ
export function slotName(key, t) {
  const n = Number(key.match(/(\d+)$/)?.[1] ?? 0);
  return n === 0 && /^MZ_/i.test(key) ? t.saves_autosave : t.saves_slot(n);
}
