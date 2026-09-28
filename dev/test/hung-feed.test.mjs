// Issues #3 + #4 together: the frozen-as-live page. Boots the real app.js with
// the poller running; after the first /miner every API request hangs (the
// SIGSTOPped-mock case: /miner and /health never answer). On a fake clock,
// with no request ever completing again, the page must go stale, then lost,
// and the poller must keep probing (timeouts release the queue). Per #15 the
// API is declared down only after apiDownAfterFailures consecutive /miner
// failures, and the pill follows /miner freshness alone (acceptance 9); per
// #11, once down only /health is probed, on a growing backoff.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, advance, flush, okResponse } from './dom-stub.mjs';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
const { pill } = installDom();

const MINER = { uptime_secs: 1, hashrate: 0, shares_submitted: 0, paused: false, boards: [], sources: [] };
const calls = [];
let minerAnswered = false;
globalThis.fetch = (path, opts) => {
  calls.push({ path, opts });
  if (path === './layout.json') return Promise.resolve(okResponse({ rows: 10, cols: 10 }));
  if (path === './metrics.json') return Promise.resolve(okResponse({}));
  if (path === '/api/v0/miner' && !minerAnswered) {
    minerAnswered = true;
    return Promise.resolve(okResponse(MINER));
  }
  return new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
};

const { CONFIG } = await import('../../ui/js/config.js');
CONFIG.minerIntervalMs = 20;        // stale after 40 ms without a /miner
CONFIG.minerTimeoutIntervals = 5;   // hung /miner aborted after 100 ms
// With backoff 20/40 ms: failures at ~120, ~240, ~380 ms -> down just before lost.
CONFIG.healthTimeoutMs = 40;
CONFIG.asicSummaryIntervalMs = 100000;
CONFIG.lostAfterMs = 400;
CONFIG.freshnessTickMs = 10;
CONFIG.chainSummaryOnLoad = false;
CONFIG.backoffBaseMs = 20;          // #11: /health probed on backoff while down
CONFIG.backoffCapMs = 160;
CONFIG.backoffJitter = 0;

const store = await import('../../ui/js/store.js');
const poller = await import('../../ui/js/poller.js');
const app = await import('../../ui/js/app.js');
await flush();

test.after(() => { app._stopClockForTests(); poller.stopPoller(); mock.timers.reset(); });

test('a hung feed: stale within 2x interval, lost at lostAfterMs, API down only after N failures; polling carries on', async () => {
  assert.ok(store.getState().miner, 'first /miner never stored');
  assert.equal(pill.getAttribute('data-state'), 'live');
  const t0 = store.getState().minerAt;
  const at = (ms) => advance(t0 + ms - Date.now());

  // Acceptance 9: stale within 2x the interval.
  await at(2 * CONFIG.minerIntervalMs + 20);
  assert.equal(pill.getAttribute('data-state'), 'stale', 'hung feed still shown as live');

  // #15: two timed-out /miner requests are a blip, not an outage; the pill is
  // not forced to 'lost' by the poller, only by lostAfterMs.
  await at(CONFIG.lostAfterMs - 50);
  assert.equal(pill.getAttribute('data-state'), 'stale', 'went lost before lostAfterMs');
  assert.equal(poller._minerFailures(), 2);
  assert.equal(store.getState().apiDown, false, 'API declared down before N consecutive failures');

  // Acceptance 9: lost at lostAfterMs; the third failure declares the API down.
  await at(CONFIG.lostAfterMs + 30);
  assert.equal(pill.getAttribute('data-state'), 'lost', 'hung feed never reached lost');
  assert.equal(store.getState().apiDown, true);

  await advance(1000, 10);
  const api = calls.filter((c) => c.path.startsWith('/api/'));
  assert.ok(api.every((c) => c.opts?.signal instanceof AbortSignal), 'a request went out without a deadline');
  const health = api.filter((c) => c.path === '/api/v0/health').length;
  assert.ok(health >= 3, `polling froze behind the hung request (${health} /health probes)`);
  // 1 good + apiDownAfterFailures timed out; then only /health (#11).
  assert.equal(api.filter((c) => c.path === '/api/v0/miner').length, 1 + CONFIG.apiDownAfterFailures);
  const okAfter = poller._requestLog().filter((e) => e.ok && e.t > t0);
  assert.equal(okAfter.length, 0, 'a request completed; the transitions must be clock-driven');
  assert.ok(poller._requestLog().filter((e) => e.timedOut).length >= 3, 'timeouts not recorded');
});
