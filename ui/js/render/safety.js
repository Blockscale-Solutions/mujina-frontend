import { setTextIfChanged, clearChildren, sanitizeText } from '../sanitize.js';
import { schedulerFieldsStale, schedulerFieldsState, summaryState } from '../freshness.js';
import { fmtClock, fmtAgo } from '../format.js';

const API_DOWN_HEAD = 'Mujina API not answering — cause not exposed';
const NEUTRAL_HEAD = 'No fault bits asserted (measured) · supervisor state not exposed';

/**
 * Headline rank (spec :41-44: highest severity wins; FAULT is red, the rest
 * amber). The spec does not order the amber headlines; this does, and the
 * PR records the choice: API down (#15) > FAULT BITS UNAVAILABLE > NOT
 * HASHING (from live /miner data) > STALE (#6, #8) > PARTIAL COVERAGE (from
 * a live summary only) > neutral.
 */
const RANK = { fault: 6, apiDown: 5, unavailable: 4, notHashing: 3, stale: 2, partial: 1, neutral: 0 };

// Per-board summary state (summaryState) lives in freshness.js, shared with
// the board cards (#56, #14).

/**
 * Pure safety-strip model: headline, severity, chips and the relative age
 * shown beside a last-known FAULT headline. renderSafety draws it.
 */
export function safetyModel(state, now = Date.now()) {
  // #54: latched bits for this board that the current data does not show asserted.
  const latchedFor = (name, faults) => {
    const latch = state.faultLatch?.[name];
    if (!latch) return [];
    const now = new Set(Array.isArray(faults?.bits) ? faults.bits.filter((x) => x.asics_asserting > 0).map((x) => x.bit) : []);
    return Object.entries(latch).filter(([bit]) => !now.has(bit));
  };
  const miner = state.miner;
  const down = !!state.apiDown;
  const chips = [];
  const chip = (text, sev = null) => chips.push({ text, sev });
  let rank = RANK.neutral;
  let sev = 'neutral';
  let head = NEUTRAL_HEAD;
  // #16: every asserting (board, bit, ids), in API order; the headline names
  // them. Each keeps its own receipt time and whether it is only last known.
  const faultEntries = [];
  const fault = (text, at, lastKnown) => {
    faultEntries.push({ text, at, lastKnown });
    raise(RANK.fault, 'fault', 'FAULT BIT ASSERTED', { equalWins: true });
  };
  const raise = (r, s, text, { equalWins = false } = {}) => {
    if (r > rank || (equalWins && r === rank)) { rank = r; sev = s; head = text; return true; }
    return false;
  };
  const apiChip = () => chip(
    `Mujina API not answering since ${fmtClock(state.apiDownSince ?? now)} (browser time)`, 'warn');

  if (!miner) {
    // Nothing known yet: nothing to keep on screen.
    if (down) apiChip(); else chip('API lost', 'warn');
    return { head: API_DOWN_HEAD, sev: 'warn', chips, age: '' };
  }

  // /miner-derived chips while the API is down (#15): last known, lost.
  const tag = down ? ' · last known (lost)' : '';
  if (down) apiChip();

  // Scheduler fields (#8): uptime_secs unchanged for > schedulerStaleSecs.
  const schedStale = schedulerFieldsStale(state.uptimeAdvancedAt, now);
  const schedAge = state.uptimeAdvancedAt != null ? Math.floor((now - state.uptimeAdvancedAt) / 1000) : null;
  if (miner.paused === true) {
    if (schedStale) {
      chip(`paused · stale ${schedAge} s${tag}`, 'warn');
    } else {
      chip(`paused${tag}`, 'warn');
      raise(RANK.notHashing, 'warn', 'NOT HASHING — paused');
    }
  }
  // #90: one answer with the KPI row: past lostAfterMs the chip says lost.
  const sched = schedulerFieldsState(state, now);
  if (sched.cls === 'lost') {
    chip(`scheduler fields lost: ${sched.cause} (hashrate, shares, paused not current)`, 'unknown');
  } else if (schedStale) {
    chip(`scheduler fields stale ${schedAge} s: uptime not advancing (hashrate, shares, paused not current)`, 'warn');
  }
  if (schedStale) {
    raise(RANK.stale, 'warn', 'STALE · scheduler not publishing · hashrate, shares and paused not current');
  }

  const boards = Array.isArray(miner.boards) ? miner.boards : [];
  // #51: /miner with no board is not "no faults": nothing is measured.
  if (boards.length === 0) {
    chip(`/miner reported no board${tag}`, 'unknown');
    raise(RANK.unavailable, 'warn', 'FAULT BITS UNAVAILABLE');
  }
  // #51: a board that left /miner (pruned after a fault, or its task ended)
  // is still evaluated from its last summary, as last known.
  const present = new Set(boards.map((b) => b.name || '?'));
  const gone = Object.keys(state.summaries || {}).filter((n) => !present.has(n)).map((n) => ({ name: n, threads: [], gone: true }));
  for (const b of [...boards, ...gone]) {
    const name = b.name || '?';
    if (b.gone) chip(`${name}: not in /miner`, 'unknown');
    const entry = state.summaries[name];
    const sum = entry?.data?.board;
    // One answer per board, shared with the cards (#56): the age class and the
    // failure side by side. A failing summary still ages to lost at 60 s.
    const ss = summaryState(entry, now, down);
    const st = b.gone ? 'lost' : ss.age;
    const live = b.gone ? false : ss.live;
    // Non-live summary values drop '(measured)' and carry their age (#6).
    const aged = live ? '' : ` · last measured ${entry?.at != null ? fmtAgo(now - entry.at) : 'never'}`;
    const measured = live ? ' (measured)' : '';

    if (entry?.unavailable) chip(`${name}: summary unavailable (reason not exposed)`, 'warn');

    const faults = sum?.faults;
    if (!faults || faults.availability == null) {
      chip(`${name}: faults unavailable`, 'unknown');
      raise(RANK.unavailable, 'warn', 'FAULT BITS UNAVAILABLE');
    } else if (faults.bits == null) {
      chip(`${name}: fault bits null (unreadable)${aged}`, 'unknown');
      raise(RANK.unavailable, 'warn', 'FAULT BITS UNAVAILABLE');
    } else if (Array.isArray(faults.bits)) {
      for (const bit of faults.bits) {
        const n = bit.asics_asserting || 0;
        if (n > 0) {
          const ids = Array.isArray(bit.asic_ids) ? bit.asic_ids.join(',') : '';
          const omitted = bit.asic_ids_omitted > 0 ? ` +${bit.asic_ids_omitted} omitted` : '';
          chip(`${name}: ${bit.bit}×${n}${ids ? ` [${ids}]` : ''}${omitted}${aged}`, 'fault');
          // A last-known asserted bit still gives FAULT (#6 test 3, #15).
          fault(`${name} · ${bit.bit}${ids ? ` [${ids}]` : ''}${omitted}`, entry?.at ?? null, !live);
        }
      }
      if ((faults.bits.length === 0 || faults.bits.every((x) => !x.asics_asserting)) && !latchedFor(name, faults).length) {
        chip(`${name}: 0 fault bits${measured}${aged}`, null);
      }
    }
    // #62: while the summary cannot report (unavailable, stale, or bits null),
    // a fault this browser saw RISE in /miner asics[] turns the headline red.
    const canReport = live && !ss.unavailable && Array.isArray(faults?.bits);
    if (!canReport) {
      for (const [key, firstAt] of Object.entries(state.minerFaults?.[name]?.rises || {})) {
        const [t, wire, bit] = key.split(':');
        chip(`${name}: ${bit} thread ${t} wire ${wire} · from /miner asics[]`, 'fault');
        fault(`${name} · ${bit} · thread ${t} wire ${wire} · source /miner asics[] · first seen ${fmtClock(firstAt)} (browser time)`, null, false);
      }
    }
    // #54: a bit latched red stays red until a summary measures it clear.
    for (const [bit, l] of latchedFor(name, faults)) {
      chip(`${name}: ${bit}×${l.n}${l.ids.length ? ` [${l.ids.join(',')}]` : ''} · last known ${fmtClock(l.at)} (browser time)`, 'fault');
      fault(`${name} · ${bit}${l.ids.length ? ` [${l.ids.join(',')}]` : ''}`, l.at, true);
    }

    // #5: the thermal interlock holds one chain, which is one thread; any
    // inactive thread is NOT HASHING, named.
    const threads = Array.isArray(b.threads) ? b.threads : [];
    threads.forEach((t, i) => {
      if (t.is_active !== false) return;
      chip(`${name} · ${sanitizeText(t.name || `thread ${i}`)}: not hashing — cause not exposed${tag}`, 'warn');
      if (!down) raise(RANK.notHashing, 'warn', 'NOT HASHING · cause not exposed');
    });

    const cov = sum?.coverage;
    if (cov && cov.asics_configured != null) {
      const reporting = cov.asics_reporting ?? 0;
      const partial = reporting < cov.asics_configured;
      chip(`${name}: coverage ${reporting}/${cov.asics_configured}${aged}`, partial ? 'warn' : null);
      if (partial && live) raise(RANK.partial, 'warn', 'PARTIAL COVERAGE');
    }

    if (!live && entry) {
      // #90: lost is not a fault, so never the fault colour.
      if (st !== 'live') chip(`${name}: ${st}`, st === 'lost' ? 'unknown' : 'warn');
      // Lost outranks unavailable in the text (#56): a summary failing for
      // minutes must not read less severe than one that is merely old.
      const why = st === 'lost' ? 'lost' : ss.unavailable ? 'unavailable' : st;
      // A board that left /miner is shown by its chip (and stays red if it
      // had faults, #51); it does not hold the headline amber indefinitely.
      if (sum && !b.gone) raise(RANK.stale, 'warn', `STALE · ${name} summary ${why} · fault bits not current`);
    }
  }

  chip('supervisor: not exposed by Mujina API (logs only)', 'unknown');

  if (down) {
    // With the API down every fault on screen is last known (#15).
    if (sev === 'fault') faultEntries.forEach((e) => { e.lastKnown = true; });
    else raise(RANK.apiDown, 'warn', API_DOWN_HEAD);
  }
  let age = '';
  if (sev === 'fault' && faultEntries.length) {
    // Stable text (a clock time, not a running age) so the aria-live
    // headline is not re-announced on every freshness tick (#4, #47).
    const clock = (at) => `${at != null ? fmtClock(at) : 'time unknown'} (browser time)`;
    const known = faultEntries.filter((e) => e.lastKnown);
    const oldest = known.reduce((t, e) => (e.at != null && (t == null || e.at < t) ? e.at : t), null);
    // All last known: one suffix for the headline. Mixed: mark only those
    // entries, so a live fault never reads as old.
    const all = known.length === faultEntries.length;
    const shown = faultEntries.slice(0, 3).map((e) => (e.lastKnown && !all ? `${e.text} (last known ${clock(e.at)})` : e.text));
    const more = faultEntries.length > 3 ? ` · +${faultEntries.length - 3} more` : '';
    head = `FAULT BIT ASSERTED · ${shown.join(' · ')}${more}`;
    if (all) head += ` · last known ${clock(oldest)}`;
    if (known.length && oldest != null) age = fmtAgo(now - oldest);
  }
  return { head, sev, chips, age };
}

function drawChip(parent, { text, sev }) {
  const el = document.createElement('span');
  el.className = 'chip';
  if (sev) el.setAttribute('data-sev', sev);
  el.textContent = sanitizeText(text);
  parent.appendChild(el);
}

export function renderSafety(root, state, now = Date.now()) {
  if (!root) return;
  const headline = root.querySelector('[data-safety-headline]');
  const chips = root.querySelector('[data-safety-chips]');
  const ageEl = root.querySelector('[data-safety-age]');
  const m = safetyModel(state, now);
  clearChildren(chips);
  for (const c of m.chips) drawChip(chips, c);
  setTextIfChanged(headline, m.head); // aria-live: announce transitions only
  headline.setAttribute('data-sev', m.sev);
  // Relative age of a last-known FAULT headline; outside the live region.
  if (ageEl) {
    setTextIfChanged(ageEl, m.age);
    if (m.age) ageEl.removeAttribute?.('hidden'); else ageEl.setAttribute('hidden', '');
  }
}
