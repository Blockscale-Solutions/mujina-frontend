// #102 (slice of #81): what hovering, tapping or focusing a heatmap cell shows.
// Synthetic data only (spec hard rule 11).
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { devicePixelRatio: 1 };
const { asicDetail } = await import('../../ui/js/asic-detail.js');
const { cellAt } = await import('../../ui/js/render/heatmap.js');

const board = {
  temperatures: [{ name: 'ttyMOCK10-asic-7-dts', temperature_c: 63.51 }, { name: 'ttyMOCK00-asic-7-dts', temperature_c: 40 }],
  powers: [0, 1, 2].map((k) => ({ name: `ttyMOCK10-asic-7-vs-ch${k}`, voltage_v: [0.34325, 0.3479, 0.0106][k], current_a: null, power_w: null })),
  asics: [{ id: 7, thread_index: 1, faults: { thermal_trip: false, thermal_fault: true, voltage_fault: false, voltage_shutdown: false } },
    { id: 7, thread_index: 0, faults: { thermal_trip: true } }],
  bzm2_tuning: { asics: [{ id: 7, thread_index: 1, throughput_hs: 222222222222, scheduler_share_count: 89,
    results: { decoded: 121, accepted: 89, invalid_nonce: 0, unknown_engine: 0, no_dispatch: 0, stale_sequence: 1, below_target: 31 } },
  { id: 7, thread_index: 0, throughput_hs: 1, scheduler_share_count: 1, results: { accepted: 1 } }] },
};
const text = (d) => [d.title, ...d.rows.map(([k, v]) => `${k}: ${v}`), d.footer].join('\n');

test('#102 a cell shows its own bus and thread: temperature, VS channels in mV, work and faults', () => {
  const d = asicDetail(board, { tty: 'ttyMOCK10', threadIndex: 1 }, 7, { at: 1_000_000, cls: 'live' });
  const t = text(d);
  for (const s of ['ttyMOCK10', 'thread 1', 'wire 7', '63.5 °C', 'VS ch0: 343.3 mV', 'VS ch1: 347.9 mV', 'VS ch2: 10.6 mV',
    '222.22 GH/s', 'accepted 89', 'decoded 121', 'below target 31', 'stale sequence 1', 'scheduler shares: 89', 'thermal_fault']) // synthetic, MJ-TEST-00
    assert.ok(t.includes(s), `${s} missing:\n${t}`);
  assert.doesNotMatch(t, /thermal_trip/, 'another bus\'s wire 7 leaked in');
  assert.match(d.footer, /no per-reading age/);
});

test('#102 without a thread for the bus, work and faults are not joined, and it says why', () => {
  const t = text(asicDetail(board, { tty: 'ttyMOCK10', threadIndex: null }, 7, { at: 1, cls: 'live' }));
  assert.match(t, /63\.5 °C/);
  assert.match(t, /not joined: bus map unavailable/);
  assert.doesNotMatch(t, /accepted 89|thermal_fault/);
});

test('#102 missing values read "not reported", never 0; no faults reads "none asserted"', () => {
  const t = text(asicDetail({ asics: [{ id: 3, thread_index: 1, faults: {} }] }, { tty: 'ttyMOCK10', threadIndex: 1 }, 3, { at: 1, cls: 'live' }));
  assert.match(t, /die temperature: not reported/);
  assert.match(t, /VS: not reported/);
  assert.match(t, /work: not reported/);
  assert.match(t, /faults: none asserted/);
  assert.doesNotMatch(t, /: 0\b/);
});

test('#102 a lost reply is labelled, never shown as live', () => {
  const d = asicDetail(board, { tty: 'ttyMOCK10', threadIndex: 1 }, 7, { at: 1_000_000, cls: 'lost' });
  assert.match(d.title, /lost/);
  assert.match(d.footer, /last known/);
});

test('#102 cellAt: the cell under a point, none in a gap or past the configured count', () => {
  // 100x100 canvas, 10x10: gap 1, cell 8.9.
  assert.equal(cellAt(5, 5, 100, 100, 10, 10, 100), 0);
  assert.equal(cellAt(95, 95, 100, 100, 10, 10, 100), 99);
  assert.equal(cellAt(15, 5, 100, 100, 10, 10, 100), 1);
  assert.equal(cellAt(0.5, 5, 100, 100, 10, 10, 100), null, 'the gap');
  assert.equal(cellAt(95, 95, 100, 100, 10, 10, 50), null, 'past configured');
  assert.equal(cellAt(-1, 5, 100, 100, 10, 10, 100), null);
});
