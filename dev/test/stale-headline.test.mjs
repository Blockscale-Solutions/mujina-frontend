// Issue #6: the safety headline reaches STALE; stale, lost and unavailable
// summaries drop their '(measured)' claims; a failed asic-summary is shown
// as unavailable. Plus the #42 composite (#6 + #7) on the real one-board /
// three-thread shape. Stub DOM (dom-stub.mjs), real store / poller /
// renderer, synthetic ttyMOCK data only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, el, flush } from './dom-stub.mjs';
import { expandSeed } from '../gen-scenario.mjs';

installDom();
const { CONFIG } = await import('../../ui/js/config.js');
const store = await import('../../ui/js/store.js');
const poller = await import('../../ui/js/poller.js');
const { renderSafety } = await import('../../ui/js/render/safety.js');
const { busPanels } = await import('../../ui/js/buses.js');
const DEFAULTS = { ...CONFIG };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const seed = (name) => expandSeed(JSON.parse(fs.readFileSync(path.join(ROOT, `dev/fixtures/${name}/seed.json`), 'utf8')));
const BOARD = 'bzm2-ttyMOCKAA';

/** A fresh safety root; returns { root, headline, chipTexts() }. */
function safetyRoot() {
  const headline = el('headline');
  const chips = el('chips');
  const age = el('age');
  const root = el('safety');
  root.children = { '[data-safety-headline]': headline, '[data-safety-chips]': chips, '[data-safety-age]': age };
  return { root, headline, age, chipTexts: () => chips.kids.map((c) => c.textContent) };
}
/** Minimal state with one board and its summary entry. */
function stateWith(summaryEntry, boardName = BOARD) {
  return {
    miner: { uptime_secs: 100, paused: false, boards: [{ name: boardName, threads: [{ is_active: true }] }] },
    summaries: { [boardName]: summaryEntry },
    apiDown: false,
    uptimeAdvancedAt: Date.now(),
  };
}
function response(body, status = 200) {
  const buf = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer;
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => buf };
}
async function advance(ms, step = 5) { for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); } }

test('#6 test 1: a 30 s old measured summary gives a STALE (amber) headline and no chip claims "(measured)"', () => {
  const now = Date.now();
  const { root, headline, chipTexts } = safetyRoot();
  renderSafety(root, stateWith({
    data: { board: { faults: { availability: 'measured', bits: [] }, coverage: { asics_configured: 100, asics_reporting: 100 } } },
    at: now - 30_000,
  }), now);
  assert.match(headline.textContent, /^STALE/);
  assert.equal(headline.getAttribute('data-sev'), 'warn');
  assert.ok(!chipTexts().some((t) => t.includes('(measured)')), chipTexts().join(' | '));
  assert.ok(chipTexts().some((t) => t === `${BOARD}: 0 fault bits · last measured 30 s ago`), chipTexts().join(' | '));
  assert.ok(chipTexts().some((t) => t === `${BOARD}: coverage 100/100 · last measured 30 s ago`));
});

test('#6 test 2: asic-summary 500 with an empty body after one good reply marks the board unavailable and says so', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2_000_000 });
  Object.assign(CONFIG, { minerIntervalMs: 20, asicSummaryIntervalMs: 50, backoffBaseMs: 20, backoffJitter: 0,
    chainSummaryOnLoad: false, maxKBps: 1e9 });
  let summaries = 0;
  globalThis.fetch = (p) => {
    if (p === '/api/v0/miner') return Promise.resolve(response({ uptime_secs: 100, paused: false, boards: [{ name: BOARD, threads: [] }] }));
    if (p.endsWith('/asic-summary')) {
      summaries += 1;
      return Promise.resolve(summaries === 1
        ? response({ board: { faults: { availability: 'measured', bits: [] }, coverage: { asics_configured: 100, asics_reporting: 100 } } })
        : response('', 500));
    }
    return Promise.resolve(response({}));
  };
  poller._resetForTests();
  poller.startPoller();
  try {
    await advance(300, 2);
    assert.ok(summaries >= 2, 'the failing asic-summary was never requested');
    const entry = store.getState().summaries[BOARD];
    assert.equal(entry.unavailable, true, 'store did not mark the board unavailable');
    assert.ok(entry.data?.board?.faults, 'the last good summary was dropped');
    const { root, headline, chipTexts } = safetyRoot();
    renderSafety(root, store.getState(), Date.now());
    assert.ok(chipTexts().includes(`${BOARD}: summary unavailable (reason not exposed)`), chipTexts().join(' | '));
    assert.match(headline.textContent, /^STALE/);
    assert.ok(!chipTexts().some((t) => t.includes('(measured)')), 'an unavailable summary is still "(measured)"');
  } finally {
    poller.stopPoller();
    mock.timers.reset();
    Object.assign(CONFIG, DEFAULTS);
  }
});

test('#6 test 3: a 70 s old summary asserting thermal_trip keeps the FAULT headline, labelled with its age', () => {
  const now = Date.now();
  const { root, headline, age, chipTexts } = safetyRoot();
  renderSafety(root, stateWith({
    data: { board: { faults: { availability: 'measured', bits: [{ bit: 'thermal_trip', asics_asserting: 1, asic_ids: [7] }] },
      coverage: { asics_configured: 100, asics_reporting: 100 } } },
    at: now - 70_000,
  }), now);
  assert.match(headline.textContent, /^FAULT BIT ASSERTED · bzm2-ttyMOCKAA · thermal_trip/);
  assert.equal(headline.getAttribute('data-sev'), 'fault');
  assert.match(headline.textContent, / · last known \d\d:\d\d:\d\d \(browser time\)$/);
  assert.equal(age.textContent, '1 min 10 s ago');
  assert.ok(chipTexts().includes(`${BOARD}: thermal_trip×1 [7] · last measured 1 min 10 s ago`), chipTexts().join(' | '));
});

test('#42 composite (#6 + #7): on the real shape, an asic-summary outage hiding a new per-ASIC fault is shown as unavailable/stale, never "no faults"', async () => {
  const data = seed('nominal-3b');
  const board = data.miner.boards[0];
  const name = board.name;
  assert.equal(data.miner.boards.length, 1);
  assert.deepEqual([...new Set(board.asics.map((a) => a.thread_index))].sort(), [0, 1, 2]);
  const sums = data.summaries[name];

  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 3_000_000 });
  Object.assign(CONFIG, { minerIntervalMs: 20, asicSummaryIntervalMs: 50, backoffBaseMs: 20, backoffJitter: 0,
    chainSummaryOnLoad: true, maxKBps: 1e9, lostAfterMs: 1000 });
  let outage = false;
  let miner = data.miner;
  globalThis.fetch = (p) => {
    if (p === '/api/v0/miner') return Promise.resolve(response(miner));
    if (p.endsWith('/chain-summary')) return Promise.resolve(response(sums.chain));
    if (p.endsWith('/asic-summary')) return Promise.resolve(outage ? response('', 500) : response(sums.asic));
    return Promise.resolve(response({}));
  };
  poller._resetForTests();
  poller.startPoller();
  try {
    await advance(200, 2);
    const { root, headline, chipTexts } = safetyRoot();
    renderSafety(root, store.getState(), Date.now());
    assert.match(headline.textContent, /^No fault bits asserted \(measured\)/, 'baseline not neutral');

    // Outage (a slow diagnostic makes asic-summary 500 / empty) and, during
    // it, a new thermal_fault on bus 3 (thread_index 2), wire id 57.
    outage = true;
    miner = structuredClone(data.miner);
    const hit = miner.boards[0].asics.find((a) => a.thread_index === 2 && a.id === 57);
    hit.faults.thermal_fault = true;
    await advance(400, 2);

    renderSafety(root, store.getState(), Date.now());
    const texts = chipTexts();
    assert.ok(!headline.textContent.startsWith('No fault bits asserted'), `headline still claims no faults: ${headline.textContent}`);
    // #62 (Ronald, 2026-09-25): a fault that RISES in /miner asics[] while the
    // summary cannot report it turns the headline red, naming its source.
    assert.match(headline.textContent, /^FAULT BIT ASSERTED · .* · thermal_fault · thread 2 wire 57 · source \/miner asics\[\]/);
    assert.equal(headline.getAttribute('data-sev'), 'fault');
    assert.ok(texts.includes(`${name}: summary unavailable (reason not exposed)`), texts.join(' | '));
    assert.ok(!texts.some((t) => t.includes('(measured)')), `a chip still claims "(measured)": ${texts.join(' | ')}`);
    assert.ok(texts.some((t) => /: 0 fault bits · last measured .* ago$/.test(t)), texts.join(' | '));

    // #7 half: the new fault is drawn on the right cell of the right bus.
    const panels = busPanels(store.getState());
    assert.equal(panels.length, 3);
    const p2 = panels.find((p) => p.threadIndex === 2);
    const faulted = panels.flatMap((p) => p.cells.filter((c) => c.fault).map((c) => `${p.tty}:${c.wireId}`));
    assert.deepEqual(faulted, [`${p2.tty}:57`]);
  } finally {
    poller.stopPoller();
    mock.timers.reset();
    Object.assign(CONFIG, DEFAULTS);
  }
});
