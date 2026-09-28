/**
 * One tooltip for the heatmap (#102) and the line charts (#104): a box in the
 * canvas's wrapper and a polite region that speaks only when a person acts
 * (hard rule 9), never on a poll.
 */
import { clearChildren } from '../sanitize.js';

export function ensureTip(wrap) {
  if (!wrap) return null;
  if (wrap._tip) return wrap._tip;
  const tip = document.createElement('div');
  tip.setAttribute('class', 'asic-tip');
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  const live = document.createElement('div');
  live.setAttribute('class', 'sr-only');
  live.setAttribute('aria-live', 'polite');
  wrap.appendChild(tip);
  wrap.appendChild(live);
  wrap._tip = { tip, live };
  return wrap._tip;
}

/**
 * Where the tip goes (Ronald, 2026-09-28: tooltips hang off the pointer and
 * never cover what it points at): below and right of the anchor, flipped to
 * the left of it when it would pass the wrapper's edge.
 */
export function tipPlacement(anchor, size, wrapW) {
  const gapX = 14, gapY = 18;
  let left = anchor.x + gapX;
  if (left + size.w > wrapW) left = anchor.x - gapX - size.w;
  return { left: Math.max(0, left), top: anchor.y + gapY };
}

/** d: { title, rows: string[], footer? }; anchor { x, y } in the wrapper's CSS pixels. */
export function showTip(t, d, anchor, announce) {
  if (!t) return;
  clearChildren(t.tip);
  const title = document.createElement('div');
  title.setAttribute('class', 'asic-tip-title');
  title.textContent = d.title;
  t.tip.appendChild(title);
  for (const r of d.rows) {
    const e = document.createElement('div');
    e.textContent = r;
    t.tip.appendChild(e);
  }
  if (d.footer) {
    const f = document.createElement('div');
    f.setAttribute('class', 'asic-tip-foot');
    f.textContent = d.footer;
    t.tip.appendChild(f);
  }
  t.tip.hidden = false;
  const wrapW = t.tip.parentNode?.getBoundingClientRect?.().width ?? 1000;
  const p = tipPlacement(anchor, { w: t.tip.offsetWidth || 250, h: t.tip.offsetHeight || 120 }, wrapW);
  t.tip.style.left = `${Math.round(p.left)}px`;
  t.tip.style.top = `${Math.round(p.top)}px`;
  if (announce) t.live.textContent = [d.title, ...d.rows].join('. ');
}

export function hideTip(t) {
  if (!t) return;
  t.tip.hidden = true;
  if (t.dot) t.dot.hidden = true;
}

/** The measured point, enlarged and glowing, so the reading's place is visible. */
export function showDot(t, x, y, color) {
  if (!t) return;
  if (!t.dot) {
    t.dot = document.createElement('div');
    t.dot.setAttribute('class', 'chart-dot');
    t.dot.setAttribute('aria-hidden', 'true');
    t.tip.parentNode.appendChild(t.dot);
  }
  t.dot.hidden = false;
  t.dot.style.left = `${Math.round(x)}px`;
  t.dot.style.top = `${Math.round(y)}px`;
  t.dot.style.color = color || '';
}
