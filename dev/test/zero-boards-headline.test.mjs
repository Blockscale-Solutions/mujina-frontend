// dev/test/zero-boards-headline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';
installDom();
const { safetyModel } = await import('../../ui/js/render/safety.js');
const B = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const NOW = 10_000_000;
const threads = [{ is_active: true }, { is_active: true }, { is_active: true }];
const miner = (x = {}) => ({ uptime_secs: 1000, paused: false, hashrate: 5e14, shares_submitted: 50, boards: [{ name: B, threads }], ...x });
const okSum = (bits = []) => ({ board: { faults: { availability: 'measured', bits }, coverage: { asics_configured: 300, asics_reporting: 300 } } });
const base = (o = {}) => ({ miner: miner(), minerAt: NOW - 1000, summaries: {}, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000, ...o });
const trip = [{ bit: 'thermal_trip', asics_asserting: 1, asic_ids: [42], asic_ids_omitted: 0 }];

test('/miner with boards: [] never gives the neutral "(measured)" headline', () => {
  const m = safetyModel(base({ miner: miner({ boards: [] }) }), NOW);
  assert.notEqual(m.sev, 'neutral', m.head);
  assert.doesNotMatch(m.head, /\(measured\)/);
});

test('a board that asserted thermal_trip 3 s ago and then leaves boards[] keeps a red headline', () => {
  const m = safetyModel(base({ miner: miner({ boards: [] }), summaries: { [B]: { data: okSum(trip), at: NOW - 3000 } } }), NOW);
  assert.equal(m.sev, 'fault', m.head);
});
