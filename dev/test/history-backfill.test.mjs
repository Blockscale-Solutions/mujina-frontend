// Ronald, 2026-09-28: a tab switch must not lose the charts, and they refill at once. The poller
// pauses while hidden (by design); on load and on return the page pulls ./history.json from whoever
// serves it and merges it.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, okResponse } from './dom-stub.mjs';
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000_000 });
const dom = installDom();
const asked = [];
let history = null;
globalThis.fetch = (p) => {
  const u = String(p);
  if (u === './layout.json') return Promise.resolve(okResponse({ rows: 10, cols: 10 }));
  if (u === './metrics.json') return Promise.resolve(okResponse({}));
  if (u.startsWith('./history.json')) { asked.push(u); return history ? Promise.resolve(okResponse(history)) : Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); }
  return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'offline' }) });
};
const store = await import('../../ui/js/store.js');
const poller = await import('../../ui/js/poller.js');
const NOW = Date.now();
let app = null;
test.after(() => { app?._stopClockForTests(); poller.stopPoller(); mock.timers.reset(); });
history = {
  hashrate: [[NOW - 60_000, 1.0e14], [NOW - 55_000, 1.01e14]],
  die: { 'bzm2-A': [[NOW - 58_000, 60, 70, 80, 20]] },
  coverage: { 'bzm2-A': [[NOW - 58_000, 300, 300, 0, 0]] },
  fans: { 'bzm2-A': [[NOW - 57_000, [['fan0', 6780, 100]]]] },
  power: [[NOW - 56_000, 12.3, 1234]],
};

test('mergeHistory fills every ring, in time order, without duplicates, and leaves current state alone', () => {
  const before = store.getState().minerAt;
  store.mergeHistory(history);
  store.mergeHistory(history); // a second, overlapping fetch
  const s = store.getState();
  assert.deepEqual(s.history.hashrate.map((x) => x.v), [1.0e14, 1.01e14]);
  assert.equal(s.history.die['bzm2-A'][0].mean, 70);
  assert.equal(s.history.coverage['bzm2-A'][0].reporting, 300);
  assert.equal(s.history.fans['bzm2-A'][0].fans[0].rpm, 6780);
  assert.deepEqual(s.history.power.map((x) => [x.v, x.w]), [[12.3, 1234]]);
  assert.equal(s.minerAt, before, 'history never makes the miner current');
});

test('the app asks for history at load and again on every return to the tab, from what it holds', async () => {
  history = { hashrate: [[NOW - 5_000, 1.02e14]] };
  app = await import('../../ui/js/app.js');
  await flush(); await flush();
  assert.ok(asked.length >= 1, 'no history request at load');
  const n = asked.length;
  globalThis.document.hidden = true; dom.fire('visibilitychange');
  globalThis.document.hidden = false; dom.fire('visibilitychange');
  await flush(); await flush();
  assert.equal(asked.length, n + 1, 'no history request on return to the tab');
  const since = Number(new URL(asked[asked.length - 1], 'http://x/').searchParams.get('since'));
  assert.ok(since >= NOW - 5_000, `since ${since} is not the newest sample held`);
});

test('no history source: nothing breaks and nothing is invented', () => {
  history = null;
  const s0 = JSON.stringify(store.getState().history.hashrate);
  store.mergeHistory(null);
  store.mergeHistory({});
  assert.equal(JSON.stringify(store.getState().history.hashrate), s0);
});
