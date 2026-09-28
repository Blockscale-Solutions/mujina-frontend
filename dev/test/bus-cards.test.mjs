// Issue #32 (+ the minimum of #7/#9 it needs): with the real shape (one board
// object spanning three buses) the UI must render one card per bus and join
// asics[] faults on (thread_index -> bus, id), never on wire id alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandSeed } from '../gen-scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOARD = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const TTYS = ['ttyMOCK00', 'ttyMOCK10', 'ttyMOCK20'];

// ---- minimal recording DOM -------------------------------------------------
function node(tag = 'div') {
  const kids = [];
  const attrs = Object.create(null);
  const classes = new Set();
  const e = {
    tag, kids, hidden: false, textContent: '',
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(c) { kids.push(c); return c; },
    removeChild(c) { kids.splice(kids.indexOf(c), 1); return c; },
    get firstChild() { return kids[0] || null; },
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
  };
  return e;
}
function canvas() {
  const c = node('canvas');
  c.ops = [];
  c.getBoundingClientRect = () => ({ width: 100, height: 100 });
  c.getContext = () => new Proxy({}, {
    get(_, k) {
      if (k === 'fillRect') return (...a) => c.ops.push({ op: 'fillRect', fill: c.fill, a });
      if (k === 'strokeRect') return (...a) => c.ops.push({ op: 'strokeRect', stroke: c.stroke, a });
      return () => {};
    },
    set(_, k, v) { if (k === 'fillStyle') c.fill = v; if (k === 'strokeStyle') c.stroke = v; return true; },
  });
  return c;
}
function card() {
  const e = node('article');
  const parts = Object.create(null);
  e.querySelector = (sel) => (parts[sel] ||= sel.startsWith('canvas') ? canvas() : node());
  e.cloneNode = () => card();
  e.parts = parts;
  return e;
}
function boardsRoot(n = 3) {
  const r = node('div');
  const cards = Array.from({ length: n }, () => card());
  cards.slice(1).forEach((c) => { c.hidden = true; });
  r.querySelectorAll = () => cards.slice();
  r.appendChild = (c) => { cards.push(c); return c; };
  r.cards = cards;
  return r;
}
globalThis.document = { createElement: (t) => node(t), querySelector: () => null };
globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: true }) };

const { busPanels, cellsByBus, busMapFor } = await import('../../ui/js/buses.js');
const { renderBoards } = await import('../../ui/js/render/boards.js');

function realState() {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev/fixtures/nominal-3b/seed.json'), 'utf8'));
  const { miner, summaries } = expandSeed(seed);
  const now = Date.now();
  return {
    miner, minerAt: now,
    summaries: { [BOARD]: { data: summaries[BOARD].asic, at: now } },
    chain: { [BOARD]: { data: summaries[BOARD].chain, at: now } },
    layout: { rows: 10, cols: 10, asics_per_board: 100 },
    metrics: null,
  };
}

const FAULTS = { thermal_trip: false, thermal_fault: false, voltage_fault: false, voltage_shutdown: false };
/** Synthetic real-shape board: dts rows ttyMOCK20/10 interleaved first, ttyMOCK00 last. */
function syntheticBoard() {
  const temperatures = [];
  for (let w = 0; w < 100; w++) for (const t of ['ttyMOCK20', 'ttyMOCK10']) {
    temperatures.push({ name: `${t}-asic-${w}-dts`, temperature_c: (t === 'ttyMOCK20' ? 70 : 60) + w / 100 });
  }
  for (let w = 0; w < 100; w++) temperatures.push({ name: `ttyMOCK00-asic-${w}-dts`, temperature_c: 50 + w / 100 });
  const asics = [];
  for (let ti = 0; ti < 3; ti++) for (let id = 0; id < 100; id++) asics.push({ id, thread_index: ti, faults: FAULTS });
  asics.find((a) => a.thread_index === 0 && a.id === 5).faults = { ...FAULTS, thermal_fault: true };
  return {
    name: BOARD, model: 'BZM2', fans: [], temperatures, powers: [],
    threads: [0, 1, 2].map((i) => ({ name: `BZM2 UART ${i}`, hashrate: 1, is_active: true })), asics,
  };
}
const CHAIN_BUSES = TTYS.map((t, i) => ({ thread_index: i, serial_path: `/dev/${t}`, asic_start: i * 100, asic_count: 100 }));

test('join on (thread_index -> bus, id): 300 distinct cells, the fault lands on (ttyMOCK00, 5) only', () => {
  const board = syntheticBoard();
  const map = busMapFor({ chain: { [BOARD]: { data: { buses: CHAIN_BUSES } } } }, BOARD);
  const { byBus, unjoined } = cellsByBus(board, map);
  const all = [...byBus.values()].flat();
  assert.equal(all.length, 300);
  assert.equal(new Set(all.map((c) => `${c.bus}#${c.wireId}`)).size, 300);
  assert.ok(all.every((c) => c.temp != null), 'a die lost its temperature');
  const flagged = all.filter((c) => c.fault);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].bus, 'ttyMOCK00');
  assert.equal(flagged[0].wireId, 5);
  assert.equal(flagged[0].temp, 50.05);
  assert.equal(unjoined.length, 0);
});

test('bus map from asic-summary buses[] works when chain-summary is absent', () => {
  const board = syntheticBoard();
  const buses = CHAIN_BUSES.map(({ asic_count, ...b }) => ({ ...b, thread_active: true, aggregate: null }));
  const map = busMapFor({ summaries: { [BOARD]: { data: { buses } } } }, BOARD);
  const flagged = [...cellsByBus(board, map).byBus.values()].flat().filter((c) => c.fault);
  assert.deepEqual(flagged.map((c) => [c.bus, c.wireId]), [['ttyMOCK00', 5]]);
});

test('no bus map on a 3-bus board: no cell is guessed, the fault is reported as unplaced', () => {
  const { byBus, unjoined } = cellsByBus(syntheticBoard(), new Map());
  assert.equal([...byBus.values()].flat().filter((c) => c.fault).length, 0);
  assert.equal(unjoined.length, 1);
});

test('real-shape seed: busPanels gives 3 bus panels with per-bus stats, threads and 100 cells each', () => {
  const state = realState();
  const panels = busPanels(state);
  assert.equal(panels.length, 3);
  const sum = state.summaries[BOARD].data;
  panels.forEach((p, i) => {
    assert.equal(p.boardName, BOARD);
    assert.equal(p.tty, TTYS[i]);
    assert.equal(p.threadIndex, i);
    assert.equal(p.serialPath, `/dev/${TTYS[i]}`);
    assert.deepEqual(p.threads.map((t) => t.name), [`BZM2 UART ${i}`]);
    assert.equal(p.cells.length, 100);
    assert.deepEqual(p.cells.map((c) => c.wireId), [...Array(100).keys()]);
    assert.ok(p.cells.every((c) => c.bus === TTYS[i]));
    assert.deepEqual(p.aggregate.die_temperature_c, sum.buses[i].aggregate.die_temperature_c);
    assert.equal(p.configured, 100);
  });
});

test('before chain/asic-summary arrive, panels still come from the dts prefixes (thread unknown)', () => {
  const state = realState();
  state.summaries = {};
  state.chain = {};
  const panels = busPanels(state);
  assert.deepEqual(panels.map((p) => [p.tty, p.threadIndex]), TTYS.map((t) => [t, null]));
});

test('renderBoards: three visible bus cards, none says waiting, 300 dies drawn, fault drawn once', () => {
  const state = realState();
  state.miner.boards[0] = { ...syntheticBoard(), fans: state.miner.boards[0].fans };
  const root = boardsRoot(3);
  renderBoards(root, state);
  const visible = root.cards.filter((c) => !c.hidden);
  assert.equal(visible.length, 3);
  const names = visible.map((c) => c.parts['[data-board-name]'].textContent);
  // Ronald, 2026-09-28: the header is just "Board N"; the rest goes to the tooltip.
  assert.deepEqual(names, ['Board 0', 'Board 1', 'Board 2']);
  const titles = visible.map((c) => c.parts['[data-board-name]'].getAttribute('title') || '');
  assert.match(titles[1], /ttyMOCK10 · thread 1/, 'the full identity stays in the tooltip');
  assert.equal(visible[0].parts['[data-board-model]'].textContent, '', 'no second, repeated header line');
  for (const c of visible) {
    const texts = Object.values(c.parts).map((p) => p.textContent).join(' | ');
    assert.doesNotMatch(texts, /waiting/);
  }
  const cellFills = visible.map((c) => c.parts['canvas[data-heatmap]'].ops
    .filter((o) => o.op === 'fillRect' && /^rgb\(/.test(o.fill)).length);
  assert.deepEqual(cellFills, [100, 100, 100], 'every die drawn on its own bus grid');
  const faultMarks = visible.map((c) => c.parts['canvas[data-heatmap]'].ops
    .filter((o) => o.op === 'strokeRect' && o.stroke === '#dc2626').length);
  assert.deepEqual(faultMarks, [1, 0, 0], 'fault outline must be on bus ttyMOCK00 only');
});

test('three board objects of one bus each (possible future RDS shape) also give 3 bus cards; 4 give 4', () => {
  const state = realState();
  const [real] = state.miner.boards;
  const split = TTYS.map((t, i) => ({
    name: `bzm2-${t}`, model: 'BZM2', fans: [],
    temperatures: real.temperatures.filter((r) => r.name.startsWith(`${t}-`)),
    threads: [real.threads[i]],
    asics: real.asics.filter((a) => a.thread_index === i).map((a) => ({ ...a, thread_index: 0 })),
  }));
  const four = [...split, { name: 'bzm2-ttyMOCK30', model: 'BZM2', fans: [], temperatures: [{ name: 'ttyMOCK30-asic-0-dts', temperature_c: 50 }], threads: [], asics: [] }];
  for (const boards of [split, four]) {
    const s = { ...state, miner: { ...state.miner, boards }, summaries: {}, chain: {} };
    const root = boardsRoot(3);
    renderBoards(root, s);
    const visible = root.cards.filter((c) => !c.hidden);
    assert.equal(visible.length, boards.length);
    assert.deepEqual(visible.map((c) => c.parts['[data-board-name]'].textContent.split(' ')[0]),
      boards.map((b) => b.name.replace(/^bzm2-/, '')));
  }
});

test('no /miner yet: one card says waiting, the rest stay hidden', () => {
  const root = boardsRoot(3);
  renderBoards(root, { miner: null, summaries: {}, chain: {} });
  assert.deepEqual(root.cards.map((c) => c.hidden), [false, true, true]);
  assert.match(root.cards[0].parts['[data-board-name]'].textContent, /waiting/);
});
