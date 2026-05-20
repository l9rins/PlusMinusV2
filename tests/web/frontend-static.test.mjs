import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const home = readFileSync(new URL('../../apps/web/pages/home.html', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../apps/web/scripts/shared.js', import.meta.url), 'utf8');

test('home dashboard loads core scripts in order', () => {
  const dataIdx = home.indexOf('../scripts/data.js');
  const sharedIdx = home.indexOf('../scripts/shared.js');
  const dashboardIdx = home.indexOf('../scripts/dashboard.js');

  assert.ok(dataIdx > -1);
  assert.ok(sharedIdx > dataIdx);
  assert.ok(dashboardIdx > sharedIdx);
});

test('frontend exposes prediction API resolver', () => {
  assert.match(shared, /function resolvePredictionApiBase/);
  assert.match(shared, /window\.PM_CONFIG/);
});

test('team page exposes advanced analytics labs', () => {
  const team = readFileSync(new URL('../../apps/web/pages/team.html', import.meta.url), 'utf8');
  assert.match(team, /id="analyticsLab"/);
  assert.match(team, /id="lineupLab"/);
});
