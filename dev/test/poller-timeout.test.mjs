// Issue #3: fetch had no deadline, so one request that never completes blocked
// the serial queue for good: no more polling, no /health probe, no apiDown.
// Drives the real poller on a fake clock (node:test mock timers) with a fake
// fetch whose hung requests never settle unless their AbortSignal fires.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const realSetImmediate = setImmediate;
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const MINER = { uptime_secs: 1, hashrate: 0, shares_submitted: 0, paused: false,
  boards: [{ name: 'bzm2-ttyMOCK00' }], sources: [] };

function okResponse(body) {
  const buf = new TextEncoder().encode(JSON.stringify(body)).buffer;
  return { ok: true, status: 200, arrayBuffer: async () => buf };
}

/** A request that never answers; rejects with AbortError only if aborted. */
function hung(opts, { honourSignal = true } = {}) {
  return new Promise((_, reject) => {
    if (!honourSignal || !opts?.signal) return;
    opts.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
}

const { CONFIG, requestTimeoutFor } = await import('../../ui/js/config.js');
const poller = await import('../../ui/js/poller.js');
const store = await import('../../ui/js/store.js');

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => realSetImmediate(r));
}
/** Advance the fake clock in small steps, letting promise chains run. */
async function advance(ms, step = 5) {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    await flush();
  }
}

function scale() {
  CONFIG.minerIntervalMs = 20;
  CONFIG.asicSummaryIntervalMs = 50;
  CONFIG.minerTimeoutIntervals = 2; // 40 ms
  CONFIG.healthTimeoutMs = 40;
  CONFIG.asicSummaryTimeoutMs = 40;
  CONFIG.chainSummaryTimeoutMs = 40;
  CONFIG.chainSummaryOnLoad = false;
  CONFIG.backoffBaseMs = 20; // #11 backoff, scaled with the intervals
  CONFIG.backoffCapMs = 80;
  CONFIG.backoffJitter = 0;
}

function run(fetchImpl) {
  const calls = [];
  globalThis.fetch = (path, opts) => { calls.push({ path, opts }); return fetchImpl(path, opts, calls); };
  return calls;
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  scale();
  poller._resetForTests();
  store.getState().apiDown = false;
});
test.afterEach(() => {
  poller.stopPoller();
  mock.timers.reset();
});

test('default deadlines: /miner 2x interval, health 2 s, summaries 8 s', () => {
  const saved = { ...CONFIG };
  Object.assign(CONFIG, { minerIntervalMs: 2000, minerTimeoutIntervals: 2, healthTimeoutMs: 2000,
    asicSummaryTimeoutMs: 8000, chainSummaryTimeoutMs: 8000 });
  assert.equal(requestTimeoutFor('/api/v0/miner'), 4000);
  assert.equal(requestTimeoutFor('/api/v0/health'), 2000);
  assert.equal(requestTimeoutFor('/api/v0/boards/bzm2-ttyMOCK00/bzm2/asic-summary'), 8000);
  assert.equal(requestTimeoutFor('/api/v0/boards/bzm2-ttyMOCK00/bzm2/chain-summary'), 8000);
  Object.assign(CONFIG, saved);
});

test('a hung /miner times out, is logged as failed, and polling + /health + apiDown proceed', async () => {
  let minerCalls = 0;
  const calls = run((path, opts) => {
    if (path === '/api/v0/miner') {
      minerCalls++;
      return minerCalls === 1 ? Promise.resolve(okResponse(MINER)) : hung(opts);
    }
    return Promise.resolve(okResponse({ ok: true }));
  });
  poller.startPoller();
  await advance(20 * CONFIG.minerIntervalMs);
  poller.stopPoller();

  for (const c of calls) {
    assert.ok(c.opts?.signal instanceof AbortSignal, `${c.path} fetched without an AbortSignal`);
  }
  const hungIdx = calls.findIndex((c, i) => c.path === '/api/v0/miner' && i > 0);
  assert.ok(hungIdx > 0, 'second /miner never requested');
  const after = calls.slice(hungIdx + 1).map((c) => c.path);
  assert.ok(after.includes('/api/v0/health'), `no /health after the hung /miner: ${after.join(' ')}`);
  assert.ok(after.filter((p) => p === '/api/v0/miner').length >= 2, 'polling stopped after the hung /miner');

  const log = poller._requestLog();
  const timedOut = log.filter((e) => e.path === '/api/v0/miner' && !e.ok && e.timedOut);
  assert.ok(timedOut.length >= 1, 'hung /miner not recorded as a timed-out failure');
  assert.equal(store.getState().apiDown, true, 'apiDown never set');
});

test('a fetch that ignores the AbortSignal still releases the queue', async () => {
  let minerCalls = 0;
  const calls = run((path, opts) => {
    if (path === '/api/v0/miner' && ++minerCalls === 2) return hung(opts, { honourSignal: false });
    return Promise.resolve(okResponse(path === '/api/v0/miner' ? MINER : { ok: true }));
  });
  poller.startPoller();
  await advance(10 * CONFIG.minerIntervalMs);
  poller.stopPoller();
  assert.ok(calls.filter((c) => c.path === '/api/v0/miner').length >= 4, 'queue stayed blocked');
  assert.ok(poller._requestLog().some((e) => e.timedOut), 'no timeout recorded');
});

test('a body that never finishes (headers arrived) also times out', async () => {
  let minerCalls = 0;
  const calls = run((path, opts) => {
    if (path === '/api/v0/miner' && ++minerCalls === 2) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => hung(opts, { honourSignal: false }) });
    }
    return Promise.resolve(okResponse(path === '/api/v0/miner' ? MINER : { ok: true }));
  });
  poller.startPoller();
  await advance(10 * CONFIG.minerIntervalMs);
  poller.stopPoller();
  assert.ok(calls.filter((c) => c.path === '/api/v0/miner').length >= 4, 'queue stayed blocked');
  assert.ok(poller._requestLog().some((e) => e.path === '/api/v0/miner' && e.timedOut));
});

test('a hung asic-summary releases the queue for /miner', async () => {
  const calls = run((path, opts) => {
    if (path.endsWith('/asic-summary')) return hung(opts);
    return Promise.resolve(okResponse(path === '/api/v0/miner' ? MINER : { ok: true }));
  });
  poller.startPoller();
  await advance(20 * CONFIG.minerIntervalMs);
  poller.stopPoller();
  const firstSummary = calls.findIndex((c) => c.path.endsWith('/asic-summary'));
  assert.ok(firstSummary >= 0, 'asic-summary never requested');
  const minersAfter = calls.slice(firstSummary + 1).filter((c) => c.path === '/api/v0/miner').length;
  assert.ok(minersAfter >= 3, `only ${minersAfter} /miner after the hung asic-summary`);
  assert.ok(poller._requestLog().some((e) => e.path.endsWith('/asic-summary') && e.timedOut));
});

test('measuredCost reads 0 for an empty window (no cached rate)', async () => {
  run(() => Promise.resolve(okResponse(MINER)));
  poller.startPoller();
  await advance(10);
  poller.stopPoller();
  assert.ok(poller.measuredCost().reqPerSec > 0, 'request not counted');
  await advance(CONFIG.maxReqWindowMs + 100, 500);
  assert.equal(poller.measuredCost().reqPerSec, 0);
});
