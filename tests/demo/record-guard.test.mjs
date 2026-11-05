// Запись данных не стирает чужую папку игр. Запуск: node --test --test-force-exit tests/demo/record-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RECORD = path.join(import.meta.dirname, 'record.js');

test('непустая папка без метки записи остаётся нетронутой, запись отказывается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-guard-'));
  const mine = path.join(dir, 'someone-game');
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'save.dat'), 'x');
  const run = spawnSync('node', [RECORD], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, DEMO_FE: path.join(import.meta.dirname, '../../frontend/demo'), DEMO_LIB: dir, DEMO_OUT: path.join(dir, '..', 'demo-guard-out'), DEMO_SERVER_LOG: path.join(os.tmpdir(), 'demo-guard.log') },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /не наша/);
  assert.ok(fs.existsSync(path.join(mine, 'save.dat')), 'чужой файл на месте');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Сторожевой таймер записи (record.js) короче внешнего `timeout` в рабочих процессах, а тот короче срока задачи: иначе
// медленный раннер роняет и CI, и Pages обрубком без понятного сообщения. Модели проверяются суммами при каждом запуске
test('сроки в pages.yml и ci.yml не короче сторожа записи; models.sh идёт всегда', () => {
  const root = path.join(import.meta.dirname, '../..');
  const guard = Number(/setTimeout\([^\n]*?,\s*(\d+)\);\s*$/m.exec(fs.readFileSync(RECORD, 'utf8').split('\n').find((l) => l.includes('watchdog')))[1]) / 1000;
  for (const f of ['pages.yml', 'ci.yml']) {
    const yml = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
    const sec = Number(/timeout (\d+) node tests\/demo\/record\.js/.exec(yml)[1]);
    assert.ok(sec >= guard, `${f}: timeout ${sec} с короче сторожа ${guard} с`);
    const job = yml.slice(0, yml.indexOf('tests/demo/record.js')).split('timeout-minutes:').pop();
    assert.ok(parseInt(job, 10) * 60 >= sec, `${f}: срок задачи короче записи`);
    const step = /- name: Модели поиска картинок\n([\s\S]*?)run:/.exec(yml)[1];
    assert.ok(!/\bif:/.test(step), `${f}: models.sh не должен пропускаться при попадании в кэш`);
  }
});
