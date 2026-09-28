import { setText, clearChildren, sanitizeText } from '../sanitize.js';
import { fmtTemp, fmtNum, fmtUnknown, fmtHashrate } from '../format.js';
import { drawHeatmap, summaryExtremes, cellAt, gridGeometry } from './heatmap.js';
import { asicDetail } from '../asic-detail.js';
import { ensureTip, showTip, hideTip } from './tooltip.js';
import { summaryState, minerFieldsState } from '../freshness.js';
import { renderValue, markLost, LOST_TEXT } from './value-state.js';
import { busPanels } from '../buses.js';
import { parseSensorName } from '../parse-sensors.js';

// ---- #102: the ASIC cell tooltip ------------------------------------------
function wireHeatTip(card, canvas) {
  const wrap = canvas?.parentNode;
  if (card._heatWired || !wrap || typeof canvas.getBoundingClientRect !== 'function') return;
  card._heatWired = true;
  card._heatTip = ensureTip(wrap);
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('aria-label', 'Die temperature heatmap. Arrow keys move between ASICs; Escape hides the details.');
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const h = card._heat;
    return cellAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height, h.opts.rows, h.opts.cols, h.opts.configured);
  };
  canvas.addEventListener('mousemove', (e) => {
    if (card._heatPinned) return;
    const i = at(e);
    const r = canvas.getBoundingClientRect();
    if (i == null) hideHeatTip(card); else showHeatTip(card, i, false, { x: e.clientX - r.left, y: e.clientY - r.top });
  });
  canvas.addEventListener('mouseleave', () => { if (!card._heatPinned) hideHeatTip(card); });
  canvas.addEventListener('click', (e) => {
    const i = at(e);
    if (i == null || (card._heatPinned && card._heatShown === i)) { card._heatPinned = false; hideHeatTip(card); return; }
    card._heatPinned = true;
    showHeatTip(card, i, true);
  });
  canvas.addEventListener('keydown', (e) => {
    const { rows, cols, configured } = card._heat.opts;
    let i = card._heatFocus ?? -1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (e.key === 'Escape') { card._heatFocus = null; card._heatPinned = false; hideHeatTip(card); redrawHeat(card); return; }
    if (step == null) return;
    e.preventDefault();
    i = i < 0 ? 0 : Math.min(Math.min(rows * cols, configured) - 1, Math.max(0, i + step));
    card._heatFocus = i;
    card._heatPinned = true;
    redrawHeat(card);
    showHeatTip(card, i, true);
  });
}

function redrawHeat(card) {
  const h = card._heat;
  if (h) drawHeatmap(h.canvas, { ...h.opts, focusWire: card._heatFocus ?? null, hoverWire: card._heatShown ?? null });
}

// announce: only on a person's action (keypress or tap), never on a poll (hard rule 9).
// pointer: the mouse position, which the tip dangles off; without one, the cell.
function showHeatTip(card, wire, announce, pointer) {
  const h = card._heat;
  if (!h || !card._heatTip) return;
  const d = asicDetail(h.board, { tty: h.tty, threadIndex: h.threadIndex }, wire, { at: h.at, cls: h.cls });
  const { rows, cols } = h.opts;
  const r = h.canvas.getBoundingClientRect();
  const { gap, cw, ch } = gridGeometry(r.width, r.height, rows, cols);
  const x = gap + (wire % cols) * (cw + gap);
  const y = gap + Math.floor(wire / cols) * (ch + gap);
  showTip(card._heatTip, { title: d.title, rows: d.rows.map(([k, v]) => `${k}: ${v}`), footer: d.footer },
    pointer || { x: x + cw / 2, y: y + ch / 2 }, announce);
  const changed = card._heatShown !== wire;
  card._heatShown = wire;
  if (changed) redrawHeat(card); // the hovered cell glows
}

function hideHeatTip(card) {
  hideTip(card._heatTip);
  const had = card._heatShown != null;
  card._heatShown = null;
  if (had) redrawHeat(card);
}

/**
 * One card per bus (mujina-bzm2-dev#124 amendment: cards are keyed by bus).
 * The static cards in index.html are a pool: extra cards are cloned from the
 * first, and unused ones are hidden, so no card reads 'waiting' next to data.
 * Board-wide figures, per-bus coverage/faults and the quiet-bus flag are #9.
 */
function ensureCards(root, n) {
  let cards = [...root.querySelectorAll('[data-board-card]')];
  while (cards.length < n && cards[0] && typeof cards[0].cloneNode === 'function') {
    const c = cards[0].cloneNode(true);
    root.appendChild(c);
    cards = [...root.querySelectorAll('[data-board-card]')];
  }
  return cards;
}

export function renderBoards(root, state, now = Date.now()) {
  if (!root) return;
  const layout = state.layout || { rows: 10, cols: 10, asics_per_board: 100 };
  const panels = busPanels(state);
  const cards = ensureCards(root, Math.max(1, panels.length));

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const panel = panels[i];
    if (!panel) {
      card.hidden = i > 0 || panels.length > 0;
      if (!card.hidden) {
        setText(card.querySelector('[data-board-name]'), 'waiting for /miner');
        // #90: a board that has left /miner keeps nothing that reads live.
        if (card.getAttribute?.('data-bus-key')) boardGone(card, state, now);
      }
      continue;
    }
    card.hidden = false;
    card.setAttribute?.('data-bus-key', panel.key);
    // Ronald, 2026-09-28: the header is just "Board N", and Board N is chain
    // UART N (thread N), counted from the first bus. The full identity stays
    // in the tooltip.
    const busLabel = panel.threadIndex != null ? `Board ${panel.threadIndex}` : (panel.tty || panel.boardName);
    const full = [panel.tty, panel.tty ? (panel.threadIndex != null ? `thread ${panel.threadIndex}` : 'thread unknown') : null,
      panel.board.model || 'BZM2', panel.boardName].filter(Boolean).map((x) => sanitizeText(String(x))).join(' · ');
    const nameEl = card.querySelector('[data-board-name]');
    setText(nameEl, busLabel);
    nameEl?.setAttribute?.('title', `${full}. Board N is chain UART N.`);
    setText(card.querySelector('[data-board-model]'), '');

    // #14: card freshness comes from this board's own summary receipt time
    // only, never the /miner time; no summary yet is lost. The same
    // summaryState as the safety strip (#56), so strip and card agree.
    const ss = summaryState({ at: panel.summaryAt, unavailable: panel.summaryUnavailable }, now, !!state.apiDown);
    // Spec :93: a failed summary keeps its last value "marked stale", even
    // while it is still young enough to be live by age.
    // #90: the age decides (two polls of failure), not each failed poll.
    const fres = ss.age;
    const staleText = ss.at != null ? `stale ${Math.max(0, Math.floor((now - ss.at) / 1000))} s` : 'stale';
    if (ss.at != null) card.setAttribute?.('data-summary-at', String(ss.at));
    card.classList.toggle('stale', fres !== 'live');
    card.classList.toggle('lost', fres === 'lost');
    card.setAttribute?.('data-freshness', fres);
    const cause = state.apiDown ? 'Mujina API not answering'
      : ss.never ? 'no asic-summary received yet'
        : ss.unavailable ? 'asic-summary unavailable (reason not exposed)' : 'asic-summary not refreshed';
    const val = (el, text, lostText = LOST_TEXT) => renderValue(el, { text, cls: fres, staleText, cause, asOf: ss.at, now, lostText });

    const sum = panel.aggregate;
    const die = sum?.die_temperature_c;
    val(card.querySelector('[data-die-min]'), die ? fmtTemp(die.min) : fmtUnknown());
    val(card.querySelector('[data-die-mean]'), die ? fmtTemp(die.mean) : fmtUnknown());
    val(card.querySelector('[data-die-max]'), die ? fmtTemp(die.max) : fmtUnknown());
    val(card.querySelector('[data-die-spread]'), die && die.spread != null ? fmtNum(die.spread, 1) : fmtUnknown());

    const hot = sum?.hottest;
    const cold = sum?.coldest;
    val(
      card.querySelector('[data-die-hot]'),
      hot ? `hot wire ${hot.wire_asic_id ?? hot.asic_id} ${fmtTemp(hot.temperature_c)}` : 'hottest: not reported',
      `hottest: ${LOST_TEXT}`,
    );
    val(
      card.querySelector('[data-die-cold]'),
      cold ? `cold wire ${cold.wire_asic_id ?? cold.asic_id} ${fmtTemp(cold.temperature_c)}` : 'coldest: not reported',
      `coldest: ${LOST_TEXT}`,
    );

    const legend = card.querySelector('[data-heatmap-legend]');
    const age = sum?.coverage?.reading_age?.oldest_included_secs;
    const oldest = fres === 'lost' ? LOST_TEXT : (age != null ? `${fmtNum(age, 1)} s` : 'unknown');
    const fresText = fres === 'lost' ? (ss.never && !state.apiDown ? 'lost · no summary yet' : 'lost')
      : fres === 'stale' ? staleText : 'live';
    const failing = ss.unavailable ? ' · summary unavailable (reason not exposed)' : '';
    const unplaced = panel.unjoinedFaults
      ? ` · ${panel.unjoinedFaults} ASIC fault row(s) not placed: bus map unavailable`
      : '';
    setText(
      legend,
      `logical order, not physical · oldest included ${oldest} · ${fresText}${failing}${unplaced}`,
    );

    const canvas = card.querySelector('canvas[data-heatmap]');
    const scale = state.metrics?.die_temperature_c?.scale || { min: 40, max: 100 };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const heatOpts = {
      rows: layout.rows || 10,
      cols: layout.cols || 10,
      configured: panel.configured ?? layout.asics_per_board ?? 100,
      cells: panel.cells,
      scale,
      stale: fres !== 'live',
      reducedMotion: reduced,
      ...summaryExtremes(sum, panel.threadIndex, fres === 'lost'),
    };
    // #102: hover, tap or focus a cell for that ASIC's readings, from this reply.
    const mfs = minerFieldsState(state, now);
    card._heat = { board: panel.board, tty: panel.tty, threadIndex: panel.threadIndex, at: mfs.asOf, cls: mfs.cls, opts: heatOpts, canvas };
    drawHeatmap(canvas, { ...heatOpts, focusWire: card._heatFocus ?? null, hoverWire: card._heatShown ?? null });
    wireHeatTip(card, canvas);
    if (card._heatShown != null) showHeatTip(card, card._heatShown, false);

    // #10: the board object's inlet and outlet rows, under the API's own
    // names; which bus board<N> belongs to is not stated, so none is guessed.
    const io = (Array.isArray(panel.board?.temperatures) ? panel.board.temperatures : [])
      .map((r) => ({ p: parseSensorName(r?.name), t: r?.temperature_c }))
      .filter((x) => x.p && (x.p.kind === 'board-inlet' || x.p.kind === 'board-outlet') && x.t != null)
      .sort((a, b) => a.p.index - b.p.index || a.p.kind.localeCompare(b.p.kind))
      .map((x) => `board${x.p.index} ${x.p.kind.slice(6)} ${fmtTemp(x.t)}`);
    const threadFres = minerFieldsState(state, now);
    renderValue(card.querySelector('[data-board-io]'), { text: io.length ? io.join(' · ') : 'not reported', ...threadFres, now });

    const tbody = card.querySelector('[data-threads]');
    clearChildren(tbody);
    for (const t of panel.threads) {
      const tr = document.createElement('tr');
      const tdN = document.createElement('td');
      tdN.textContent = sanitizeText(t.name || '—');
      const tdA = document.createElement('td');
      tdA.textContent = t.is_active === true ? 'active' : (t.is_active === false ? 'not hashing — cause not exposed' : 'unknown');
      const tdH = document.createElement('td');
      // #78: SI-reduced like the KPI row; #83: ages with /miner, lost with it.
      renderValue(tdH, { text: t.hashrate == null ? 'unknown' : fmtHashrate(t.hashrate), ...threadFres, now });
      tr.appendChild(tdN); tr.appendChild(tdA); tr.appendChild(tdH);
      tbody.appendChild(tr);
    }
    const note = card.querySelector('[data-thread-note]');
    setText(note, 'thread hashrate may be nominal, not measured');
  }
}

/** #90: the card of a board that left /miner: every value lost, no rows. */
function boardGone(card, state, now) {
  const at = Number(card.getAttribute?.('data-summary-at')) || null;
  const cause = 'board not in /miner';
  for (const sel of ['[data-die-min]', '[data-die-mean]', '[data-die-max]', '[data-die-spread]']) {
    markLost(card.querySelector(sel), { cause, asOf: at, now });
  }
  markLost(card.querySelector('[data-die-hot]'), { cause, asOf: at, now, lostText: `hottest: ${LOST_TEXT}` });
  markLost(card.querySelector('[data-die-cold]'), { cause, asOf: at, now, lostText: `coldest: ${LOST_TEXT}` });
  markLost(card.querySelector('[data-board-io]'), { cause, asOf: at, now });
  setText(card.querySelector('[data-heatmap-legend]'), `logical order, not physical · board not in /miner · lost`);
  card.classList.toggle('stale', true);
  card.classList.toggle('lost', true);
  card.setAttribute?.('data-freshness', 'lost');
  clearChildren(card.querySelector('[data-threads]'));
  drawHeatmap(card.querySelector('canvas[data-heatmap]'), { cells: [], stale: true });
}
