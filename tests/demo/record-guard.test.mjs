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
