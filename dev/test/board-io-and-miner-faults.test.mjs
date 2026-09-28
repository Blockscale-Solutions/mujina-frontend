// #10: board inlet and outlet temperatures (a safety field), under the API's
// own names, 'not reported' when absent. #62 (Ronald, 2026-09-25): during an
// asic-summary outage, a fault this browser saw rise in /miner asics[] turns
// the headline red, narrowly. Synthetic ttyMOCK data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';
installDom();
const { parseSensorName } = await import('../../ui/js/parse-sensors.js');
const { renderBoards } = await import('../../ui/js/render/boards.js');
const { safetyModel } = await import('../../ui/js/render/safety.js');
const store = await import('../../ui/js/store.js');
const B = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const NOW = 20_000_000;

function node() {
  const attrs = {}; const kids = []; const classes = new Set();
  return { kids, hidden: false, textContent: '', setAttribute(k, v) { attrs[k] = String(v); }, removeAttribute(k) { delete attrs[k]; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; }, appendChild(c) { kids.push(c); return c; }, removeChild(c) { kids.splice(kids.indexOf(c), 1); },
    get firstChild() { return kids[0] || null; }, classList: { toggle(c, on) { on ? classes.add(c) : classes.delete(c); }, contains: (c) => classes.has(c) } };
}
function root() {
  const card = node(); const parts = {};
  card.querySelector = (s) => (parts[s] ||= s.startsWith('canvas') ? Object.assign(node(), { getBoundingClientRect: () => ({ width: 100, height: 100 }), getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }) : node());
  const r = node(); r.querySelectorAll = () => [card]; return { r, parts };
}
const temps = [['board0-inlet', 33.5], ['board0-outlet', 48.5], ['board1-inlet', 33.5], ['board1-outlet', 51.5]].map(([name, t]) => ({ name, temperature_c: t }));
const board = (x = {}) => ({ name: B, model: 'BZM2', threads: [{ name: 'BZM2 UART 0', is_active: true }], temperatures: temps, ...x });
const draw = (b) => { const { r, parts } = root(); renderBoards(r, { layout: { rows: 10, cols: 10 }, metrics: null, chain: {}, apiDown: false, minerAt: NOW - 500, miner: { boards: [b] }, summaries: {} }, NOW); return parts['[data-board-io]']; };

test('#10 board inlet and outlet sensor names parse to their kind and index', () => {
  assert.deepEqual(parseSensorName('board0-inlet'), { kind: 'board-inlet', index: 0 });
  assert.deepEqual(parseSensorName('board2-outlet'), { kind: 'board-outlet', index: 2 });
});

test('#10 the card shows inlet and outlet under the API\'s own names, and "not reported" when absent', () => {
  const io = draw(board());
  assert.match(io.textContent, /board0 inlet 33\.5 °C/);
  assert.match(io.textContent, /board1 outlet 51\.5 °C/);
  assert.equal(draw(board({ temperatures: [] })).textContent, 'not reported');
});

// ---- #62 ----------------------------------------------------------------------
const flags = (x = {}) => ({ thermal_trip: false, thermal_fault: false, voltage_fault: false, voltage_shutdown: false, ...x });
const asics = (hot = null) => [0, 1, 2].flatMap((t) => [56, 57].map((id) => ({ id, thread_index: t, faults: flags(hot && hot.t === t && hot.id === id ? { [hot.bit]: true } : {}) })));
const miner = (hot) => ({ uptime_secs: 1000, paused: false, boards: [{ name: B, threads: [{ is_active: true }, { is_active: true }, { is_active: true }], asics: asics(hot) }] });
const live = () => ({ board: { faults: { availability: 'measured', bits: [] }, coverage: { asics_configured: 300, asics_reporting: 300 } } });
const model = (at) => safetyModel({ ...store.getState(), apiDown: false, apiDownSince: null, uptimeAdvancedAt: at - 500 }, at);

test('#62 a fault that rises in /miner asics[] during a summary outage turns the headline red, naming thread, wire and source', () => {
  store.setMiner(miner(), NOW - 10_000);
  store.setSummary(B, live(), NOW - 10_000);
  store.markSummaryFailed(B, NOW - 5000);
  store.setMiner(miner({ t: 2, id: 57, bit: 'thermal_fault' }), NOW - 2000);
  const m = model(NOW);
  assert.equal(m.sev, 'fault', m.head);
  assert.match(m.head, /FAULT BIT ASSERTED .* thermal_fault .* thread 2 wire 57 .* source \/miner asics\[\]/);
  assert.match(m.head, /first seen/);
});

test('#62 once a live summary returns, the summary is the only source again', () => {
  store.setSummary(B, live(), NOW - 1000);
  const m = model(NOW);
  assert.notEqual(m.sev, 'fault', m.head);
});
