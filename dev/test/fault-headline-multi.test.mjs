// #16: the FAULT headline names every asserting (board, bit, ids) in API
// order, up to three then '+N more', and '+K omitted' when the API omits ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';
installDom();
const { safetyModel } = await import('../../ui/js/render/safety.js');
const NOW = 10_000_000;
const A = 'bzm2-ttyMOCK00', B2 = 'bzm2-ttyMOCK10';
const sum = (bits) => ({ board: { faults: { availability: 'measured', bits }, coverage: { asics_configured: 100, asics_reporting: 100 } } });
const state = (summaries) => ({ miner: { uptime_secs: 1000, paused: false, boards: [{ name: A, threads: [{ is_active: true }] }, { name: B2, threads: [{ is_active: true }] }] },
  minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000, summaries });

test('#16 every asserting board, bit and ids are named, in API order', () => {
  const m = safetyModel(state({
    [A]: { data: sum([{ bit: 'thermal_trip', asics_asserting: 1, asic_ids: [99], asic_ids_omitted: 0 }, { bit: 'thermal_fault', asics_asserting: 3, asic_ids: [2, 3, 4], asic_ids_omitted: 0 }]), at: NOW - 1000 },
    [B2]: { data: sum([{ bit: 'voltage_shutdown', asics_asserting: 1, asic_ids: [7], asic_ids_omitted: 0 }]), at: NOW - 1000 },
  }), NOW);
  assert.equal(m.sev, 'fault');
  for (const s of [A, 'thermal_trip', '99', 'thermal_fault', '2,3,4', B2, 'voltage_shutdown']) assert.ok(m.head.includes(s), `${s} missing: ${m.head}`);
  assert.ok(m.head.indexOf('thermal_trip') < m.head.indexOf('thermal_fault') && m.head.indexOf('thermal_fault') < m.head.indexOf('voltage_shutdown'), m.head);
});

test('#16 more than three faults end in "+N more"; omitted ids are counted', () => {
  const bits = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ bit: `bit_${x}`, asics_asserting: 1, asic_ids: [i], asic_ids_omitted: i === 0 ? 8 : 0 }));
  const m = safetyModel(state({ [A]: { data: sum(bits), at: NOW - 1000 } }), NOW);
  assert.match(m.head, /\+2 more/);
  assert.match(m.head, /\+8 omitted/);
  assert.ok(m.chips.some((c) => /bit_a.*\+8 omitted/.test(c.text)), m.chips.map((c) => c.text).join(' | '));
});

test('#16 a live fault beside a last-known one: only the last-known entry is marked last known', () => {
  const m = safetyModel(state({
    [A]: { data: sum([{ bit: 'thermal_trip', asics_asserting: 1, asic_ids: [99], asic_ids_omitted: 0 }]), at: NOW - 1000 },
    [B2]: { data: sum([{ bit: 'voltage_shutdown', asics_asserting: 1, asic_ids: [7], asic_ids_omitted: 0 }]), at: NOW - 90_000, unavailable: true, failedAt: NOW - 1000 },
  }), NOW);
  assert.equal(m.sev, 'fault', m.head);
  const live = m.head.slice(0, m.head.indexOf('voltage_shutdown'));
  assert.ok(!/last known/.test(live), `the live thermal_trip reads as last known: ${m.head}`);
  assert.match(m.head, /voltage_shutdown \[7\] \(last known [^)]+\)/);
});
