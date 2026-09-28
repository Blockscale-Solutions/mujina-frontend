// AGENTS.md: a fault is never dimmed away. PR #77 review (2026-09-28): the
// stale wash and the card-wide dim covered live /miner fault outlines, and
// lost text used the graphic unknown colour (3.01:1, under hard rule 9).
// Synthetic data only (spec hard rule 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = { devicePixelRatio: 1 };
const { drawHeatmap } = await import('../../ui/js/render/heatmap.js');

function recordingCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k in ctx_state ? ctx_state[k] : (...a) => calls.push({ op: k, a, style: ctx_state.fillStyle, stroke: ctx_state.strokeStyle })),
    set: (_, k, v) => { ctx_state[k] = v; return true; },
  });
  const ctx_state = {};
  return { calls, canvas: { getBoundingClientRect: () => ({ width: 100, height: 100 }), getContext: () => ctx } };
}

test('fault outlines are stroked after the stale wash, at full colour', () => {
  const { calls, canvas } = recordingCanvas();
  drawHeatmap(canvas, { cells: [{ bus: 0, wireId: 2, temp: 60, fault: true }, { bus: 0, wireId: 3, temp: 61 }], stale: true });
  const wash = calls.findIndex((c) => c.op === 'fillRect' && c.style === 'rgba(154,148,138,0.25)');
  const fault = calls.map((c, i) => (c.op === 'strokeRect' && c.stroke === '#dc2626' ? i : -1)).filter((i) => i >= 0);
  assert.ok(wash >= 0, 'the stale wash was drawn (instrument check)');
  assert.equal(fault.length, 1, 'one fault outline');
  assert.ok(fault[0] > wash, `fault outline at call ${fault[0]} is under the wash at call ${wash}`);
});

const css = fs.readFileSync(new URL('../../ui/css/app.css', import.meta.url), 'utf8');

test('the stale card dim leaves the heatmap (and its fault outlines) undimmed', () => {
  const rule = css.match(/\.board-card\.stale\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /opacity|filter/, 'opacity or filter on the whole card also dims the heatmap');
  assert.match(css, /\.board-card\.stale\s*>\s*:not\(\.heatmap-wrap\)\s*\{[^}]*filter/, 'the dim applies to the non-heatmap parts');
});

test('lost text uses the unknown TEXT token and is not faded', () => {
  assert.match(css, /\[data-lost\]\s*\{[^}]*color:\s*var\(--st-unknown-text\)/);
  const kpiLost = css.match(/\.kpi-value\.lost\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(kpiLost, /opacity/);
});
