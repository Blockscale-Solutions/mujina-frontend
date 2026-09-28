// #17: the heatmap outlines the hottest and coldest die the asic-summary
// names, never extremes the browser computed from /miner rows (spec hard
// rule 4). Synthetic data only (spec hard rule 11).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { devicePixelRatio: 1 };
const { drawHeatmap, summaryExtremes } = await import('../../ui/js/render/heatmap.js');
const HOT = '#E86A2B', COLD = '#3b82f6';

function recordingCanvas() {
  const calls = [];
  const st = {};
  const ctx = new Proxy({}, {
    get: (_, k) => (k in st ? st[k] : (...a) => calls.push({ op: k, a, stroke: st.strokeStyle })),
    set: (_, k, v) => { st[k] = v; return true; },
  });
  return { calls, canvas: { getBoundingClientRect: () => ({ width: 100, height: 100 }), getContext: () => ctx } };
}
// The 10x10 geometry drawHeatmap uses for a 100x100 canvas.
const cellXY = (i) => { const cw = (100 - 11) / 10; return [1 + (i % 10) * (cw + 1) + 0.5, 1 + Math.floor(i / 10) * (cw + 1) + 0.5]; };
const strokesAt = (calls, colour) => calls.filter((c) => c.op === 'strokeRect' && c.stroke === colour).map((c) => c.a.slice(0, 2));
const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const frozen = [{ bus: 0, wireId: 7, temp: 95 }, { bus: 0, wireId: 99, temp: 67.3 }, { bus: 0, wireId: 3, temp: 50 }];

test('#17 the hottest outline is on the summary hottest cell, not a frozen /miner row', () => {
  const { calls, canvas } = recordingCanvas();
  drawHeatmap(canvas, { cells: frozen, hottest: { wireId: 99 }, coldest: { wireId: 3 } });
  const hot = strokesAt(calls, HOT);
  assert.equal(hot.length, 1, `one hottest outline: ${JSON.stringify(hot)}`);
  assert.ok(near(hot[0], cellXY(99)), `hottest outline at ${hot[0]}, cell 99 is at ${cellXY(99)}`);
  assert.ok(!near(hot[0], cellXY(7)), 'outlined the frozen 95 °C row');
  assert.ok(near(strokesAt(calls, COLD)[0], cellXY(3)));
});

test('#17 no summary extremes: no hottest or coldest outline at all', () => {
  const { calls, canvas } = recordingCanvas();
  drawHeatmap(canvas, { cells: frozen });
  assert.equal(strokesAt(calls, HOT).length, 0, 'the browser computed a hottest');
  assert.equal(strokesAt(calls, COLD).length, 0, 'the browser computed a coldest');
});

test('#17 summary extremes resolve to this bus only, and not when lost or unplaced', () => {
  const agg = { hottest: { wire_asic_id: 99, thread_index: 0, temperature_c: 67.3 }, coldest: { wire_asic_id: 3, thread_index: 0, temperature_c: 50 } };
  assert.deepEqual(summaryExtremes(agg, 0, false), { hottest: { wireId: 99 }, coldest: { wireId: 3 } });
  assert.deepEqual(summaryExtremes(agg, 1, false), { hottest: null, coldest: null }, 'another bus');
  assert.deepEqual(summaryExtremes(agg, 0, true), { hottest: null, coldest: null }, 'a lost summary');
  assert.deepEqual(summaryExtremes({ hottest: { asic_id: 99, temperature_c: 67.3 } }, 0, false), { hottest: null, coldest: null }, 'no wire id: not placed by guess');
  assert.deepEqual(summaryExtremes(null, 0, false), { hottest: null, coldest: null });
  // A single-bus board with no bus map: the extreme has no thread to disagree with.
  assert.deepEqual(summaryExtremes({ hottest: { wire_asic_id: 5 } }, null, false), { hottest: { wireId: 5 }, coldest: null });
});
