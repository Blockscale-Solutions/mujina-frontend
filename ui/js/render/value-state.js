import { setText, sanitizeText } from '../sanitize.js';
import { fmtClock, fmtAgo } from '../format.js';

export const LOST_TEXT = '\u2014'; // "—", hard rule 6

/**
 * Tooltip text for a lost value: the last value and its browser receipt time
 * (hard rule 6), plus its age at render time. Stays outside the aria-live
 * headline, so the running age re-announces nothing.
 */
const ABSENT = /^(\u2014|unknown|not reported|not exposed|not measured)?$/i;

export function lostTitle(lastText, asOf, now = Date.now()) {
  if (asOf == null) return 'no value received yet';
  const when = `${fmtClock(asOf)} (browser time), ${fmtAgo(Math.max(0, now - asOf))}`;
  // #90: an absent value never reads "last known unknown".
  if (ABSENT.test(String(lastText ?? '').trim())) return `no value was reported · last reply ${when}`;
  return `last known ${lastText} · received ${when}`;
}

/**
 * The one lost/stale renderer (#14), shared by the KPI row and the board
 * cards. Every call sets or clears every mark, so a value that recovers
 * leaves no stale or lost trace behind.
 *
 *   live:  the value, no marks.
 *   stale: the value, class .stale, data-stale "stale N s", and an aria
 *          description naming the cause.
 *   lost:  "—" (or opts.lostText), class .lost, data-lost, and the last
 *          value with its browser receipt time ONLY in the title (and the
 *          aria description, for readers who cannot hover).
 */
export function renderValue(el, { text, cls = 'live', staleText = null, cause = '', asOf = null, now = Date.now(), lostText = LOST_TEXT }) {
  if (!el) return;
  const lost = cls === 'lost';
  const stale = cls === 'stale';
  setText(el, lost ? lostText : text);
  el.classList?.toggle?.('lost', lost);
  el.classList?.toggle?.('stale', stale);
  if (lost) {
    // #90: sanitised like any shown text, and focusable so a keyboard user
    // can reach the last value (its aria description, and the focus popover).
    const title = sanitizeText(lostTitle(text, asOf, now));
    el.setAttribute('data-lost', 'lost');
    el.setAttribute('title', title);
    el.setAttribute('aria-description', sanitizeText(`lost${cause ? `: ${cause}` : ''} · ${title}`));
    el.setAttribute('tabindex', '0');
    el.removeAttribute?.('data-stale');
    return;
  }
  el.setAttribute?.('data-last', text);
  el.removeAttribute?.('tabindex');
  if (stale) {
    el.setAttribute('data-stale', staleText || 'stale');
    el.setAttribute('aria-description', `${staleText || 'stale'}${cause ? `: ${cause}` : ''}`);
    el.removeAttribute?.('data-lost');
    el.removeAttribute?.('title');
  } else {
    el.removeAttribute?.('data-lost');
    el.removeAttribute?.('data-stale');
    el.removeAttribute?.('title');
    el.removeAttribute?.('aria-description');
  }
}

/**
 * #90: a value whose source has gone (a board that left /miner) turns lost
 * with the last text it showed, which renderValue kept in data-last.
 */
export function markLost(el, { cause = '', asOf = null, now = Date.now(), lostText = LOST_TEXT } = {}) {
  if (!el) return;
  const last = el.getAttribute?.('data-last') ?? el.textContent;
  renderValue(el, { text: last, cls: 'lost', cause, asOf, now, lostText });
}
