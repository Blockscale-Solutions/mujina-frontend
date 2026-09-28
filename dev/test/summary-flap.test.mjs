// dev/test/summary-flap.test.mjs
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
const failed = (data, ageMs) => ({ data, at: NOW - ageMs, unavailable: true, failedAt: NOW - 100 });

test('one failed asic-summary with the last good data 5 s old does not change the headline', () => {
  const ok = safetyModel(base({ summaries: { [B]: { data: okSum(), at: NOW - 5000 } } }), NOW);
  const m = safetyModel(base({ summaries: { [B]: failed(okSum(), 5000) } }), NOW);
  assert.equal(m.head, ok.head);
  assert.ok(m.chips.some((c) => c.text === `${B}: summary unavailable (reason not exposed)`), 'the chip must still say unavailable at once');
});

test('same for a red FAULT headline: no "last known" while the data is within 2x the interval', () => {
  const ok = safetyModel(base({ summaries: { [B]: { data: okSum(trip), at: NOW - 5000 } } }), NOW);
  const m = safetyModel(base({ summaries: { [B]: failed(okSum(trip), 5000) } }), NOW);
  assert.equal(m.head, ok.head);
});

test('past 2x the interval a failed summary does raise STALE', () => {
  const m = safetyModel(base({ summaries: { [B]: failed(okSum(), 11_000) } }), NOW);
  assert.match(m.head, /^STALE · .* summary unavailable/);
});
