// Сцены и звуки демо (tests/demo/scenes.js): данные согласованы, звуки одинаковы при каждом запуске и малы.
// Запуск: node --test --test-force-exit tests/demo/scenes.test.mjs (звуки — нужен ffmpeg, без него эти проверки пропускаются)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const { GAMES, SOUNDS, SCENE_GAMES, synth } = createRequire(import.meta.url)('./scenes.js');
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('четыре игры со сценами, у каждой по две сцены, кадры и реплики на месте', () => {
  assert.ok(SCENE_GAMES.length >= 4);
  for (const [id, g] of Object.entries(GAMES)) {
    assert.ok(g.events.length >= 2, `${id}: сцен`);
    assert.equal(new Set(g.events.map((e) => e.prefix)).size, g.events.length, `${id}: имена кадров повторяются`);
    for (const ev of g.events) {
      assert.ok(ev.pics.length >= 3, `${id}/${ev.name}: кадров`);
      const says = ev.script.filter(([k]) => k === 'say');
      assert.ok(says.length >= 6, `${id}/${ev.name}: реплик ${says.length}`);
      for (const [k, a] of ev.script) if (k === 'pic') assert.ok(a >= 0 && a < ev.pics.length, `${id}/${ev.name}: кадр ${a}`);
      // Сцена не должна называться так, как сервер называет фоны и меню (gallery.js, BACKDROP_NAME): тогда это не CG
      assert.doesNotMatch(ev.prefix, /menu|back|bg|title/i, `${id}/${ev.name}: имя кадров`);
    }
  }
});

test('каждый звук сцены есть в списке игры и в таблице звуков; у игры две мелодии и шесть эффектов', () => {
  for (const [id, g] of Object.entries(GAMES)) {
    assert.equal(g.bgm.length, 2, `${id}: мелодий`);
    assert.equal(g.se.length, 6, `${id}: эффектов`);
    for (const name of g.bgm) assert.ok(SOUNDS.bgm[name], `${id}: нет мелодии ${name}`);
    for (const name of g.se) assert.ok(SOUNDS.se[name], `${id}: нет эффекта ${name}`);
    for (const ev of g.events) {
      for (const [k, a] of ev.script) {
        if (k === 'bgm') assert.ok(g.bgm.includes(a), `${id}: ${a} не в списке`);
        if (k === 'se') assert.ok(g.se.includes(a), `${id}: ${a} не в списке`);
      }
    }
  }
});

test('звук синтезируется одинаково и занимает мало', { skip: !ffmpeg && 'нет ffmpeg' }, () => {
  let total = 0;
  for (const [kind, list] of Object.entries(SOUNDS)) {
    for (const [name, spec] of Object.entries(list)) {
      const a = synth(name, kind, spec);
      assert.equal(a.subarray(0, 4).toString('latin1'), 'OggS', name);
      assert.ok(a.equals(synth(name, kind, spec)), `${name}: два запуска дали разные байты`);
      total += a.length;
    }
  }
  assert.ok(total < 400 * 1024, `все звуки ${total} Б`);
});
