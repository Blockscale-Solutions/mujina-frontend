// Drives the real poller, rather than computing what it plans to do.
// Issue #1: the serial queue deadlocked after the first /miner, and the budget
// test (which only computes the planned rate) could not see it.
import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.fetch = async (path) => {
  calls.push(path);
  const body = path === '/api/v0/miner'
    ? { uptime_secs: calls.length, hashrate: 0, shares_submitted: 0, paused: false,
        boards: [{ name: 'bzm2-ttyMOCK00' }, { name: 'bzm2-ttyMOCK10' }], sources: [] }
    : { buses: [] };
  const buf = new TextEncoder().encode(JSON.stringify(body)).buffer;
  return { ok: true, status: 200, arrayBuffer: async () => buf };
};

const { CONFIG } = await import('../../ui/js/config.js');
const poller = await import('../../ui/js/poller.js');

test('the poller keeps polling and reaches every board', async () => {
  CONFIG.minerIntervalMs = 20;
  CONFIG.asicSummaryIntervalMs = 30;
  poller._resetForTests();
  poller.startPoller();
  await new Promise((r) => setTimeout(r, 400));
  poller.stopPoller();

  const count = (re) => calls.filter((p) => re.test(p)).length;
  assert.ok(count(/^\/api\/v0\/miner$/) >= 5, `miner polled ${count(/^\/api\/v0\/miner$/)} times in 400 ms`);
  for (const b of ['bzm2-ttyMOCK00', 'bzm2-ttyMOCK10']) {
    assert.ok(count(new RegExp(`/boards/${b}/bzm2/chain-summary$`)) >= 1, `no chain-summary for ${b}`);
    assert.ok(count(new RegExp(`/boards/${b}/bzm2/asic-summary$`)) >= 1, `no asic-summary for ${b}`);
  }
});
