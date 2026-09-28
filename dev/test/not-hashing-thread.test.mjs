// #5: the thermal interlock holds one chain (one thread); any inactive thread
// raises NOT HASHING and gets its own chip naming it. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';
installDom();
const { safetyModel } = await import('../../ui/js/render/safety.js');
const B = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const NOW = 10_000_000;
const sum = { board: { faults: { availability: 'measured', bits: [] }, coverage: { asics_configured: 300, asics_reporting: 300 } } };
const state = (threads) => ({ miner: { uptime_secs: 1000, paused: false, boards: [{ name: B, threads }] }, minerAt: NOW - 1000,
  apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000, summaries: { [B]: { data: sum, at: NOW - 1000 } } });

test('#5 one held thread of three raises NOT HASHING and names that thread', () => {
  const m = safetyModel(state([{ name: 'BZM2 UART 0', is_active: true }, { name: 'BZM2 UART 1', is_active: true }, { name: 'BZM2 UART 2', is_active: false }]), NOW);
  assert.match(m.head, /NOT HASHING/);
  assert.ok(m.chips.some((c) => /BZM2 UART 2/.test(c.text) && /not hashing/.test(c.text)), JSON.stringify(m.chips));
  assert.ok(!m.chips.some((c) => /BZM2 UART 0.*not hashing/.test(c.text)));
});

test('#5 all threads active: no NOT HASHING', () => {
  const m = safetyModel(state([{ name: 'BZM2 UART 0', is_active: true }, { name: 'BZM2 UART 1', is_active: true }]), NOW);
  assert.doesNotMatch(m.head, /NOT HASHING/);
});
