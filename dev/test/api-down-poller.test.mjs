// Issue #15, poller side: one failed /miner is a blip, not an outage.
// apiDown and the health-only mode (#11) both follow one rule: the API is
// down after CONFIG.apiDownAfterFailures consecutive /miner failures.
// Real poller, fake clock, fake fetch, synthetic ttyMOCK data.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const realSetImmediate = setImmediate;
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const { CONFIG } = await import('../../ui/js/config.js');
const poller = await import('../../ui/js/poller.js');
const store = await import('../../ui/js/store.js');
const DEFAULTS = { ...CONFIG };

const MINER = { uptime_secs: 100, hashrate: 1, shares_submitted: 0, paused: false,
  boards: [{ name: 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20', threads: [], asics: [] }], sources: [] };
function response(body, status = 200) {
  const buf = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer;
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => buf };
}
const FAILS = {
  500: () => Promise.resolve(response('boom', 500)),
  garbage: () => Promise.resolve(response('{not json')), // a 200 whose body does not parse
  empty: () => Promise.resolve(response('')),
  network: () => Promise.reject(new TypeError('network down')),
};
async function flush() { for (let i = 0; i < 6; i++) await new Promise((r) => realSetImmediate(r)); }
async function advance(ms, step = 1) { for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); } }

/** plan: array of failure kinds (or 'ok') consumed by successive /miner calls; then ok. */
function run(plan) {
  const calls = [];
  let i = 0;
  globalThis.fetch = (path) => {
    calls.push({ t: Date.now(), path });
    if (path === '/api/v0/miner') {
      const kind = i < plan.length ? plan[i] : 'ok';
      i += 1;
      return kind === 'ok' ? Promise.resolve(response(MINER)) : FAILS[kind]();
    }
    return Promise.resolve(response({ board: {}, buses: [] }));
  };
  return calls;
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  Object.assign(CONFIG, DEFAULTS, {
    minerIntervalMs: 20, asicSummaryIntervalMs: 50, backoffBaseMs: 20, backoffCapMs: 300,
    backoffJitter: 0, chainSummaryOnLoad: false, maxKBps: 1e9,
  });
  poller._resetForTests();
  store.setMiner(MINER); // clears apiDown between tests
});
test.afterEach(() => { poller.stopPoller(); mock.timers.reset(); });

test('#15 default: the API is declared down after 3 consecutive /miner failures', () => {
  assert.equal(DEFAULTS.apiDownAfterFailures, 3);
});

test('#15 one failed /miner: no apiDown, no health-only mode, no /health probe; /miner and summaries carry on', async () => {
  for (const kind of ['500', 'garbage', 'network']) {
    poller._resetForTests();
    const calls = run(['ok', kind]);
    poller.startPoller();
    let sawDown = false;
    for (let t = 0; t < 400; t += 2) {
      await advance(2, 1);
      if (store.getState().apiDown || poller._mode() !== 'ok') sawDown = true;
    }
    poller.stopPoller();
    assert.equal(sawDown, false, `one ${kind} failure latched apiDown / health-only`);
    assert.equal(calls.filter((c) => c.path === '/api/v0/health').length, 0, `${kind}: /health probed on one failure`);
    const miners = calls.filter((c) => c.path === '/api/v0/miner').map((c) => c.t);
    assert.ok(miners.length >= 10, `${kind}: /miner stopped (${miners.length})`);
    assert.ok(miners[2] - miners[1] >= CONFIG.backoffBaseMs, `${kind}: failed /miner retried at once`);
    assert.ok(calls.some((c) => /asic-summary$/.test(c.path) && c.t > miners[1]), `${kind}: summaries stopped`);
    assert.equal(poller._minerFailures(), 0, 'a success did not reset the count');
  }
});

test('#15 N-1 failures then a success reset the count; N consecutive failures (any kind) declare the API down', async () => {
  const n = CONFIG.apiDownAfterFailures;
  const calls = run(['ok', ...Array(n - 1).fill('500'), 'ok', '500', 'empty', 'network']);
  poller.startPoller();
  let downAt = null;
  for (let t = 0; t < 600 && downAt == null; t += 1) {
    await advance(1, 1);
    if (store.getState().apiDown) downAt = Date.now();
  }
  assert.ok(downAt != null, 'never declared down');
  const minerStarts = calls.filter((c) => c.path === '/api/v0/miner');
  assert.equal(minerStarts.length, 1 + (n - 1) + 1 + n, 'went down before N consecutive failures');
  assert.equal(poller._mode(), 'down', 'apiDown and health-only mode disagree');
  assert.equal(store.getState().apiDownSince, downAt);
});

test('#47 review: a /health success resets the count to zero; it takes three more /miner failures to go health-only again', async () => {
  const n = CONFIG.apiDownAfterFailures;
  let healthOk = false;
  const calls = [];
  let first = true;
  globalThis.fetch = (path) => {
    calls.push({ t: Date.now(), path });
    if (path === '/api/v0/miner') {
      if (first) { first = false; return Promise.resolve(response(MINER)); }
      return FAILS[500](); // /miner keeps failing, even after /health answers
    }
    if (path === '/api/v0/health') return healthOk ? Promise.resolve(response('OK\n')) : FAILS.network();
    return Promise.resolve(response({ board: {}, buses: [] }));
  };
  poller.startPoller();
  for (let t = 0; t < 1000 && poller._mode() !== 'down'; t += 1) await advance(1, 1);
  assert.equal(poller._mode(), 'down');
  await advance(100, 1); // a failed /health or two while down

  healthOk = true;
  let upAt = null;
  let downAgainAt = null;
  for (let t = 0; t < 2000 && downAgainAt == null; t += 1) {
    await advance(1, 1);
    if (upAt == null && poller._mode() === 'ok') {
      upAt = Date.now();
      assert.equal(poller._minerFailures(), 0, '/health success did not reset the count');
    }
    if (upAt != null && poller._mode() === 'down') downAgainAt = Date.now();
  }
  assert.ok(upAt != null, '/health success did not resume');
  assert.ok(downAgainAt != null, 'never went health-only again');
  const between = calls.filter((c) => c.path === '/api/v0/miner' && c.t >= upAt && c.t <= downAgainAt);
  assert.equal(between.length, n, `went back to health-only after ${between.length} failure(s), not ${n}`);
  assert.equal(store.getState().apiDown, true, 'apiDown cleared without a /miner success');
});
