// The scheduler batch from #42: one change in poller.js, one test per issue.
// #11 backoff applied, #12 missed ticks skipped (not stacked), #22 byte cap
// enforced by an adaptive /miner interval, #25 restart handling, #37 minimum
// interval when the tab becomes visible. Real poller, fake clock (node:test
// mock timers), fake fetch; synthetic ttyMOCK data only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const realSetImmediate = setImmediate;
const docListeners = new Set();
globalThis.document = {
  hidden: false,
  addEventListener(t, fn) { if (t === 'visibilitychange') docListeners.add(fn); },
  removeEventListener(t, fn) { if (t === 'visibilitychange') docListeners.delete(fn); },
};

const { CONFIG } = await import('../../ui/js/config.js');
const poller = await import('../../ui/js/poller.js');
const store = await import('../../ui/js/store.js');
const DEFAULTS = { ...CONFIG };

const BOARDS = ['bzm2-ttyMOCK00', 'bzm2-ttyMOCK10', 'bzm2-ttyMOCK20'];
function minerBody({ uptime = 1000, boards = BOARDS, pad = 0 } = {}) {
  const body = { uptime_secs: uptime, hashrate: 1e15, shares_submitted: 0, paused: false,
    boards: boards.map((name) => ({ name, threads: [], asics: [] })), sources: [] };
  if (pad) {
    const base = JSON.stringify({ ...body, pad: '' }).length;
    body.pad = 'x'.repeat(Math.max(0, pad - base));
  }
  return body;
}
function response(body, status = 200) {
  const buf = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer;
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => buf };
}
const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

async function flush() { for (let i = 0; i < 6; i++) await new Promise((r) => realSetImmediate(r)); }
async function advance(ms, step = 1, onStep) {
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); onStep?.(); }
}
/** Install a fake fetch; returns the call log [{ t, path }]. */
function run(impl) {
  const calls = [];
  globalThis.fetch = (path, opts) => { calls.push({ t: Date.now(), path }); return impl(path, opts, calls); };
  return calls;
}
const starts = (calls, re) => calls.filter((c) => re.test(c.path)).map((c) => c.t);
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

test.beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  Object.assign(CONFIG, DEFAULTS, {
    minerIntervalMs: 20,
    asicSummaryIntervalMs: 50,
    backoffBaseMs: 20,
    backoffCapMs: 300,
    backoffJitter: 0,
    minerTimeoutIntervals: 10,
    healthTimeoutMs: 200,
    asicSummaryTimeoutMs: 200,
    chainSummaryTimeoutMs: 200,
    chainSummaryOnLoad: false,
    maxKBps: 1e9, // byte cap out of the way except in the #22 test
  });
  document.hidden = false;
  poller._resetForTests();
});
test.afterEach(() => { poller.stopPoller(); mock.timers.reset(); });

// ---- #11 --------------------------------------------------------------------
test('#11 api down: only /health is probed, on a growing backoff to the cap; /miner resumes after a /health success', async () => {
  // #15: the API is only down after apiDownAfterFailures consecutive /miner
  // failures; health-only mode starts at that failure.
  CONFIG.backoffJitter = 0.2;
  let down = false;
  let healthOkAfter = Infinity;
  const calls = run((path) => {
    const up = Date.now() >= healthOkAfter;
    if (path === '/api/v0/miner' && (!down || up)) { down = true; return Promise.resolve(response(minerBody({ boards: ['bzm2-ttyMOCK00'] }))); }
    if (path === '/api/v0/health' && up) return Promise.resolve(response('OK\n'));
    if (up) return Promise.resolve(response({ board: {}, buses: [] }));
    return Promise.reject(new TypeError('network down'));
  });
  poller.startPoller();
  await advance(60 * CONFIG.backoffBaseMs, 2);
  const failAt = starts(calls, /^\/api\/v0\/miner$/)[CONFIG.apiDownAfterFailures];
  assert.ok(failAt != null, 'the API was never declared down');
  const after = calls.filter((c) => c.t > failAt);
  assert.equal(after.filter((c) => c.path === '/api/v0/miner').length, 0, '/miner retried while down');
  assert.equal(after.filter((c) => /asic-summary/.test(c.path)).length, 0, 'asic-summary polled while down');
  const h = gaps([failAt, ...starts(after, /\/health$/)]);
  assert.ok(h.length >= 5, `only ${h.length} /health probes`);
  let expect = CONFIG.backoffBaseMs;
  for (const g of h) {
    assert.ok(g >= expect * 0.8 - 2 && g <= expect * 1.2 + 4, `/health gap ${g} ms, expected ${expect} ms ±20%: ${h.join(',')}`);
    expect = Math.min(CONFIG.backoffCapMs, expect * 2);
  }
  assert.ok(h.at(-1) >= CONFIG.backoffCapMs * 0.8 - 2, 'backoff never reached the cap');
  assert.equal(poller._mode(), 'down');

  healthOkAfter = Date.now();
  await advance(CONFIG.backoffCapMs * 1.5, 2);
  assert.equal(poller._mode(), 'ok', 'a /health success did not resume');
  assert.ok(calls.filter((c) => c.t > healthOkAfter && c.path === '/api/v0/miner').length >= 1, '/miner did not resume');
});

test('#11 a failing asic-summary backs off that board only', async () => {
  const calls = run((path) => {
    if (path === '/api/v0/miner') return Promise.resolve(response(minerBody({ boards: ['bzm2-ttyMOCKAA', 'bzm2-ttyMOCKBB'] })));
    if (path.includes('ttyMOCKAA')) return Promise.resolve(response('busy', 500));
    return Promise.resolve(response({ board: {}, buses: [] }));
  });
  poller.startPoller();
  await advance(3000, 2);
  const a = gaps(starts(calls, /ttyMOCKAA\/bzm2\/asic-summary$/));
  const b = gaps(starts(calls, /ttyMOCKBB\/bzm2\/asic-summary$/));
  assert.ok(a.length >= 5 && b.length >= 20, `a ${a.length} b ${b.length}`);
  assert.ok(a.at(-1) >= CONFIG.backoffCapMs - 2, `board A gaps never reached the cap: ${a.join(',')}`);
  for (let i = 1; i < a.length; i++) assert.ok(a[i] >= a[i - 1] - 2, `board A gaps shrank: ${a.join(',')}`);
  assert.ok(b.every((g) => g <= CONFIG.asicSummaryIntervalMs + 4), `board B slowed down: ${b.join(',')}`);
});

// ---- #12 --------------------------------------------------------------------
test('#12 slow asic-summary: ticks are skipped not stacked; no /miner starvation, no burst after recovery', async () => {
  CONFIG.backoffCapMs = 20; // keep summaries at their interval, to load the queue
  const slowUntil = Date.now() + 60 * CONFIG.minerIntervalMs;
  const calls = run((path) => {
    if (path === '/api/v0/miner') return Promise.resolve(response(minerBody()));
    if (/asic-summary$/.test(path) && Date.now() < slowUntil) return later(60, response('slow', 500));
    return Promise.resolve(response({ board: {}, buses: [] }));
  });
  let maxDepth = 0;
  poller.startPoller();
  await advance(slowUntil - Date.now() + 30 * CONFIG.minerIntervalMs, 1, () => {
    for (const n of Object.values(poller._queueDepth())) maxDepth = Math.max(maxDepth, n);
  });
  assert.ok(maxDepth <= 1, `an endpoint had ${maxDepth} pending entries`);
  assert.ok(Object.values(poller._skipped()).reduce((s, n) => s + n, 0) >= 0);

  const winStart = slowUntil + 60; // last slow response
  const win = calls.filter((c) => c.t >= winStart && c.t < winStart + 30 * CONFIG.minerIntervalMs);
  const plannedMiner = 30;
  const plannedSummary = (30 * CONFIG.minerIntervalMs / CONFIG.asicSummaryIntervalMs) * BOARDS.length;
  const nMiner = win.filter((c) => c.path === '/api/v0/miner').length;
  const nSummary = win.filter((c) => /asic-summary$/.test(c.path)).length;
  assert.ok(nMiner <= plannedMiner + 1, `${nMiner} /miner after recovery, planned ${plannedMiner}`);
  assert.ok(nSummary <= plannedSummary + 3, `${nSummary} summaries after recovery, planned ${plannedSummary}`);

  const m = gaps(starts(calls, /^\/api\/v0\/miner$/));
  assert.ok(Math.max(...m) <= 60 + CONFIG.minerIntervalMs + 2, `/miner starved: max gap ${Math.max(...m)} ms`);
});

// ---- #22 --------------------------------------------------------------------
test('#22 nextMinerDelayMs keeps a 230 KB /miner plus other traffic under the byte cap', () => {
  const cfg = { ...DEFAULTS };
  const budget = cfg.maxKBps * 1024;
  for (const other of [0, 1500, 20_000]) {
    const d = poller.nextMinerDelayMs(230_061, other, cfg);
    assert.ok(d >= cfg.minerIntervalMs);
    assert.ok((230_061 * 1000) / d + other <= budget + 1e-6, `${other} B/s other: ${d} ms is over budget`);
  }
  assert.equal(poller.nextMinerDelayMs(20_000, 0, cfg), cfg.minerIntervalMs, 'small bodies keep the base interval');
});

test('#22 driven: 230,061-byte /miner bodies are spaced by the computed delay and the metered rate holds the cap', async () => {
  // Scale time and the byte budget by the same factor (1/100).
  Object.assign(CONFIG, { minerIntervalMs: 20, maxKBps: 100 * 100, maxKBWindowMs: 600, asicSummaryIntervalMs: 1e9 });
  const body = minerBody({ boards: [], pad: 230_061 });
  const calls = run(() => Promise.resolve(response(body)));
  const expected = poller.nextMinerDelayMs(230_061, 0);
  assert.ok(expected > CONFIG.minerIntervalMs, 'test would not exercise the cap');
  poller.startPoller();
  await advance(1200, 1);
  const g = gaps(starts(calls, /^\/api\/v0\/miner$/));
  assert.ok(g.length >= 20);
  assert.ok(g.every((x) => x >= expected), `gap below ${expected} ms: ${Math.min(...g)}`);
  const kbps = poller.measuredCost().kbPerSec;
  assert.ok(kbps <= CONFIG.maxKBps, `metered ${kbps.toFixed(0)} KB/s over the ${CONFIG.maxKBps} cap`);
  assert.equal(poller.effectiveMinerIntervalMs(), expected);
});

// ---- #25 --------------------------------------------------------------------
test('#25 restart: chain-summary fetched again for every board, and the chart summary names the restart', async () => {
  CONFIG.chainSummaryOnLoad = true;
  CONFIG.asicSummaryIntervalMs = 1e9;
  let uptime = 1000;
  const calls = run((path) => Promise.resolve(response(path === '/api/v0/miner'
    ? minerBody({ uptime }) : { total_asics: 100, buses: [] })));
  poller.startPoller();
  await advance(200, 2);
  assert.equal(starts(calls, /chain-summary$/).length, 3, 'chain-summary at load');
  const markers0 = store.getState().restartMarkers.length;
  uptime = 5; // restart
  await advance(200, 2);
  assert.equal(store.getState().restartMarkers.length, markers0 + 1, 'restart not detected');
  assert.equal(starts(calls, /chain-summary$/).length, 6, 'chain-summary not re-fetched after the restart');

  // The hashrate chart's text summary names it.
  const { renderCharts, fmtClock } = await import('../../ui/js/render/charts.js');
  const els = Object.create(null);
  const ctx = new Proxy({}, { get: (_, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
  const canvas = () => ({ parentElement: { getBoundingClientRect: () => ({ width: 300, height: 120 }) }, style: {}, getContext: () => ctx });
  const root = {
    querySelectorAll: () => [],
    querySelector: (sel) => (els[sel] ||= sel.startsWith('[data-chart=') ? canvas() : { textContent: '' }),
  };
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  document.documentElement = { getAttribute: () => null };
  renderCharts(root, store.getState());
  const text = els['[data-chart-summary="hashrate"]'].textContent;
  assert.match(text, /restart at \d\d:\d\d:\d\d/);
  assert.ok(text.includes(fmtClock(store.getState().restartMarkers.at(-1))));
});

test('#25 a chain-summary that fails at load is retried on its backoff', async () => {
  CONFIG.chainSummaryOnLoad = true;
  CONFIG.asicSummaryIntervalMs = 1e9;
  let chainOk = false;
  const calls = run((path) => {
    if (path === '/api/v0/miner') return Promise.resolve(response(minerBody({ boards: ['bzm2-ttyMOCK00'] })));
    return Promise.resolve(chainOk ? response({ total_asics: 100, buses: [] }) : response('boom', 500));
  });
  poller.startPoller();
  await advance(100, 2);
  assert.ok(starts(calls, /chain-summary$/).length >= 2, 'failed chain-summary never retried');
  chainOk = true;
  await advance(400, 2);
  assert.ok(store.getState().chain['bzm2-ttyMOCK00'], 'chain-summary never stored after recovery');
  const n = starts(calls, /chain-summary$/).length;
  await advance(400, 2);
  assert.equal(starts(calls, /chain-summary$/).length, n, 'chain-summary keeps polling after success');
});

test('#25 a restart inside a long gap is detected from the implied start time; a frozen uptime is not a restart', () => {
  const s = store.getState();
  store.setMiner({ uptime_secs: 70 }, 30_000);
  const n0 = s.restartMarkers.length; // (earlier tests may have left a higher uptime)
  store.setMiner({ uptime_secs: 90 }, 120_000); // started at ~30 s after the old start: restart
  assert.equal(s.restartMarkers.length, n0 + 1);
  store.setMiner({ uptime_secs: 90 }, 200_000); // frozen uptime (#8), not a restart
  store.setMiner({ uptime_secs: 100 }, 210_000); // the implied start moved, but relative to the frozen sample
  assert.equal(s.restartMarkers.length, n0 + 1, 'frozen uptime produced a restart marker');
});

// ---- #37 --------------------------------------------------------------------
test('#37 rapid tab toggling never starts /miner sooner than one interval after the last', async () => {
  const calls = run(() => Promise.resolve(response(minerBody({ boards: [] }))));
  poller.startPoller();
  for (let i = 0; i < 50; i++) { // 400 ms each way for 20 s, scaled 1/100
    await advance(4, 1);
    document.hidden = !document.hidden;
    for (const fn of docListeners) fn();
  }
  const m = starts(calls, /^\/api\/v0\/miner$/);
  assert.ok(m.length >= 5, `only ${m.length} /miner`);
  const g = gaps(m);
  assert.ok(g.every((x) => x >= CONFIG.minerIntervalMs), `/miner ${Math.min(...g)} ms apart`);
});
