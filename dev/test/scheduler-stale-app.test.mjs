// Issue #8 / acceptance 9 ('stale-scheduler marks the scheduler fields stale
// within 25-30 s'): the real app, poller and freshness clock on a fake clock,
// with /miner answering every poll but uptime_secs frozen (the scheduler has
// stopped publishing). The STALE headline arrives from the clock tick, and a
// paused flag is no longer shown as a live NOT HASHING. Stub DOM.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, advance, flush, okResponse } from './dom-stub.mjs';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
const { headline, chips } = installDom();

let uptime = 1234;
const BOARD = 'bzm2-ttyMOCKAA';
globalThis.fetch = (p) => {
  if (p === './layout.json') return Promise.resolve(okResponse({ rows: 10, cols: 10 }));
  if (p === './metrics.json') return Promise.resolve(okResponse({}));
  if (p === '/api/v0/miner') {
    return Promise.resolve(okResponse({ uptime_secs: uptime, hashrate: 1e15, shares_submitted: 10, paused: true,
      boards: [{ name: BOARD, threads: [{ is_active: true }] }], sources: [] }));
  }
  if (p.endsWith('/asic-summary')) {
    return Promise.resolve(okResponse({ board: { faults: { availability: 'measured', bits: [] },
      coverage: { asics_configured: 100, asics_reporting: 100 } } }));
  }
  return Promise.resolve(okResponse({ total_asics: 100, buses: [] }));
};

const { CONFIG } = await import('../../ui/js/config.js');
CONFIG.maxKBps = 1e9;
const store = await import('../../ui/js/store.js');
const poller = await import('../../ui/js/poller.js');
const app = await import('../../ui/js/app.js');
await flush();
test.after(() => { app._stopClockForTests(); poller.stopPoller(); mock.timers.reset(); });

test('#8 acceptance 9: frozen uptime_secs gives the STALE headline within 25-30 s; publishing again clears it without a restart marker', async () => {
  assert.ok(store.getState().miner, 'first /miner never stored');
  const t0 = store.getState().uptimeAdvancedAt;
  const markers0 = store.getState().restartMarkers.length;
  await advance(6000, 250); // first asic-summary (5 s)
  assert.ok(store.getState().summaries[BOARD], 'asic-summary never stored');
  assert.match(headline.textContent, /^NOT HASHING — paused/);

  let staleAt = null;
  while (Date.now() - t0 < 35_000 && staleAt == null) {
    await advance(250, 250);
    if (headline.textContent.startsWith('STALE')) staleAt = Date.now();
  }
  assert.ok(staleAt != null, 'never went STALE');
  const s = (staleAt - t0) / 1000;
  assert.ok(s > 25 && s <= 30, `STALE after ${s} s, expected 25-30 s`);
  assert.equal(headline.textContent, 'STALE · scheduler not publishing · hashrate, shares and paused not current');
  assert.equal(headline.getAttribute('data-sev'), 'warn');
  const texts = chips.kids.map((c) => c.textContent);
  assert.ok(texts.some((t) => /^paused · stale \d+ s$/.test(t)), texts.join(' | '));
  assert.ok(store.getState().minerAt > staleAt - 5000, '/miner stopped answering; this must be scheduler-only staleness');

  uptime += 40; // the scheduler publishes again
  await advance(5000, 250);
  assert.match(headline.textContent, /^NOT HASHING — paused/);
  assert.equal(store.getState().restartMarkers.length, markers0, 'a frozen uptime was treated as a restart (#25)');
});
