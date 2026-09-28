// dev/test/fault-latch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';
installDom();
const { safetyModel } = await import('../../ui/js/render/safety.js');
const store = await import('../../ui/js/store.js');
const B = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const NOW = 10_000_000;
const miner = { uptime_secs: 1000, paused: false, boards: [{ name: B, threads: [{ is_active: true }] }] };
const trip = [{ bit: 'thermal_trip', asics_asserting: 1, asic_ids: [42], asic_ids_omitted: 0 }];

test('a successful reply with bits:null after a measured thermal_trip keeps a red "last known" headline', () => {
  store.setSummary(B, { board: { faults: { availability: 'measured', bits: trip }, coverage: { asics_configured: 300, asics_reporting: 300 } } }, NOW - 6000);
  store.setSummary(B, { board: { faults: { availability: 'not_retained', bits: null },
    coverage: { asics_configured: 300, asics_reporting: 0, asics_stale: 300, asics_value_suppressed: 0, asics_never_seen: 0 } } }, NOW - 1000);
  const m = safetyModel({ ...store.getState(), miner, apiDown: false, uptimeAdvancedAt: NOW - 1000 }, NOW);
  assert.equal(m.sev, 'fault', m.head);
  assert.match(m.head, /thermal_trip( \[[\d,]+\])? · last known/); // #16 adds the ids
});

test('#54 a later summary that MEASURES the bit clear ends the latch', () => {
  store.setSummary(B, { board: { faults: { availability: 'measured', bits: trip }, coverage: { asics_configured: 300, asics_reporting: 300 } } }, NOW - 6000);
  store.setSummary(B, { board: { faults: { availability: 'measured', bits: [] }, coverage: { asics_configured: 300, asics_reporting: 300 } } }, NOW - 1000);
  const m = safetyModel({ ...store.getState(), miner, apiDown: false, uptimeAdvancedAt: NOW - 1000 }, NOW);
  assert.notEqual(m.sev, 'fault', m.head);
});
