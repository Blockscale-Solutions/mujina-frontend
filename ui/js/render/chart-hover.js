/**
 * Line-chart hover and focus (#104, a slice of #81): the sample nearest the
 * pointer, from the history the chart drew. No new request, no interpolation:
 * a sample with no value says so.
 */
import { fmtHashrate, fmtTemp, fmtNum, fmtClock } from '../format.js';
import { ensureTip, showTip, hideTip, showDot } from './tooltip.js';

export function nearestSample(series, t) {
  if (!Array.isArray(series) || !series.length) return null;
  let best = series[0];
  for (const s of series) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

/** The inverse of the charts' xAt: t0 + (x - pad.l) / pw * span. */
export function timeAtX(x, { t0, span, padL, pw }) {
  return t0 + ((x - padL) / pw) * span;
}

export function chartHoverText(kind, s, markers = [], stepMs = 0) {
  const rows = [];
  if (kind === 'hashrate') {
    if (s.v == null) rows.push('no data at this time');
    else rows.push(`${fmtHashrate(s.v)} · Mujina's 5-minute sliding average`);
  } else if (kind === 'die') {
    if (s.mean == null) rows.push('no data at this time');
    else rows.push(`min ${fmtTemp(s.min)} · mean ${fmtTemp(s.mean)} · max ${fmtTemp(s.max)}`, `spread ${fmtNum(s.spread, 1)} °C`);
  } else if (kind === 'coverage') {
    if (!s.configured) rows.push('no data at this time');
    else {
      rows.push(`${s.reporting} of ${s.configured} reporting (${fmtNum((s.reporting / s.configured) * 100, 1)} %)`);
      rows.push(`value suppressed ${s.suppressed ?? 'not reported'} · never seen ${s.neverSeen ?? 'not reported'}`);
    }
  } else if (kind === 'thermal') {
    const d = s.die;
    rows.push(d && d.mean != null ? `die min ${fmtTemp(d.min)} · mean ${fmtTemp(d.mean)} · max ${fmtTemp(d.max)}` : 'die: no summary near this time');
    for (const f of s.fans || []) rows.push(`${f.name} ${f.rpm ?? 'rpm unknown'}${f.rpm != null ? ' rpm' : ''} · ${f.percent != null ? `${f.percent} %` : 'duty unknown'}`);
  } else if (kind === 'jth') {
    if (s.v == null) rows.push('no data at this time');
    else rows.push(`${fmtNum(s.v, 1)} J/TH`, `${String(Math.round(s.w)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} W input (wall-side, harness)`);
  }
  if (stepMs > 0 && markers.some((m) => Math.abs(m - s.t) <= stepMs)) rows.push('Mujina restarted here');
  return { title: `${fmtClock(s.t)} (browser time)`, rows };
}

/** Where a sample sits on the drawn line, from the chart's own mapping; null for a gap. */
export function pointXY(kind, s, g) {
  const v = kind === 'hashrate' || kind === 'jth' ? s.v : kind === 'die' ? s.mean : kind === 'thermal' ? s.die?.mean
    : kind === 'coverage' ? (s.configured ? (s.reporting / s.configured) * 100 : null) : null;
  if (v == null || !Number.isFinite(v)) return null;
  return { x: g.padL + ((s.t - g.t0) / g.span) * g.pw, y: g.padT + g.ph * (1 - (v - g.minY) / (g.maxY - g.minY)) };
}

/** Wire once per canvas; charts.js refreshes canvas._hover on every draw. */
export function wireChartHover(canvas) {
  const wrap = canvas?.parentNode;
  if (!wrap || canvas._hoverWired || typeof canvas.getBoundingClientRect !== 'function') return;
  canvas._hoverWired = true;
  const t = ensureTip(wrap);
  canvas.setAttribute('tabindex', '0');
  // pointer: the mouse position (the tip dangles off it); without one (keys), the point.
  const show = (s, announce, pointer) => {
    const h = canvas._hover;
    if (!h || !s) { hideTip(t); return; }
    const d = chartHoverText(h.kind, s, h.markers, h.stepMs);
    const pt = pointXY(h.kind, s, h);
    const at = pt || { x: h.padL + ((s.t - h.t0) / h.span) * h.pw, y: h.padT + h.ph / 2 };
    showTip(t, d, pointer || at, announce);
    if (pt) showDot(t, pt.x, pt.y, h.color); else if (t.dot) t.dot.hidden = true;
    canvas._hoverAt = s.t;
  };
  canvas.addEventListener('mousemove', (e) => {
    const h = canvas._hover;
    if (!h) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    show(nearestSample(h.series, timeAtX(x, h)), false, { x, y });
  });
  canvas.addEventListener('mouseleave', () => { hideTip(t); canvas._hoverAt = null; });
  canvas.addEventListener('keydown', (e) => {
    const h = canvas._hover;
    if (!h || !h.series.length) return;
    if (e.key === 'Escape') { hideTip(t); canvas._hoverAt = null; return; }
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (d == null) return;
    e.preventDefault();
    let i = h.series.findIndex((s) => s.t === canvas._hoverAt);
    i = i < 0 ? h.series.length - 1 : Math.min(h.series.length - 1, Math.max(0, i + d));
    show(h.series[i], true);
  });
}
