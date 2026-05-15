import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const worker = readFileSync(new URL('../../apps/web/workers/worker.js', import.meta.url), 'utf8');

test('worker exposes operational health routes', () => {
  assert.match(worker, /case '\/api\/status'/);
  assert.match(worker, /case '\/api\/scoreboard'/);
  assert.match(worker, /case '\/api\/schedule'/);
});

test('worker proxies advanced data endpoints', () => {
  assert.match(worker, /case '\/api\/shot_zones'/);
  assert.match(worker, /case '\/api\/lineups'/);
  assert.match(worker, /case '\/api\/play_types'/);
  assert.match(worker, /case '\/api\/injuries'/);
});

test('worker uses NBA Eastern date keys', () => {
  assert.match(worker, /America\/New_York/);
  assert.match(worker, /function todayKey\(\)/);
});

test('schedule cache stays fresh enough for game-day UX', () => {
  assert.match(worker, /const TTL_SCHEDULE = 1800/);
});
