/**
 * Vanilla canvas charts — gradient fill + soft glow (N5 aesthetic, no particles).
 * Redraw on store update only. Honour prefers-reduced-motion (no glow/transitions).
 */
import { wireChartHover } from './chart-hover.js';
import { CONFIG } from '../config.js';
import { fmtHashrate, fmtNum, fmtTemp, fmtClock } from '../format.js';
import { setText } from '../sanitize.js';
import { schedulerFieldsState } from '../freshness.js';
import { renderValue, LOST_TEXT } from './value-state.js';

const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

function reduced() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  const rect = parent.getBoundingClientRect();
  const w = Math.max(80, rect.width);
  const h = Math.max(60, rect.height);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function themeColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme')
      && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return {
    bg: dark ? '#151a1f' : '#ffffff',
    grid: dark ? '#222a31' : '#e8e4dc',
    muted: dark ? '#556069' : '#9a948a',
    ink: dark ? '#d6dde3' : '#1a1917',
    teal: dark ? '#2dd4bf' : '#1FA6A0',
    orange: '#E86A2B',
    band: dark ? 'rgba(45,212,191,0.2)' : 'rgba(31,166,160,0.18)',
  };
}

function windowMs(state) {
  return CONFIG.chartWindows[state.chartWindow] || CONFIG.chartWindows['1m'];
}

function sliceSeries(arr, now, win) {
  const cutoff = now - win;
  return (arr || []).filter((s) => s.t >= cutoff);
}

export { fmtClock };

/** Text note for restart markers inside the chart window (#25). */
export function restartNote(markers, now, win) {
  const inWin = (markers || []).filter((t) => t >= now - win && t <= now);
  if (!inWin.length) return '';
  return ` · restart at ${inWin.map(fmtClock).join(', ')}`;
}

/** Vertical rule at each restart marker between t0 and t1 (#25). */
function drawMarkers(ctx, markers, t0, t1, xAt, pad, ph, color) {
  for (const m of markers || []) {
    if (m < t0 || m > t1) continue;
    const x = xAt(m);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    ctx.restore();
  }
}

function drawLineChart(canvas, series, opts) {
  const { ctx, w, h } = resize(canvas);
  const c = themeColors();
  const pad = { l: 40, r: 8, t: 10, b: 18 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);

  if (!series.length) {
    ctx.fillStyle = c.muted;
    ctx.font = '10px ' + FONT_MONO;
    ctx.fillText(opts?.emptyText || 'No samples yet (browser receipt time)', pad.l, pad.t + 12);
    return;
  }

  const ys = series.map((s) => s.v).filter((v) => v != null && !Number.isNaN(v));
  let maxY = Math.max(...ys, 0.001) * 1.12;
  let minY = opts?.zeroBase ? 0 : Math.min(...ys, 0);
  if (opts?.tight && ys.length) { // a narrow band, so a small drift shows (J/TH)
    const lo = Math.min(...ys), hi = Math.max(...ys), m = (hi - lo) * 0.15 || Math.abs(hi) * 0.02 || 1;
    minY = lo - m; maxY = hi + m;
  }
  if (minY === maxY) maxY = minY + 1;

  // grid
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = c.muted;
  ctx.font = '9px ' + FONT_MONO;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + ph * (1 - i / 3);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + pw, y);
    ctx.stroke();
    const val = minY + (maxY - minY) * (i / 3);
    ctx.fillText(opts?.fmtY ? opts.fmtY(val) : val.toFixed(1), 2, y + 3);
  }

  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const xAt = (t) => pad.l + ((t - t0) / span) * pw;
  const yAt = (v) => pad.t + ph * (1 - (v - minY) / (maxY - minY));

  const color = opts?.color || c.teal;

  // gradient fill
  ctx.beginPath();
  let started = false;
  for (const s of series) {
    if (s.v == null) { started = false; continue; }
    const x = xAt(s.t); const y = yAt(s.v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  if (started) {
    ctx.lineTo(xAt(series[series.length - 1].t), pad.t + ph);
    ctx.lineTo(xAt(series[0].t), pad.t + ph);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, color.replace(')', ', 0.28)').replace('rgb', 'rgba').replace('#', '') ? hexAlpha(color, 0.28) : hexAlpha(color, 0.28));
    grad.addColorStop(1, hexAlpha(color, 0));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // glow
  if (!reduced()) {
    ctx.save();
    pathSeries(ctx, series, xAt, yAt);
    ctx.strokeStyle = hexAlpha(color, 0.35);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = hexAlpha(color, 0.5);
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
  }

  // hero stroke
  pathSeries(ctx, series, xAt, yAt);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  drawMarkers(ctx, opts?.markers, t0, t1, xAt, pad, ph, c.ink);
  return { t0, span, padL: pad.l, pw, padT: pad.t, ph, minY, maxY, color: opts?.color || c.teal };
}

function pathSeries(ctx, series, xAt, yAt) {
  ctx.beginPath();
  let started = false;
  for (const s of series) {
    if (s.v == null) { started = false; continue; }
    const x = xAt(s.t); const y = yAt(s.v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
}

function hexAlpha(hex, a) {
  if (hex.startsWith('rgb')) return hex;
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function drawBandChart(canvas, series, markers) {
  const { ctx, w, h } = resize(canvas);
  const c = themeColors();
  const pad = { l: 40, r: 8, t: 10, b: 18 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);

  if (!series.length) {
    ctx.fillStyle = c.muted;
    ctx.font = '10px ' + FONT_MONO;
    ctx.fillText('No die samples yet', pad.l, pad.t + 12);
    return;
  }

  let maxY = 0; let minY = Infinity;
  for (const s of series) {
    if (s.max != null) maxY = Math.max(maxY, s.max);
    if (s.min != null) minY = Math.min(minY, s.min);
  }
  if (!Number.isFinite(minY)) minY = 0;
  maxY = maxY * 1.08 || 1;
  minY = Math.max(0, minY * 0.92);

  ctx.strokeStyle = c.grid;
  ctx.fillStyle = c.muted;
  ctx.font = '9px ' + FONT_MONO;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + ph * (1 - i / 3);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + pw, y);
    ctx.stroke();
    const val = minY + (maxY - minY) * (i / 3);
    ctx.fillText(val.toFixed(0), 2, y + 3);
  }

  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const xAt = (t) => pad.l + ((t - t0) / span) * pw;
  const yAt = (v) => pad.t + ph * (1 - (v - minY) / (maxY - minY));

  // band
  ctx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const x = xAt(series[i].t);
    const y = yAt(series[i].max);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  for (let i = series.length - 1; i >= 0; i--) {
    ctx.lineTo(xAt(series[i].t), yAt(series[i].min));
  }
  ctx.closePath();
  ctx.fillStyle = c.band;
  ctx.fill();

  // mean
  pathSeries(ctx, series.map((s) => ({ t: s.t, v: s.mean })), xAt, yAt);
  ctx.strokeStyle = c.teal;
  ctx.lineWidth = 2;
  ctx.stroke();

  drawMarkers(ctx, markers, t0, t1, xAt, pad, ph, c.ink);
  return { t0, span, padL: pad.l, pw, padT: pad.t, ph, minY, maxY, color: c.teal };
}

const FAN_COLORS = ['#6d5bd0', '#1f8a70', '#b5651d', '#8a6d3b']; // none is a state colour (#28)

/**
 * Die temperature and fan speed on two fixed axes (#103; Ronald, 2026-09-28):
 * left °C from metrics.json's scale, right rpm from 0 to CONFIG.fanRpmMax.
 * Fixed, so a rise is the data moving, never the axis. The band is the die
 * min-max, the solid line its mean, the dashed its max; one line per fan.
 */
export function drawThermalChart(canvas, { die, fans, scale, rpmMax, markers }) {
  const { ctx, w, h } = resize(canvas);
  const c = themeColors();
  const pad = { l: 44, r: 52, t: 10, b: 18 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);
  const ts = [...die.map((s) => s.t), ...fans.map((s) => s.t)];
  if (!ts.length) {
    ctx.fillStyle = c.muted;
    ctx.font = '10px ' + FONT_MONO;
    ctx.fillText('No die or fan samples yet', pad.l, pad.t + 12);
    return undefined;
  }
  const t0 = Math.min(...ts), t1 = Math.max(...ts), span = Math.max(1, t1 - t0);
  const xAt = (t) => pad.l + ((t - t0) / span) * pw;
  const minY = scale.min, maxY = scale.max;
  const yC = (v) => pad.t + ph * (1 - (Math.min(maxY, Math.max(minY, v)) - minY) / (maxY - minY));
  const yR = (v) => pad.t + ph * (1 - Math.min(rpmMax, Math.max(0, v)) / rpmMax);
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.font = '9px ' + FONT_MONO;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + ph * (1 - i / 3);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.fillStyle = c.teal;
    ctx.fillText(`${(minY + (maxY - minY) * (i / 3)).toFixed(0)} °C`, 2, y + 3);
    ctx.fillStyle = c.muted;
    ctx.fillText(`${((rpmMax * i) / 3 / 1000).toFixed(1)}k rpm`, pad.l + pw + 4, y + 3);
  }
  if (die.length) {
    ctx.beginPath();
    die.forEach((s, i) => { const x = xAt(s.t), y = yC(s.max); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    for (let i = die.length - 1; i >= 0; i--) ctx.lineTo(xAt(die[i].t), yC(die[i].min));
    ctx.closePath();
    ctx.fillStyle = c.band;
    ctx.fill();
    pathSeries(ctx, die.map((s) => ({ t: s.t, v: s.mean })), xAt, yC);
    ctx.strokeStyle = c.teal; ctx.lineWidth = 2; ctx.setLineDash?.([]); ctx.stroke();
    pathSeries(ctx, die.map((s) => ({ t: s.t, v: s.max })), xAt, yC);
    ctx.lineWidth = 1.2; ctx.setLineDash?.([4, 3]); ctx.stroke(); ctx.setLineDash?.([]);
  }
  const names = [...new Set(fans.flatMap((s) => s.fans.map((f) => f.name)))];
  names.forEach((n, k) => {
    pathSeries(ctx, fans.map((s) => ({ t: s.t, v: s.fans.find((f) => f.name === n)?.rpm ?? null })), xAt, yR);
    ctx.strokeStyle = FAN_COLORS[k % FAN_COLORS.length]; ctx.lineWidth = 1.5; ctx.stroke();
  });
  drawMarkers(ctx, markers, t0, t1, xAt, pad, ph, c.ink);
  return { t0, span, padL: pad.l, pw, padT: pad.t, ph, minY, maxY, color: c.teal, fanColors: names.map((n, k) => [n, FAN_COLORS[k % FAN_COLORS.length]]) };
}

// Each fan reply with the die summary nearest it (within 10 s): the two sources keep their own times.
function thermalHoverSeries(fans, die) {
  if (!fans.length) return die.map((d) => ({ t: d.t, die: d, fans: [] }));
  return fans.map((f) => {
    let best = null;
    for (const d of die) if (Math.abs(d.t - f.t) <= 10_000 && (!best || Math.abs(d.t - f.t) < Math.abs(best.t - f.t))) best = d;
    return { t: f.t, fans: f.fans, die: best };
  });
}

function drawCoverageChart(canvas, series, markers) {
  const mapped = series.map((s) => ({
    t: s.t,
    v: s.configured ? (s.reporting / s.configured) * 100 : null,
  }));
  return drawLineChart(canvas, mapped, {
    color: themeColors().orange,
    zeroBase: true,
    fmtY: (v) => v.toFixed(0) + '%',
    markers,
  });
}

// #104: what the chart drew, for hover and focus; nothing when it drew no samples.
function hoverable(canvas, kind, series, geom, markers) {
  if (!canvas) return;
  const stepMs = series.length > 1 ? (series[series.length - 1].t - series[0].t) / (series.length - 1) : 0;
  canvas._hover = geom && series.length ? { kind, series, markers, stepMs, ...geom } : null;
  wireChartHover(canvas);
}

export function renderCharts(root, state) {
  if (!root) return;
  const now = Date.now();
  const win = windowMs(state);

  // window toggle pressed state
  root.querySelectorAll('[data-chart-window]').forEach((btn) => {
    const on = btn.getAttribute('data-chart-window') === state.chartWindow;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  const markers = state.restartMarkers || [];
  const note = restartNote(markers, now, win);
  const hr = sliceSeries(state.history.hashrate, now, win);
  const hrCanvas = root.querySelector('[data-chart="hashrate"]');
  const hrGeom = drawLineChart(hrCanvas, hr, {
    color: themeColors().teal,
    zeroBase: true,
    fmtY: (v) => {
      if (v >= 1e15) return (v / 1e15).toFixed(1) + 'P';
      if (v >= 1e12) return (v / 1e12).toFixed(1) + 'T';
      return v.toFixed(0);
    },
    markers,
  });
  hoverable(hrCanvas, 'hashrate', hr, hrGeom, markers);
  const lastHr = hr[hr.length - 1]?.v;
  hashrateHeader(root.querySelector('[data-chart-summary="hashrate"]'), state, lastHr, note, now);

  // die band: first board with history
  const dieBoards = Object.keys(state.history.die);
  const dieKey = dieBoards[0];
  const dieSeries = dieKey ? sliceSeries(state.history.die[dieKey], now, win) : [];
  // #103: the die band and the fans on one chart, two fixed axes.
  const fanKey = Object.keys(state.history.fans || {})[0];
  const fanSeries = fanKey ? sliceSeries(state.history.fans[fanKey], now, win) : [];
  const thCanvas = root.querySelector('[data-chart="thermal"]');
  const thGeom = drawThermalChart(thCanvas, { die: dieSeries, fans: fanSeries,
    scale: state.metrics?.die_temperature_c?.scale || { min: 40, max: 100 }, rpmMax: CONFIG.fanRpmMax, markers });
  hoverable(thCanvas, 'thermal', thermalHoverSeries(fanSeries, dieSeries), thGeom, markers);
  const lastFans = fanSeries[fanSeries.length - 1];
  setText(root.querySelector('[data-chart-legend="thermal"]'), thGeom?.fanColors?.length
    ? `die: band min–max, solid mean, dashed max (°C, left) · fans (rpm, right): ${thGeom.fanColors.map(([n]) => n).join(', ')}` : '');
  const legend = root.querySelector('[data-chart-legend="thermal"]');
  if (legend && thGeom?.fanColors) legend.setAttribute?.('data-fan-colors', thGeom.fanColors.map(([n, col]) => `${n}:${col}`).join(' '));

  // #106: J/TH from the harness's wall-side input power; none without it.
  const pw = sliceSeries(state.history.power || [], now, win);
  const jCanvas = root.querySelector('[data-chart="jth"]');
  hoverable(jCanvas, 'jth', pw, drawLineChart(jCanvas, pw, { color: themeColors().orange, tight: true, fmtY: (v) => v.toFixed(1), markers,
    emptyText: 'no input power reported' }), markers);
  const lastP = pw[pw.length - 1];
  setText(root.querySelector('[data-chart-summary="jth"]'), lastP && lastP.v != null
    ? `${fmtNum(lastP.v, 1)} J/TH · ${String(Math.round(lastP.w)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} W input · wall-side, harness · ${state.chartWindow}${note}`
    : 'not reported: needs a measured input power (from a test harness, or from Mujina once it reports one)');
  const lastDie = dieSeries[dieSeries.length - 1];
  setText(root.querySelector('[data-chart-summary="thermal"]'),
    !lastDie && !lastFans ? 'no data'
      : `${lastDie ? `die mean ${fmtTemp(lastDie.mean)} · max ${fmtTemp(lastDie.max)}` : 'die: no summary yet'}`
        + `${lastFans ? ` · fans ${lastFans.fans.map((f) => f.rpm ?? '?').join(' / ')} rpm` : ''} · ${state.chartWindow}${note}`);

  const covKey = Object.keys(state.history.coverage)[0];
  const covSeries = covKey ? sliceSeries(state.history.coverage[covKey], now, win) : [];
  const covCanvas = root.querySelector('[data-chart="coverage"]');
  hoverable(covCanvas, 'coverage', covSeries, drawCoverageChart(covCanvas, covSeries, markers), markers);
  const lastCov = covSeries[covSeries.length - 1];
  setText(root.querySelector('[data-chart-summary="coverage"]'),
    !lastCov ? 'no data'
      : `${covKey}: ${lastCov.reporting}/${lastCov.configured} reporting · ${state.chartWindow}${note}`);
}

export function wireChartControls(root, onWindow) {
  if (!root) return;
  root.querySelectorAll('[data-chart-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onWindow(btn.getAttribute('data-chart-window'));
    });
  });
}

/**
 * #83: the hashrate chart header is a scheduler-published value, so it is
 * live, stale or lost exactly as the KPI hashrate is.
 */
export function hashrateHeader(el, state, lastHr, note = '', now = Date.now()) {
  if (!el) return;
  const tail = ` · window ${state.chartWindow} · time received by this browser${note}`;
  if (lastHr == null) { renderValue(el, { text: `no data · ring resets on reload${note}`, now }); return; }
  const sched = schedulerFieldsState(state, now);
  renderValue(el, { text: `${fmtHashrate(lastHr)}${tail}`, ...sched, now, lostText: `${LOST_TEXT}${tail}` });
}
