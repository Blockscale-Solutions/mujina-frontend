// Issue #13: shares/min is derived per 2 s poll from a counter that only
// changes on the scheduler's 10 s publish, so it reads 0 most of the time
// and spikes otherwise. The rate must come from the server's own clock
// (Δshares_submitted ÷ Δuptime_secs), change only when the scheduler
// publishes, hold between publishes, reset on restart (#25), never go
// negative, and name its derivation (hard rule 4). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, el } from './dom-stub.mjs';

installDom();
const store = await import('../../ui/js/store.js');
const { renderKpi } = await import('../../ui/js/render/kpi.js');

let base = 0;
/** A fresh time base far from the previous test's (reads as a restart, so the derivation resets). */
function fresh() { base += 1e9; return base; }
const miner = (uptime, shares, extra = {}) => ({ uptime_secs: uptime, shares_submitted: shares, hashrate: 1, paused: false, boards: [], ...extra });
const spm = () => store.getState().sharesPerMin;

function kpiRoot() {
  const root = el('kpi');
  root.children = {};
  const cells = {};
  for (const k of ['hashrate', 'shares', 'accept', 'pool', 'uptime', 'power']) {
    cells[k] = el(k);
    cells[`${k}-note`] = el(`${k}-note`);
    root.children[`[data-kpi="${k}"]`] = cells[k];
    root.children[`[data-kpi-note="${k}"]`] = cells[`${k}-note`];
  }
  return { root, cells };
}

test('#13 issue test: 10 shares per 10 s publish, polled every 2 s for 120 s -> always within 20% of 60/min once derived', () => {
  const t0 = fresh();
  const seen = [];
  for (let t = 0; t <= 120_000; t += 2000) {
    const step = Math.floor(t / 10_000) * 10;
    store.setMiner(miner(500 + step, 1000 + step), t0 + t);
    if (spm() != null) seen.push(spm());
  }
  assert.ok(seen.length >= 30, `never derived (${seen.length} values)`);
  for (const v of seen) assert.ok(Math.abs(v - 60) <= 12, `shares/min ${v.toFixed(1)}, expected 60 ±20%: ${seen.map((x) => x.toFixed(0)).join(',')}`);
});

test('#13 the browser flip: mock cadence (1 share per 3 s, uptime per 1 s, /miner every 2.33 s) never reads 0.0 or ~25.8 once derived', () => {
  // dev/mock-api.mjs: shares += floor(elapsed / 3), uptime += elapsed; #46 /miner delay ~2.33 s.
  const t0 = fresh();
  const seen = [];
  for (let t = 0; t <= 90_000; t += 2330) {
    const s = Math.floor(t / 1000);
    store.setMiner(miner(3600 + s, 4200 + Math.floor(s / 3)), t0 + t);
    if (spm() != null) seen.push(spm());
  }
  assert.ok(seen.length >= 20, `never derived (${seen.length} values)`);
  for (const v of seen) assert.ok(Math.abs(v - 20) <= 4, `shares/min ${v.toFixed(1)}, true rate 20: ${seen.map((x) => x.toFixed(1)).join(',')}`);
});

test('#13 the real unit (~3.8 shares/min, 10 s publishes): the rate changes only on a publish, holds between, and settles near 3.8 instead of 0 / spikes', () => {
  const t0 = fresh();
  const rate = 137 / 2140; // shares per second, from the paused capture (about 3.8/min)
  let prev = null;
  let prevUptime = null;
  const settled = [];
  for (let t = 0; t <= 600_000; t += 2000) {
    const pub = Math.floor(t / 10_000) * 10; // server seconds at the last publish
    const uptime = 2000 + pub;
    store.setMiner(miner(uptime, 50 + Math.floor(pub * rate)), t0 + t);
    const v = spm();
    if (prevUptime === uptime) assert.equal(v, prev, `rate moved between publishes at +${t} ms (${prev} -> ${v})`);
    if (v != null) assert.ok(v >= 0, 'negative rate');
    if (t >= 300_000) settled.push(v);
    prev = v;
    prevUptime = uptime;
  }
  for (const v of settled) assert.ok(v != null && Math.abs(v - 3.84) <= 0.96, `settled rate ${v}, expected 3.8 ±25%`);
});

test('#13 / #25: a restart (uptime and counter drop) resets the derivation to "deriving", never a negative or garbage rate', () => {
  const t0 = fresh();
  for (let t = 0; t <= 60_000; t += 2000) {
    const step = Math.floor(t / 10_000) * 10;
    store.setMiner(miner(900 + step, 300 + step), t0 + t);
  }
  assert.ok(Math.abs(spm() - 60) < 1);
  const markers = store.getState().restartMarkers.length;
  // Restart: uptime and the counter start again from near zero.
  const seen = [];
  for (let t = 62_000; t <= 140_000; t += 2000) {
    const s = Math.floor((t - 62_000) / 10_000) * 10;
    store.setMiner(miner(5 + s, s), t0 + t);
    seen.push({ t: t - 62_000, v: spm() });
  }
  assert.equal(store.getState().restartMarkers.length, markers + 1, 'restart not detected');
  assert.equal(seen[0].v, null, 'rate carried across a restart');
  for (const { v } of seen) if (v != null) assert.ok(v >= 0 && v <= 70, `garbage rate after restart: ${v}`);
  assert.ok(Math.abs(seen.at(-1).v - 60) < 1, `did not re-derive: ${seen.at(-1).v}`);
});

test('#13 a counter that drops without an uptime drop restarts the derivation instead of going negative', () => {
  const t0 = fresh();
  for (let t = 0; t <= 60_000; t += 10_000) store.setMiner(miner(700 + t / 1000, 100 + t / 1000), t0 + t);
  store.setMiner(miner(770, 20), t0 + 70_000); // counter went backwards
  assert.ok(spm() == null || spm() >= 0, `negative rate ${spm()}`);
  assert.equal(spm(), null, 'rate derived across a counter reset');
});

test('#13 / #8: while uptime_secs is frozen the last rate is held, not recomputed to 0', () => {
  const t0 = fresh();
  for (let t = 0; t <= 60_000; t += 2000) {
    const step = Math.floor(t / 10_000) * 10;
    store.setMiner(miner(100 + step, 10 + step), t0 + t);
  }
  const held = spm();
  assert.ok(Math.abs(held - 60) < 1);
  for (let t = 62_000; t <= 120_000; t += 2000) {
    store.setMiner(miner(160, 70), t0 + t); // scheduler stopped publishing
    assert.equal(spm(), held, `rate changed while uptime was frozen: ${spm()}`);
  }
});

test('#13 hard rule 4: the KPI note names the derivation and its span, and says "deriving" (not 0.0) until there is enough', () => {
  const t0 = fresh();
  const { root, cells } = kpiRoot();
  // `now` is passed so a scheduler-staleness check (#8, PR #49) judges the
  // same synthetic clock as the receipts.
  store.setMiner(miner(40, 7), t0);
  renderKpi(root, store.getState(), t0);
  assert.match(cells['shares-note'].textContent, /^shares\/min: deriving… \(Δshares ÷ Δuptime/);
  store.setMiner(miner(50, 7), t0 + 10_000); // one publish, no share yet
  renderKpi(root, store.getState(), t0 + 10_000);
  assert.doesNotMatch(cells['shares-note'].textContent, /0\.0/, 'a 10 s span with no share shown as 0.0');
  for (let t = 20_000; t <= 60_000; t += 10_000) store.setMiner(miner(40 + t / 1000, 7 + t / 1000), t0 + t);
  renderKpi(root, store.getState(), t0 + 60_000);
  assert.match(cells['shares-note'].textContent, /^\d+\.\d shares\/min \(derived: Δshares ÷ Δuptime over 60 s\)$/);
});

// #66 (Ronald, 2026-09-25): while paused the note says so, with no number; on resume the derivation starts over.
test('while paused the note says paused, not a decaying rate; on resume the derivation restarts', () => {
  const t0 = fresh(); const { root, cells } = kpiRoot();
  for (let t = 0; t <= 300_000; t += 10_000) store.setMiner(miner(1000 + t / 1000, t / 1000), t0 + t);
  for (let t = 310_000; t <= 420_000; t += 10_000) store.setMiner(miner(1000 + t / 1000, 300, { paused: true }), t0 + t);
  renderKpi(root, store.getState(), t0 + 420_000);
  assert.match(cells['shares-note'].textContent, /paused/, `while paused: "${cells['shares-note'].textContent}"`);
  assert.doesNotMatch(cells['shares-note'].textContent, /\d+\.\d shares\/min/);
  store.setMiner(miner(1430, 301), t0 + 430_000);
  renderKpi(root, store.getState(), t0 + 430_000);
  assert.match(cells['shares-note'].textContent, /deriving/, `just after resume: "${cells['shares-note'].textContent}"`);
});
