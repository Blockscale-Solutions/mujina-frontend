// Issue #15, page side: a known red FAULT headline is never replaced by the
// amber API message. Boots the real app.js (stub DOM, fake clock, fake fetch)
// against the fault-stub seed (one board object, thermal_fault on bus
// ttyMOCK00 wires 2-4), then breaks /miner in the ways the issue names.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, advance, flush, okResponse } from './dom-stub.mjs';
import { expandSeed } from '../gen-scenario.mjs';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
const { pill, headline, chips, age } = installDom();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fault = expandSeed(JSON.parse(fs.readFileSync(path.join(ROOT, 'dev/fixtures/fault-stub/seed.json'), 'utf8')));
const clean = expandSeed(JSON.parse(fs.readFileSync(path.join(ROOT, 'dev/fixtures/nominal-3b-sparse/seed.json'), 'utf8')));
const BOARD = fault.miner.boards[0].name;

// Server model: 'ok' | 'fail500' (one-shot) | 'down'; summaries: fault or clean.
let minerMode = 'ok';
let data = fault;
globalThis.fetch = (p) => {
  if (p === './layout.json') return Promise.resolve(okResponse({ rows: 10, cols: 10 }));
  if (p === './metrics.json') return Promise.resolve(okResponse({}));
  if (minerMode === 'down') return Promise.reject(new TypeError('network down'));
  if (p === '/api/v0/miner') {
    if (minerMode === 'fail500') {
      minerMode = 'ok';
      return Promise.resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    }
    return Promise.resolve(okResponse(data.miner));
  }
  if (p.endsWith('/asic-summary')) return Promise.resolve(okResponse(data.summaries[BOARD].asic));
  if (p.endsWith('/chain-summary')) return Promise.resolve(okResponse(data.summaries[BOARD].chain));
  return Promise.resolve(okResponse({ ok: true }));
};

const { CONFIG } = await import('../../ui/js/config.js');
Object.assign(CONFIG, {
  minerIntervalMs: 20, asicSummaryIntervalMs: 50, backoffBaseMs: 20, backoffCapMs: 160,
  backoffJitter: 0, lostAfterMs: 1000, freshnessTickMs: 10, maxKBps: 1e9,
  minerTimeoutIntervals: 5, healthTimeoutMs: 40,
});
const store = await import('../../ui/js/store.js');
const poller = await import('../../ui/js/poller.js');
const app = await import('../../ui/js/app.js');
const { fmtClock } = await import('../../ui/js/format.js');
await flush();

const chipTexts = () => chips.kids.map((c) => c.textContent);
/** Advance, checking fn() after every step. */
async function watch(ms, fn) { for (let t = 0; t < ms; t += 2) { await advance(2, 1); fn(); } }

test.after(() => { app._stopClockForTests(); poller.stopPoller(); mock.timers.reset(); });

test('#15 test 1: exactly one /miner 500 never replaces the FAULT headline and never makes the pill lost', async () => {
  await advance(150, 2); // first /miner, chain-summary and the fault-carrying asic-summary
  assert.ok(store.getState().summaries[BOARD], 'asic-summary never stored');
  assert.match(headline.textContent, /^FAULT BIT ASSERTED · .* · thermal_fault( \[[\d,]+\])?$/); // #16 adds the ids

  minerMode = 'fail500';
  const seen = new Set();
  await watch(300, () => {
    assert.match(headline.textContent, /^FAULT BIT ASSERTED/, `headline became: ${headline.textContent}`);
    assert.notEqual(pill.getAttribute('data-state'), 'lost', 'one failure made the pill lost');
    seen.add(pill.getAttribute('data-state'));
  });
  assert.equal(minerMode, 'ok', 'the 500 was never served');
  assert.equal(store.getState().apiDown, false);
  assert.ok(!chipTexts().some((t) => /not answering/.test(t)));
});

test('#15 test 2: /miner fails continuously after the fault was seen: FAULT stays the headline, API down is a chip, last-known chips stay, marked lost', async () => {
  const lastSummaryAt = store.getState().summaries[BOARD].at;
  minerMode = 'down';
  await watch(400, () => {
    assert.match(headline.textContent, /^FAULT BIT ASSERTED/, `headline became: ${headline.textContent}`);
    assert.equal(headline.getAttribute('data-sev'), 'fault');
  });
  const s = store.getState();
  assert.equal(s.apiDown, true, 'sustained failure never declared the API down');
  assert.equal(poller._mode(), 'down');
  // Headline labelled with the age of the data behind it (a clock time: stable text for aria-live).
  assert.ok(headline.textContent.endsWith(`· last known ${fmtClock(lastSummaryAt)} (browser time)`), headline.textContent);
  const texts = chipTexts();
  assert.ok(texts.some((t) => t === `Mujina API not answering since ${fmtClock(s.apiDownSince)} (browser time)`), texts.join(' | '));
  const faultChip = texts.find((t) => t.includes('thermal_fault×3'));
  assert.ok(faultChip, 'the fault chip disappeared');
  // #6: summary chips drop '(measured)' and carry their age; the board is marked lost.
  assert.match(faultChip, /\[2,3,4\] · last measured \d+ s ago$/);
  // #90 (Ronald, D2): the summary ages by its own receipt time; it is failing
  // here too, so it reads stale, then lost, and is never shown live.
  assert.ok(texts.some((t) => t === `${BOARD}: stale` || t === `${BOARD}: lost`), texts.join(' | '));
  // Pill still follows /miner freshness only (lostAfterMs = 1000 here).
  assert.equal(pill.getAttribute('data-state'), 'stale');
  await advance(CONFIG.lostAfterMs, 10);
  assert.equal(pill.getAttribute('data-state'), 'lost');
  assert.match(headline.textContent, /^FAULT BIT ASSERTED/);
});

test('#47 review: a relative age ticks beside the FAULT headline, outside the live region; the live region text does not change', async () => {
  assert.equal(store.getState().apiDown, true);
  assert.equal(age.getAttribute('aria-hidden'), 'true');
  assert.equal(age.getAttribute('hidden'), null, 'age hidden while a last-known FAULT is shown');
  const liveText = headline.textContent;
  const liveWrites = headline.writes;
  const ages = new Set();
  for (let i = 0; i < 40; i++) { await advance(100, 10); ages.add(age.textContent); }
  assert.ok(ages.size >= 3, `age did not tick: ${[...ages].join(' | ')}`);
  for (const a of ages) assert.match(a, /^\d+ (s|min \d+ s) ago$/);
  assert.equal(headline.textContent, liveText, 'live region text changed');
  assert.equal(headline.writes, liveWrites, 'live region rewritten while only the age changed');
  assert.ok(!headline.textContent.includes('ago'));
});

test('#15 the FAULT headline goes only when data says otherwise; with no known fault, API down is the amber headline', async () => {
  // Recovery with a clean board: the next asic-summary clears the fault.
  data = clean;
  minerMode = 'ok';
  await advance(600, 2);
  const s = store.getState();
  assert.equal(s.apiDown, false, 'a /miner success did not clear apiDown');
  assert.equal(s.apiDownSince, null);
  assert.doesNotMatch(headline.textContent, /^FAULT/);
  assert.ok(!chipTexts().some((t) => /not answering|last known/.test(t)));
  assert.equal(age.textContent, '');
  assert.equal(age.getAttribute('hidden'), '');

  minerMode = 'down';
  await advance(400, 2);
  assert.equal(store.getState().apiDown, true);
  assert.equal(headline.textContent, 'Mujina API not answering — cause not exposed');
  assert.equal(headline.getAttribute('data-sev'), 'warn');
  assert.ok(chipTexts().some((t) => t.startsWith('Mujina API not answering since ')));
  assert.ok(chipTexts().some((t) => /0 fault bits · last measured .* ago$/.test(t)), chipTexts().join(' | '));
  assert.ok(chipTexts().some((t) => t === `${BOARD}: stale` || t === `${BOARD}: lost`), chipTexts().join(' | ')); // #90 D2
  assert.ok(!chipTexts().some((t) => t.includes('(measured)')), 'a lost summary still claims (measured)');
});
