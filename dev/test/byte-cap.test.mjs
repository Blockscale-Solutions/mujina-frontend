// Issue #46: with the real body sizes, every 60 s window stays under maxKBps.
// Drives the real poller with the shipped CONFIG (2 s /miner floor, 5 s
// asic-summary, chain-summary at load) on a fake clock for 180 s of
// simulated time, so both the part-full early windows (anchored at page
// load) and full steady-state windows are checked. Body sizes are the
// default nominal-3b mock's: /miner 219,788 B (the size measured in the
// browser in #46), asic-summary 5,728 B, chain-summary 354 B.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const realSetImmediate = setImmediate;
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const { CONFIG } = await import('../../ui/js/config.js');
const poller = await import('../../ui/js/poller.js');

const BOARD = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const SIZES = { miner: 219_788, asic: 5_728, chain: 354, health: 11 };

/** A JSON body of exactly `size` bytes. */
function sized(obj, size) {
  const base = JSON.stringify({ ...obj, pad: '' });
  const s = JSON.stringify({ ...obj, pad: 'x'.repeat(size - base.length) });
  assert.equal(Buffer.byteLength(s), size);
  return new TextEncoder().encode(s).buffer;
}
const BODIES = {
  miner: sized({ uptime_secs: 1000, hashrate: 1, shares_submitted: 0, paused: false,
    boards: [{ name: BOARD, threads: [], asics: [] }], sources: [] }, SIZES.miner),
  asic: sized({ board: { name: BOARD } }, SIZES.asic),
  chain: sized({ total_asics: 300, buses: [] }, SIZES.chain),
  health: sized({}, SIZES.health),
};

async function flush() { for (let i = 0; i < 6; i++) await new Promise((r) => realSetImmediate(r)); }

test('#46 every 60 s window, including the part-full early ones, stays at or under maxKBps with real body sizes', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const t0 = Date.now();
  const got = []; // { t, bytes, path }
  globalThis.fetch = (path) => {
    const kind = path === '/api/v0/miner' ? 'miner'
      : path.endsWith('/asic-summary') ? 'asic'
      : path.endsWith('/chain-summary') ? 'chain' : 'health';
    got.push({ t: Date.now(), bytes: SIZES[kind], path });
    const buf = BODIES[kind];
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => buf });
  };
  poller._resetForTests();
  poller.startPoller();
  let meterMax = 0;
  for (let t = 0; t < 180_000; t += 10) {
    mock.timers.tick(10);
    await flush();
    meterMax = Math.max(meterMax, poller.measuredCost().kbPerSec);
  }
  poller.stopPoller();
  mock.timers.reset();

  const W = CONFIG.maxKBWindowMs;
  const capBytes = CONFIG.maxKBps * 1024 * (W / 1000);
  assert.ok(got.filter((g) => g.path.endsWith('/asic-summary')).length >= 30, 'summaries not polled');
  assert.ok(got.some((g) => g.path.endsWith('/chain-summary')), 'chain-summary not fetched');
  // The heaviest window ends on a request; check every one (the first ones
  // are the part-full windows starting at page load).
  let worst = { kib: 0, end: 0 };
  for (const end of got) {
    const bytes = got.filter((g) => g.t > end.t - W && g.t <= end.t).reduce((s, g) => s + g.bytes, 0);
    const kib = bytes / 1024 / (W / 1000);
    if (kib > worst.kib) worst = { kib, end: end.t - t0 };
    assert.ok(bytes <= capBytes,
      `window ending ${((end.t - t0) / 1000).toFixed(1)} s: ${kib.toFixed(2)} KiB/s > ${CONFIG.maxKBps}`);
  }
  assert.ok(meterMax <= CONFIG.maxKBps, `the tab's own meter read ${meterMax.toFixed(2)} KiB/s`);
  // Not needlessly slow either: within the margin plus one body of the cap.
  assert.ok(worst.kib >= CONFIG.maxKBps * (1 - CONFIG.byteCapMargin) - SIZES.miner / 1024 / 60 - 1,
    `worst window only ${worst.kib.toFixed(2)} KiB/s`);
  console.log(`# worst 60 s window ${worst.kib.toFixed(2)} KiB/s (ends ${(worst.end / 1000).toFixed(1)} s); meter max ${meterMax.toFixed(2)}`);
});
