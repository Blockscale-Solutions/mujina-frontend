// Issues #14 and #56, with Ronald's lost-tiles decision (2026-09-25):
// - A value more than 60 s old, or read while the API is down, is LOST (hard
//   rule 6). It is replaced by "—" (U+2014), and the last value with its
//   browser receipt time appears only in a tooltip (`title`).
// - Board-card freshness comes from that board's own asic-summary receipt
//   time. It never falls back to the /miner time, so no summary means lost.
// - One summaryState is shared by the safety strip and the board cards, so
//   the page gives one answer per board (#56). A failing summary reports its
//   age class and the failure side by side, and reaches lost at 60 s.
// - Hashrate, shares and uptime (scheduler fields) turn lost when uptime has
//   been frozen for over 60 s, or the last /miner reply is over 60 s old, or
//   the API is down. The headline keeps the scheduler STALE text.
// - A FAULT headline always wins over stale and lost.
// Synthetic ttyMOCK data only (spec hard rule 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, el } from './dom-stub.mjs';

installDom();
const { safetyModel } = await import('../../ui/js/render/safety.js');
const { renderBoards } = await import('../../ui/js/render/boards.js');
const { renderKpi } = await import('../../ui/js/render/kpi.js');
const { summaryState } = await import('../../ui/js/freshness.js');

const DASH = '\u2014';
const B = 'bzm2-ttyMOCK00';
const NOW = 10_000_000;
const threads = [{ name: 'BZM2 UART 0', hashrate: 1, is_active: true }];
const miner = (x = {}) => ({ uptime_secs: 1000, paused: false, hashrate: 5e14, shares_submitted: 50, boards: [{ name: B, model: 'BZM2', threads }], ...x });
const summary = (bits = []) => ({ board: {
  faults: { availability: 'measured', bits },
  coverage: { asics_configured: 100, asics_reporting: 100, reading_age: { oldest_included_secs: 4 } },
  die_temperature_c: { min: 62.2, mean: 64.6, max: 67.3, spread: 5.1 },
} });
const trip = [{ bit: 'thermal_trip', asics_asserting: 1, asic_ids: [42], asic_ids_omitted: 0 }];

// ---- recording DOM for one board card --------------------------------------
function node(tag = 'span') {
  const attrs = Object.create(null);
  const classes = new Set();
  const kids = [];
  return {
    tag, kids, hidden: false, textContent: '',
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(c) { kids.push(c); return c; },
    removeChild(c) { kids.splice(kids.indexOf(c), 1); return c; },
    get firstChild() { return kids[0] || null; },
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
  };
}
function card() {
  const e = node('article');
  const parts = Object.create(null);
  e.querySelector = (sel) => (parts[sel] ||= sel.startsWith('canvas')
    ? Object.assign(node('canvas'), { getBoundingClientRect: () => ({ width: 100, height: 100 }), getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) })
    : node());
  e.parts = parts;
  return e;
}
function boardsRoot() {
  const r = node('div');
  const cards = [card()];
  r.querySelectorAll = () => cards.slice();
  r.cards = cards;
  return r;
}
const DIE = ['[data-die-min]', '[data-die-mean]', '[data-die-max]', '[data-die-spread]'];
const LAST = { '[data-die-min]': '62.2', '[data-die-mean]': '64.6', '[data-die-max]': '67.3', '[data-die-spread]': '5.1' };

function drawCard(state, now = NOW) {
  const root = boardsRoot();
  renderBoards(root, { layout: { rows: 10, cols: 10, asics_per_board: 100 }, metrics: null, chain: {}, apiDown: false, ...state }, now);
  return root.cards[0].parts;
}

// ---- #14 ---------------------------------------------------------------------
test('#14 test 1: a summary 70 s old prints "—" for every die value, the last value is in the title, the legend reads lost', () => {
  const p = drawCard({ miner: miner(), minerAt: NOW - 1000, summaries: { [B]: { data: summary(), at: NOW - 70_000 } } });
  for (const sel of DIE) {
    assert.equal(p[sel].textContent, DASH, `${sel} printed ${p[sel].textContent}`);
    assert.match(p[sel].getAttribute('title') || '', new RegExp(LAST[sel].replace('.', '\\.')), `${sel} title`);
    assert.match(p[sel].getAttribute('title') || '', /browser time/, `${sel} title names the receipt clock`);
  }
  assert.match(p['[data-heatmap-legend]'].textContent, /\blost\b/);
});

test('#14 test 2: a fresh /miner and no summary ever served: the legend does not read live, and no die value is shown', () => {
  const p = drawCard({ miner: miner(), minerAt: NOW - 500, summaries: {} });
  assert.doesNotMatch(p['[data-heatmap-legend]'].textContent, /\blive\b/);
  assert.match(p['[data-heatmap-legend]'].textContent, /no summary yet/);
  for (const sel of DIE) assert.equal(p[sel].textContent, DASH);
});

test('#14 a stale (not lost) summary keeps its values, marked "stale N s", with no tooltip-only value', () => {
  const p = drawCard({ miner: miner(), minerAt: NOW - 1000, summaries: { [B]: { data: summary(), at: NOW - 20_000 } } });
  assert.equal(p['[data-die-mean]'].textContent, '64.6 °C');
  assert.equal(p['[data-die-mean]'].getAttribute('data-stale'), 'stale 20 s');
  assert.equal(p['[data-die-mean]'].getAttribute('data-lost'), null);
  assert.match(p['[data-heatmap-legend]'].textContent, /stale 20 s/);
});

test('#14 a live summary clears every lost and stale mark left by the previous render', () => {
  const root = boardsRoot();
  const base = { layout: { rows: 10, cols: 10 }, metrics: null, chain: {}, apiDown: false, miner: miner(), minerAt: NOW };
  renderBoards(root, { ...base, summaries: { [B]: { data: summary(), at: NOW - 70_000 } } }, NOW);
  renderBoards(root, { ...base, summaries: { [B]: { data: summary(), at: NOW - 1000 } } }, NOW);
  const v = root.cards[0].parts['[data-die-max]'];
  assert.equal(v.textContent, '67.3 °C');
  assert.equal(v.getAttribute('title'), null);
  assert.equal(v.getAttribute('data-lost'), null);
  assert.equal(v.getAttribute('data-stale'), null);
  assert.match(root.cards[0].parts['[data-heatmap-legend]'].textContent, /· live/);
});

test('#14, amended by Ronald on #90 (D2): while /miner is down, a summary its own endpoint still answers keeps its own freshness', () => {
  const p = drawCard({ miner: miner(), minerAt: NOW - 5000, apiDown: true, apiDownSince: NOW - 3000, summaries: { [B]: { data: summary(), at: NOW - 3000 } } });
  assert.equal(p['[data-die-min]'].textContent, '62.2 °C');
  assert.doesNotMatch(p['[data-heatmap-legend]'].textContent, /\blost\b/);
});

// ---- #56 ---------------------------------------------------------------------
test('#56 issue test: a summary failing with its last good data 90 s old is shown as lost', () => {
  const m = safetyModel({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000,
    summaries: { [B]: { data: summary(), at: NOW - 90_000, unavailable: true, failedAt: NOW - 1000 } } }, NOW);
  assert.ok(m.chips.some((c) => c.text === `${B}: lost`), m.chips.map((c) => c.text).join(' | '));
  assert.match(m.head, /lost/);
});

test('#56 the failure and the age class are reported side by side', () => {
  const m = safetyModel({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000,
    summaries: { [B]: { data: summary(), at: NOW - 90_000, unavailable: true, failedAt: NOW - 1000 } } }, NOW);
  const texts = m.chips.map((c) => c.text);
  assert.ok(texts.includes(`${B}: summary unavailable (reason not exposed)`), texts.join(' | '));
  assert.ok(texts.includes(`${B}: lost`), texts.join(' | '));
  assert.equal(m.head, `STALE · ${B} summary lost · fault bits not current`);
});

test('#56 strip and card agree on a failing summary: lost after 60 s, stale past two polls, live within them (#90 hysteresis)', () => {
  // Ronald on #90 (2026-09-28) amends spec :93: a failed poll is a flap, not
  // a state; the age decides, so data within two polls stays live, while the
  // legend and chip say "summary unavailable" at once.
  for (const [ageMs, wantAge, wantCard] of [[90_000, 'lost', 'lost'], [20_000, 'stale', 'stale'], [4_000, 'live', 'live']]) {
    const entry = { data: summary(), at: NOW - ageMs, unavailable: true, failedAt: NOW - 1000 };
    const st = summaryState(entry, NOW, false);
    assert.equal(st.age, wantAge);
    assert.equal(st.unavailable, true);
    assert.equal(st.live, wantAge === 'live');
    const p = drawCard({ miner: miner(), minerAt: NOW - 1000, summaries: { [B]: entry } });
    const legend = p['[data-heatmap-legend]'].textContent;
    assert.match(legend, new RegExp(`\\b${wantCard}\\b`), legend);
    assert.match(legend, /summary unavailable/);
    const m = safetyModel({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000, summaries: { [B]: entry } }, NOW);
    assert.ok(m.chips.some((c) => c.text === `${B}: summary unavailable (reason not exposed)`));
    if (wantAge !== 'live') assert.ok(m.chips.some((c) => c.text === `${B}: ${wantAge}`), m.chips.map((c) => c.text).join(' | '));
  }
});

test('#56 FAULT still wins: a lost, failing summary that last asserted thermal_trip keeps the red headline', () => {
  const m = safetyModel({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000,
    summaries: { [B]: { data: summary(trip), at: NOW - 90_000, unavailable: true, failedAt: NOW - 1000 } } }, NOW);
  assert.equal(m.sev, 'fault', m.head);
  assert.match(m.head, /^FAULT BIT ASSERTED · bzm2-ttyMOCK00 · thermal_trip( \[[\d,]+\])? · last known /); // #16 adds the ids
});

// ---- KPI lost (Ronald's decision on #14) --------------------------------------
function kpiRoot() {
  const root = el('kpi');
  root.children = {};
  const cells = {};
  for (const k of ['hashrate', 'shares', 'accept', 'pool', 'uptime', 'power']) {
    const v = node('div');
    cells[k] = v;
    cells[`${k}-note`] = node('div');
    root.children[`[data-kpi="${k}"]`] = v;
    root.children[`[data-kpi-note="${k}"]`] = cells[`${k}-note`];
  }
  return { root, cells };
}
const SCHED = ['hashrate', 'shares', 'uptime'];
const kstate = (o = {}) => ({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000, summaries: {}, sharesRate: null, ...o });

test('KPI: uptime frozen 61 s turns hashrate, shares and uptime lost, with the last value and receipt time in the title', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ uptimeAdvancedAt: NOW - 61_000 }), NOW);
  for (const k of SCHED) {
    assert.equal(cells[k].textContent, DASH, `${k} printed ${cells[k].textContent}`);
    assert.ok(cells[k].getAttribute('data-lost'), `${k} not marked lost`);
    assert.match(cells[k].getAttribute('title') || '', /last known .* received \d\d:\d\d:\d\d \(browser time\)/, `${k} title`);
  }
  assert.match(cells.hashrate.getAttribute('title'), /500\.00 TH\/s/);
  assert.match(cells.shares.getAttribute('title'), /last known 50\b/);
  assert.match(cells['hashrate-note'].textContent, /^lost/);
});

test('KPI: uptime frozen 30 s is stale, not lost (values kept, marked stale)', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ uptimeAdvancedAt: NOW - 30_000 }), NOW);
  assert.equal(cells.hashrate.textContent, '500.00 TH/s'); // synthetic figure, fictional case MJ-TEST-00
  assert.equal(cells.hashrate.getAttribute('data-stale'), 'stale 30 s');
  assert.equal(cells.hashrate.getAttribute('data-lost'), null);
  assert.equal(cells.hashrate.getAttribute('title'), null);
});

test('KPI: the last /miner reply over 60 s old turns the scheduler fields lost even if uptime last advanced then', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ minerAt: NOW - 61_000, uptimeAdvancedAt: NOW - 61_000 }), NOW);
  for (const k of SCHED) assert.equal(cells[k].textContent, DASH, k);
  assert.match(cells['uptime-note'].textContent, /no \/miner reply/);
});

test('KPI: API down turns the scheduler fields lost at once', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ apiDown: true, apiDownSince: NOW - 2000, minerAt: NOW - 8000 }), NOW);
  for (const k of SCHED) assert.equal(cells[k].textContent, DASH, k);
  assert.match(cells['hashrate-note'].textContent, /API not answering/);
});

test('KPI: recovery clears lost marks and the tooltip', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ uptimeAdvancedAt: NOW - 61_000 }), NOW);
  renderKpi(root, kstate({ miner: miner({ uptime_secs: 1070 }), uptimeAdvancedAt: NOW }), NOW);
  for (const k of SCHED) {
    assert.notEqual(cells[k].textContent, DASH, k);
    assert.equal(cells[k].getAttribute('title'), null, k);
    assert.equal(cells[k].getAttribute('data-lost'), null, k);
  }
});

test('headline: scheduler lost keeps the scheduler STALE text (Ronald: the headline keeps it)', () => {
  const m = safetyModel(kstate({ uptimeAdvancedAt: NOW - 61_000, summaries: { [B]: { data: summary(), at: NOW - 1000 } } }), NOW);
  assert.equal(m.head, 'STALE · scheduler not publishing · hashrate, shares and paused not current');
});

// ---- #90: follow-ups from the #77 review (2026-09-28) -------------------------
const { renderValue } = await import('../../ui/js/render/value-state.js');
const { renderFans } = await import('../../ui/js/render/fans.js');
const { hashrateHeader } = await import('../../ui/js/render/charts.js');
const { schedulerFieldsState } = await import('../../ui/js/freshness.js');
const base90 = { layout: { rows: 10, cols: 10 }, metrics: null, chain: {}, apiDown: false, minerAt: NOW };

test('#90 a board that leaves /miner turns its last values lost, never live', () => {
  const root = boardsRoot();
  renderBoards(root, { ...base90, miner: miner(), summaries: { [B]: { data: summary(), at: NOW - 1000 } } }, NOW);
  renderBoards(root, { ...base90, miner: miner({ boards: [] }), summaries: { [B]: { data: summary(), at: NOW - 1000 } } }, NOW + 5000);
  const p = root.cards[0].parts;
  for (const sel of DIE) {
    assert.equal(p[sel].textContent, DASH, `${sel} still printed ${p[sel].textContent}`);
    assert.match(p[sel].getAttribute('title') || '', new RegExp(LAST[sel].replace('.', '\\.')), `${sel} title keeps the last value`);
  }
  assert.match(p['[data-heatmap-legend]'].textContent, /not in \/miner/);
  assert.doesNotMatch(p['[data-heatmap-legend]'].textContent, /\blive\b/);
  assert.equal(root.cards[0].classList.contains('lost'), true);
  assert.equal(p['[data-threads]'].kids.length, 0, 'no thread rows for a board that is gone');
});

test('#78 #83 thread hashrate is SI-formatted, and lost with the API', () => {
  const t = [{ name: 'BZM2 UART 0', hashrate: 4e15, is_active: true }];
  const m = miner({ boards: [{ name: B, model: 'BZM2', threads: t }] });
  const live = drawCard({ miner: m, minerAt: NOW - 500, summaries: { [B]: { data: summary(), at: NOW - 500 } } });
  assert.equal(live['[data-threads]'].kids[0].kids[2].textContent, '4.00 PH/s'); // synthetic, MJ-TEST-00
  const down = drawCard({ apiDown: true, miner: m, minerAt: NOW - 70_000, summaries: {} });
  const h = down['[data-threads]'].kids[0].kids[2];
  assert.equal(h.textContent, DASH);
  assert.match(h.getAttribute('title') || '', /4\.00 PH\/s/);
});

test('#90 the "<board>: lost" chip is not the fault colour', () => {
  const m = safetyModel({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 1000,
    summaries: { [B]: { data: summary(), at: NOW - 70_000 } } }, NOW);
  const c = m.chips.find((x) => x.text === `${B}: lost`);
  assert.ok(c, 'the lost chip is present (instrument check)');
  assert.notEqual(c.sev, 'fault');
});

test('#90 strip and KPI give one answer: a scheduler frozen past 60 s is lost in the chip too', () => {
  const m = safetyModel({ miner: miner(), minerAt: NOW - 1000, apiDown: false, apiDownSince: null, uptimeAdvancedAt: NOW - 70_000,
    summaries: { [B]: { data: summary(), at: NOW - 1000 } } }, NOW);
  const c = m.chips.find((x) => /scheduler fields/.test(x.text));
  assert.ok(c, 'scheduler chip present');
  assert.match(c.text, /\blost\b/);
  assert.doesNotMatch(c.text, /\bstale\b/);
});

test('#90 a lost value is sanitised, reachable by keyboard, and keeps its last value in the aria text', () => {
  const e = node();
  renderValue(e, { text: 'stratum+tcp://u:p@pool.example.com:3333', cls: 'lost', asOf: NOW - 5000, now: NOW, cause: 'x' });
  assert.doesNotMatch(e.getAttribute('title'), /u:p@/);
  assert.doesNotMatch(e.getAttribute('aria-description'), /u:p@/);
  assert.equal(e.getAttribute('tabindex'), '0');
  renderValue(e, { text: '64.6 °C', cls: 'lost', asOf: NOW - 5000, now: NOW });
  assert.match(e.getAttribute('aria-description'), /64\.6/);
  renderValue(e, { text: '64.6 °C', cls: 'live', now: NOW });
  assert.equal(e.getAttribute('tabindex'), null);
});

test('#90 mark hygiene: .lost toggles, lost to stale clears the title, stale to lost clears data-stale, live clears the aria text', () => {
  const e = node();
  renderValue(e, { text: 'a', cls: 'lost', asOf: NOW - 1, now: NOW });
  assert.equal(e.classList.contains('lost'), true);
  renderValue(e, { text: 'a', cls: 'stale', staleText: 'stale 20 s', now: NOW });
  assert.equal(e.getAttribute('title'), null);
  assert.equal(e.classList.contains('lost'), false);
  renderValue(e, { text: 'a', cls: 'lost', asOf: NOW - 1, now: NOW });
  assert.equal(e.getAttribute('data-stale'), null);
  renderValue(e, { text: 'a', cls: 'live', now: NOW });
  assert.equal(e.getAttribute('aria-description'), null);
  assert.equal(e.getAttribute('data-lost'), null);
});

test('#90 lost hottest and coldest print "—", the oldest-included age is lost, and the card is classed', () => {
  const s = summary();
  s.board.hottest = { wire_asic_id: 7, temperature_c: 70.1 };
  s.board.coldest = { wire_asic_id: 3, temperature_c: 60.2 };
  const root = boardsRoot();
  renderBoards(root, { ...base90, miner: miner(), minerAt: NOW - 1000, summaries: { [B]: { data: s, at: NOW - 70_000 } } }, NOW);
  const p = root.cards[0].parts;
  assert.equal(p['[data-die-hot]'].textContent, `hottest: ${DASH}`);
  assert.match(p['[data-die-hot]'].getAttribute('title') || '', /70\.1/);
  assert.equal(p['[data-die-cold]'].textContent, `coldest: ${DASH}`);
  assert.match(p['[data-heatmap-legend]'].textContent, new RegExp(`oldest included ${DASH}`));
  assert.equal(root.cards[0].classList.contains('stale'), true);
  assert.equal(root.cards[0].classList.contains('lost'), true);
});

test('#90 the scheduler-field lost time is when uptime last advanced, not the last /miner reply', () => {
  const st = schedulerFieldsState({ apiDown: true, minerAt: NOW - 1000, uptimeAdvancedAt: NOW - 90_000 }, NOW);
  assert.equal(st.cls, 'lost');
  assert.equal(st.asOf, NOW - 90_000);
});

test('#90 an absent value that goes lost does not read "last known unknown"', () => {
  const e = node();
  renderValue(e, { text: 'unknown', cls: 'lost', asOf: NOW - 1000, now: NOW });
  assert.doesNotMatch(e.getAttribute('title'), /last known unknown/);
});

test('#90 a clock stepped backwards never prints a negative stale age', () => {
  const p = drawCard({ miner: miner(), minerAt: NOW, summaries: { [B]: { data: summary(), at: NOW + 30_000, unavailable: true } } });
  assert.doesNotMatch(p['[data-die-mean]'].getAttribute('data-stale') || '', /-\d/);
  assert.doesNotMatch(p['[data-heatmap-legend]'].textContent, /stale -\d/);
});

test('#90 fan readings go lost with the API, the last reading in the title', () => {
  const tbody = node('tbody');
  const rows = tbody.kids;
  const thead = node('thead');
  const table = node('table');
  table.querySelector = (s) => (s === 'thead' ? thead : tbody);
  const root = { querySelector: (s) => (s === '[data-fans-table]' ? table : null) };
  const m = miner({ boards: [{ name: B, model: 'BZM2', threads, fans: [{ name: 'fan0', rpm: 4200, percent: 55 }] }] });
  renderFans(root, { miner: m, apiDown: true, minerAt: NOW - 70_000 }, NOW);
  const cells = rows.flatMap((r) => (r.kids || []).slice(1));
  assert.ok(cells.length > 0, 'a fan row was drawn (instrument check)');
  assert.equal(cells[0].textContent, DASH);
  assert.match(cells[0].getAttribute('title') || '', /4200 rpm/);
});

test('#83 the hashrate chart header goes lost with the scheduler fields', () => {
  const e = node();
  hashrateHeader(e, { apiDown: true, minerAt: NOW - 1000, uptimeAdvancedAt: NOW - 2000, chartWindow: '1m' }, 5e14, '', NOW);
  assert.match(e.textContent, new RegExp(`^${DASH}`));
  assert.match(e.getAttribute('title') || '', /500\.00 TH\/s/);
});

const css90 = (await import('node:fs')).readFileSync(new URL('../../ui/css/app.css', import.meta.url), 'utf8');
test('#90 stale text keeps its contrast: no opacity on stale card text or stale KPI values', () => {
  assert.doesNotMatch(css90.match(/\.board-card\.stale\s*>\s*:not\(\.heatmap-wrap\)\s*\{[^}]*\}/)[0], /opacity/);
  assert.doesNotMatch(css90.match(/\.kpi-value\.stale\s*\{[^}]*\}/)[0], /opacity/);
});

// ---- G7: accepted / rejected shares, when Mujina reports them (2026-09-28) ----
const src = (x = {}) => [{ name: 'pool.invalid:3333', url: 'stratum+tcp://pool.invalid:3333', difficulty: 65536, ...x }];

test('G7 accepted / rejected: the pool\'s own counts from /miner sources, counts only, no browser-made ratio', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: src({ shares_accepted: 431, shares_rejected: 3, shares_rejected_by_reason: { '21': 2, stale: 1 } }) }) }), NOW);
  assert.equal(cells.accept.textContent, '431 / 3');
  assert.match(cells['accept-note'].textContent, /accepted \/ rejected by the pool/);
  assert.match(cells['accept-note'].textContent, /21×2/);
  assert.match(cells['accept-note'].textContent, /stale×1/);
  assert.doesNotMatch(cells.accept.textContent + cells['accept-note'].textContent, /%/, 'no ratio computed in the browser');
});

test('G7 accepted / rejected follow the scheduler fields: lost when they are lost, last counts in the title', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ uptimeAdvancedAt: NOW - 61_000, miner: miner({ sources: src({ shares_accepted: 431, shares_rejected: 3 }) }) }), NOW);
  assert.equal(cells.accept.textContent, DASH);
  assert.match(cells.accept.getAttribute('title') || '', /431 \/ 3/);
});

test('G7 a rejected count of 0 prints 0; an absent count is not exposed, never 0', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: src({ shares_accepted: 12, shares_rejected: 0 }) }) }), NOW);
  assert.equal(cells.accept.textContent, '12 / 0');
  renderKpi(root, kstate({ miner: miner({ sources: src() }) }), NOW);
  assert.equal(cells.accept.textContent, 'not exposed');
  assert.equal(cells['accept-note'].textContent, 'accepted / rejected by the pool', 'plain words, no private gap code');
});

test('G7 counts not from Mujina itself name their source and the last share time', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: src({ shares_accepted: 460, shares_rejected: 1, shares_rejected_by_reason: { 'stale-prevblk': 1 },
    shares_counted_by: "live view: counted from Mujina's log", shares_last_at: '14:37:07 UTC' }) }) }), NOW);
  assert.equal(cells.accept.textContent, '460 / 1');
  assert.match(cells['accept-note'].textContent, /live view: counted from Mujina's log/);
  assert.match(cells['accept-note'].textContent, /last share 14:37:07 UTC/);
});

// ---- #23 with Ronald's direction (2026-09-28): the password is hidden by
// default, with an eye to reveal it and catch typos. ----------------------
test('#23 pool: host shown, password hidden behind a reveal toggle, never in the text by default', () => {
  const { root, cells } = kpiRoot();
  const m = miner({ sources: [{ name: 'alice:hunter2@pool.example:3333', url: 'stratum+tcp://alice:hunter2@pool.example:3333', difficulty: 1 }] });
  renderKpi(root, kstate({ miner: m }), NOW);
  // The pool card nests the credentials in their own line (2026-09-28).
  const deep = (n) => [n.textContent || '', ...(n.kids || []).map(deep)].join(' ');
  const all = () => cells.pool.textContent + ' ' + deep(cells['pool-note']);
  assert.match(all(), /Active: pool\.example/); // #101: an unknown host is shown as is, never renamed
  assert.match(all(), /Port: 3333/);
  assert.doesNotMatch(all(), /hunter2/);
  assert.match(all(), /alice/);
  assert.match(all(), /password ••••••/);
  const flat = (n) => [n, ...(n.kids || []).flatMap(flat)];
  const eye = flat(cells['pool-note']).find((k) => k.getAttribute && k.getAttribute('data-reveal') != null);
  assert.ok(eye, 'a reveal button');
  assert.equal(eye.getAttribute('aria-pressed'), 'false');
  eye.onclick();
  renderKpi(root, kstate({ miner: m }), NOW);
  assert.match(all(), /hunter2/, 'revealed after the eye is pressed');
});

test('#90 the oldest-included age prints as seconds with one decimal, not a raw float', () => {
  const s = summary(); s.board.coverage.reading_age.oldest_included_secs = 0.2520597;
  const p = drawCard({ miner: miner(), minerAt: NOW - 500, summaries: { [B]: { data: s, at: NOW - 500 } } });
  assert.match(p['[data-heatmap-legend]'].textContent, /oldest included 0\.3 s/);
});

test('#90 (Ronald D2) a /miner-only outage does not blank summary values that their own endpoint still answers', () => {
  const p = drawCard({ apiDown: true, miner: miner(), minerAt: NOW - 70_000, summaries: { [B]: { data: summary(), at: NOW - 1000 } } });
  assert.equal(p['[data-die-mean]'].textContent, '64.6 °C');
  assert.equal(p['[data-die-mean]'].getAttribute('data-lost'), null);
});

// ---- Pool card (Ronald, 2026-09-28): one fact per line so it never overflows:
// a checked "Primary pool connected", then Active, Port, Worker and Diff. The
// worker is public and separate from the username and password. ----------
const ocean = (x = {}) => [{ name: 'mine.ocean.xyz:3334', url: 'stratum+tcp://mine.ocean.xyz:3334', difficulty: 262144, shares_accepted: 40, shares_rejected: 0, ...x }];
const deepText = (n) => [n.textContent || '', ...(n.kids || []).map(deepText)].join(' ');
const poolText = (cells) => cells.pool.textContent + ' | ' + deepText(cells['pool-note']);
const POOLS = JSON.parse((await import('node:fs')).readFileSync(new URL('../../ui/pools.json', import.meta.url), 'utf8'));

test('pool card: connected with a check when the pool accepted a share in the last 2 min; one fact per line', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean() }), poolAcceptedAt: NOW - 10_000, pools: POOLS }), NOW);
  assert.match(cells.pool.textContent, /^✓ Primary pool connected$/);
  assert.equal(cells.pool.getAttribute('data-pool-state'), 'ok');
  const t = poolText(cells);
  for (const s of ['OC', 'Active: OCEAN', 'Port: 3334', 'Diff: 262144', 'Worker: not reported by Mujina']) assert.ok(t.includes(s), `${s} missing: ${t}`);
  assert.ok((cells['pool-note'].kids || []).length >= 4, 'one line each');
});

test('pool card: the worker is shown as is, never masked or hidden', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean({ worker: 'rds_mujina1' }) }), poolAcceptedAt: NOW - 10_000 }), NOW);
  assert.ok(poolText(cells).includes('Worker: rds_mujina1'), poolText(cells));
});

test('pool card: no accepted share for 5 min is not connected; no share count at all is not reported', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean() }), poolAcceptedAt: NOW - 300_000 }), NOW);
  assert.doesNotMatch(cells.pool.textContent, /✓|connected$/);
  assert.match(cells.pool.textContent, /no accepted share for 5 min/);
  assert.equal(cells.pool.getAttribute('data-pool-state'), 'warn');
  renderKpi(root, kstate({ miner: miner({ sources: src() }) }), NOW);
  assert.doesNotMatch(cells.pool.textContent, /✓/);
  assert.equal(cells.pool.getAttribute('data-pool-state'), 'unknown');
});

test('pool card: the store records when the pool accepted count last rose', async () => {
  const store = await import('../../ui/js/store.js');
  store.setMiner(miner({ sources: ocean({ shares_accepted: 40 }) }), 1000);
  store.setMiner(miner({ sources: ocean({ shares_accepted: 40 }) }), 2000);
  assert.equal(store.getState().poolAcceptedAt ?? null, null, 'no rise yet');
  store.setMiner(miner({ sources: ocean({ shares_accepted: 41 }) }), 3000);
  assert.equal(store.getState().poolAcceptedAt, 3000);
});

test('#101 without the pool dataset, or for an unknown host, the card shows the host and no icon', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean() }), poolAcceptedAt: NOW - 10_000 }), NOW);
  assert.ok(poolText(cells).includes('Active: mine.ocean.xyz'), poolText(cells));
  renderKpi(root, kstate({ miner: miner({ sources: src() }), pools: POOLS }), NOW);
  assert.ok(poolText(cells).includes('Active: pool.invalid'), poolText(cells));
  assert.doesNotMatch(poolText(cells), /OCEAN/);
});

// ---- Harness facts (Ronald, 2026-09-28: the test harness's J/TH and current worker are shown).
// The lab controller's live view adds miner.harness; Mujina's own keys win when they ship. ----
const harness = { case: 'MJ-TEST-00', worker: 'mujina', input_w: 1234, input_w_at: new Date(NOW - 2000).toISOString(), j_per_th: 12.3,
  power_source: 'wall-side: the PSU input', j_per_th_basis: "5-min mean input power over Mujina's 5-min sliding hashrate" };

test('harness: the power tile shows input watts and J/TH, labelled wall-side with its basis', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean(), harness }) }), NOW);
  assert.equal(cells.power.textContent, '1,234 W · 12.3 J/TH'); // synthetic harness figures, MJ-TEST-00
  assert.match(cells['power-note'].textContent, /wall-side/);
  assert.match(cells['power-note'].textContent, /MJ-TEST-00/);
  assert.match(cells['power-note'].textContent, /5-min mean/);
});

test('harness: a power reading older than 30 s is marked stale; none at all stays not reported', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean(), harness: { ...harness, input_w_at: new Date(NOW - 45_000).toISOString() } }) }), NOW);
  assert.match(cells['power-note'].textContent, /stale 45 s/);
  renderKpi(root, kstate({ miner: miner({ sources: ocean() }) }), NOW);
  assert.equal(cells.power.textContent, 'not reported');
});

test('harness: the worker comes from Mujina when it reports one, else from the case config, labelled', () => {
  const { root, cells } = kpiRoot();
  renderKpi(root, kstate({ miner: miner({ sources: ocean(), harness }), pools: POOLS }), NOW);
  assert.ok(poolText(cells).includes('Worker: mujina (harness config, MJ-TEST-00)'), poolText(cells));
  renderKpi(root, kstate({ miner: miner({ sources: ocean({ worker: 'rds_mujina1' }), harness }), pools: POOLS }), NOW);
  assert.ok(poolText(cells).includes('Worker: rds_mujina1'), poolText(cells));
  assert.doesNotMatch(poolText(cells), /harness config/);
});
