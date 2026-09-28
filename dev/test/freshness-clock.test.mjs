// Issue #4: freshness was recomputed only when a request completed, so a
// stalled feed kept saying 'live' and 'last fetch: 0s ago' forever. Boots the
// real app.js against a stub DOM on a fake clock (node:test mock timers), lets
// exactly one /miner land, stops the poller, and then only moves the clock.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, advance, flush, okResponse } from './dom-stub.mjs';
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });

const { pill, headline, lastFetch, costReq, fire } = installDom();

const MINER = { uptime_secs: 1, hashrate: 0, shares_submitted: 0, paused: false, boards: [], sources: [] };
const calls = [];
globalThis.fetch = async (path) => {
  calls.push(path);
  const body = path === './layout.json' ? { rows: 10, cols: 10, asics_per_board: 100 }
    : path === './metrics.json' ? {}
    : path === '/api/v0/miner' ? MINER
    : { ok: true };
  return okResponse(body);
};

const { CONFIG } = await import('../../ui/js/config.js');
CONFIG.minerIntervalMs = 20;       // stale after 40 ms
CONFIG.asicSummaryIntervalMs = 100000;
CONFIG.lostAfterMs = 200;
CONFIG.freshnessTickMs = 10;
CONFIG.maxReqWindowMs = 100;
CONFIG.chainSummaryOnLoad = false;

const store = await import('../../ui/js/store.js');
const poller = await import('../../ui/js/poller.js');
store.subscribe((s) => { if (s.miner) poller.stopPoller(); });
const app = await import('../../ui/js/app.js');

await flush();

test.after(() => { app._stopClockForTests(); poller.stopPoller(); mock.timers.reset(); });

test('live -> stale -> lost with no request completing', async () => {
  assert.ok(store.getState().miner, 'first /miner never stored');
  const nCalls = calls.length;
  assert.equal(pill.getAttribute('data-state'), 'live');
  assert.equal(pill.textContent, 'live');

  await advance(60);
  assert.equal(pill.getAttribute('data-state'), 'stale', 'still live 60 ms after the last /miner');
  assert.match(lastFetch.textContent, /^last fetch: 0s ago/);

  await advance(190); // 250 ms since the last response
  assert.equal(pill.getAttribute('data-state'), 'lost', 'not lost after lostAfterMs');
  assert.equal(pill.textContent, 'lost');
  assert.equal(calls.length, nCalls, 'the test itself must not complete any request');
});

test('footer age and measured cost move with the clock', async () => {
  await advance(1000, 50);
  assert.match(lastFetch.textContent, /^last fetch: 1s ago/);
  assert.equal(costReq.textContent, '0.00 req/s', 'meter printed a cached rate for an empty window');
});

test('the tick does not rewrite an unchanged aria-live headline', async () => {
  const before = headline.writes;
  const renders = lastFetch.writes;
  await advance(100);
  assert.ok(lastFetch.writes > renders, 'clock did not re-render');
  assert.equal(headline.writes, before, 'headline rewritten on every tick (re-announces)');
});

test('the clock stops while hidden and re-renders at once on return', async () => {
  document.hidden = true;
  fire('visibilitychange');
  const renders = lastFetch.writes;
  await advance(100);
  assert.equal(lastFetch.writes, renders, 'rendered on the clock while hidden');

  document.hidden = false;
  fire('visibilitychange');
  assert.equal(lastFetch.writes, renders + 1, 'no immediate re-render on return');
  await advance(50);
  assert.ok(lastFetch.writes > renders + 1, 'clock did not restart on return');
});
