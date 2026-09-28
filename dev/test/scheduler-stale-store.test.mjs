// Issue #8: the store detects a frozen uptime_secs (scheduler not
// publishing) and the scheduler fields are marked stale; no false positive
// at the real 10 s publish / 2 s poll cadence; consistent with #25 (a frozen
// uptime is not a restart, a drop is). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, el } from './dom-stub.mjs';

installDom();
const { CONFIG } = await import('../../ui/js/config.js');
const store = await import('../../ui/js/store.js');
const { renderKpi } = await import('../../ui/js/render/kpi.js');

const miner = (uptime, extra = {}) => ({ uptime_secs: uptime, hashrate: 1, shares_submitted: 5, paused: false, boards: [], ...extra });
function kpiRoot() {
  const cells = {};
  const root = el('kpi');
  root.children = {};
  for (const k of ['hashrate', 'shares', 'accept', 'pool', 'uptime', 'power']) {
    cells[k] = el(`kpi-${k}`);
    cells[`${k}-note`] = el(`kpi-${k}-note`);
    const on = new Set();
    cells[k].classList = { toggle: (c, v) => (v ? on.add(c) : on.delete(c)), contains: (c) => on.has(c), add() {}, remove() {} };
    root.children[`[data-kpi="${k}"]`] = cells[k];
    root.children[`[data-kpi-note="${k}"]`] = cells[`${k}-note`];
  }
  return { root, cells };
}

test('#8 test 1: uptime unchanged from 0 to 30 s makes the scheduler fields stale; the KPI hashrate cell carries a "stale" marker', () => {
  const t0 = 10_000_000;
  for (let at = t0; at <= t0 + 30_000; at += 2000) store.setMiner(miner(100), at);
  assert.equal(store.schedulerStale(t0 + 24_000), false, 'stale before schedulerStaleSecs');
  assert.equal(store.schedulerStale(t0 + 30_000), true, 'frozen uptime not detected');
  assert.equal(store.getState().uptimeAdvancedAt, t0);

  const { root, cells } = kpiRoot();
  renderKpi(root, store.getState(), t0 + 30_000);
  assert.ok(cells.hashrate.classList.contains('stale'), 'hashrate cell not marked stale');
  assert.equal(cells.hashrate.getAttribute('data-stale'), 'stale 30 s');
  assert.match(cells['hashrate-note'].textContent, /^stale 30 s/);
  assert.doesNotMatch(cells['hashrate-note'].textContent, /^measured/);
  assert.match(cells['shares-note'].textContent, /^stale 30 s/);
  assert.match(cells['uptime-note'].textContent, /^stale 30 s/);
  assert.match(cells.hashrate.getAttribute('aria-description'), /stale 30 s/);
});

test('#8 test 2: no false positive when uptime advances by 10 every 10 s and /miner is polled every 2 s for 120 s', () => {
  const t0 = 20_000_000;
  let uptime = 5000;
  for (let at = t0; at <= t0 + 120_000; at += 2000) {
    if (at > t0 && (at - t0) % 10_000 === 0) uptime += 10;
    store.setMiner(miner(uptime), at);
    // Check on the receipt and on the clock ticks up to the next one.
    for (let dt = 0; dt < 2000; dt += 500) assert.equal(store.schedulerStale(at + dt), false, `stale at +${at + dt - t0} ms`);
    const { root, cells } = kpiRoot();
    renderKpi(root, store.getState(), at);
    assert.ok(!cells.hashrate.classList.contains('stale'));
    assert.equal(cells['hashrate-note'].textContent, 'measured from shares');
  }
});

test('#8 / #25: a frozen uptime is not a restart; when it advances again the fields are live; a drop is a restart and counts as a change', () => {
  const t0 = 30_000_000;
  const markers0 = store.getState().restartMarkers.length;
  for (let at = t0; at <= t0 + 60_000; at += 2000) store.setMiner(miner(9000), at); // frozen 60 s
  assert.equal(store.schedulerStale(t0 + 60_000), true);
  store.setMiner(miner(9070), t0 + 62_000); // publishing again
  assert.equal(store.getState().restartMarkers.length, markers0, 'frozen-then-advancing uptime counted as a restart');
  assert.equal(store.schedulerStale(t0 + 62_000), false);
  store.setMiner(miner(3), t0 + 64_000); // restart
  assert.equal(store.getState().restartMarkers.length, markers0 + 1, 'uptime drop not a restart');
  assert.equal(store.getState().uptimeAdvancedAt, t0 + 64_000, 'a drop did not count as a change');
  assert.equal(CONFIG.schedulerStaleSecs, 25);
});
