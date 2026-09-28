/**
 * The hottest and coldest cells to outline, from this bus's asic-summary
 * aggregate (#17, spec hard rule 4: never recomputed in the browser). An
 * extreme on another thread, one with no wire id, or a lost summary gives no
 * outline rather than a guessed one.
 */
export function summaryExtremes(aggregate, threadIndex, lost) {
  const pick = (e) => {
    if (lost || !e || e.wire_asic_id == null) return null;
    if (e.thread_index != null && threadIndex != null && e.thread_index !== threadIndex) return null;
    return { wireId: e.wire_asic_id };
  };
  return { hottest: pick(aggregate?.hottest), coldest: pick(aggregate?.coldest) };
}

/** The grid's layout, shared by drawing and hit-testing (#102). */
export function gridGeometry(w, h, rows, cols) {
  const gap = 1;
  return { gap, cw: (w - gap * (cols + 1)) / cols, ch: (h - gap * (rows + 1)) / rows };
}

/** The cell index under (x, y) in CSS pixels, or null in a gap or past the configured cells. */
export function cellAt(x, y, w, h, rows, cols, configured = rows * cols) {
  const { gap, cw, ch } = gridGeometry(w, h, rows, cols);
  const c = Math.floor((x - gap) / (cw + gap));
  const r = Math.floor((y - gap) / (ch + gap));
  if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
  if (x - gap - c * (cw + gap) > cw || y - gap - r * (ch + gap) > ch) return null;
  const i = r * cols + c;
  return i < configured ? i : null;
}

/**
 * Canvas 10×10 heatmap. Logical wire order, not physical.
 * Redraw on store update only (caller invokes).
 */
export function drawHeatmap(canvas, opts) {
  if (!canvas) return;
  const {
    rows = 10,
    cols = 10,
    cells = [], // one bus: {bus, wireId, temp, fault?}, unique wireId
    configured = 100,
    scale = { min: 40, max: 100 },
    stale = false,
    reducedMotion = false,
    hottest = null, // { wireId } from summaryExtremes, or none
    coldest = null,
    focusWire = null, // #102: the keyboard's cell, outlined
    hoverWire = null, // the pointer's cell, glowing (Ronald, 2026-09-28)

  } = opts || {};

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(40, rect.width);
  const h = Math.max(40, rect.height);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { gap, cw, ch } = gridGeometry(w, h, rows, cols);

  const faults = [];
  const byWire = new Map();
  for (const c of cells) byWire.set(c.wireId, c);

  for (let i = 0; i < rows * cols; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = gap + c * (cw + gap);
    const y = gap + r * (ch + gap);
    const wireId = i; // logical 0..configured-1
    const cell = byWire.get(wireId);

    if (i >= configured) {
      ctx.fillStyle = 'transparent';
      ctx.fillRect(x, y, cw, ch);
      continue;
    }

    if (!cell || cell.temp == null) {
      hatch(ctx, x, y, cw, ch, stale ? '#556069' : '#9a948a');
    } else {
      ctx.fillStyle = tempColor(cell.temp, scale.min, scale.max);
      ctx.fillRect(x, y, cw, ch);
      if (cell.fault) faults.push([x, y]);
    }

    if (hottest && hottest.wireId === wireId) {
      ctx.strokeStyle = '#E86A2B';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }
    if (coldest && coldest.wireId === wireId && (!hottest || coldest.wireId !== hottest.wireId)) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }
  }

  if (stale && !reducedMotion) {
    ctx.fillStyle = 'rgba(154,148,138,0.25)';
    ctx.fillRect(0, 0, w, h);
  }
  // A fault is never dimmed away (AGENTS.md): outlines go on top of the wash.
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 1.5;
  for (const [x, y] of faults) ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
  if (hoverWire != null && hoverWire < configured) {
    const x = gap + (hoverWire % cols) * (cw + gap);
    const y = gap + Math.floor(hoverWire / cols) * (ch + gap);
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, cw + 2, ch + 2);
    ctx.restore();
  }
  if (focusWire != null && focusWire < configured) {
    const x = gap + (focusWire % cols) * (cw + gap);
    const y = gap + Math.floor(focusWire / cols) * (ch + gap);
    const ink = typeof getComputedStyle === 'function' ? getComputedStyle(canvas).getPropertyValue('--ink').trim() : '';
    ctx.strokeStyle = ink || '#1a1917';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 0.5, y - 0.5, cw + 1, ch + 1);
  }
}

function hatch(ctx, x, y, w, h, color) {
  ctx.fillStyle = 'rgba(154,148,138,0.15)';
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.45;
  for (let i = -h; i < w + h; i += 3) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
    ctx.stroke();
  }
  ctx.restore();
}

function tempColor(t, min, max) {
  const u = Math.max(0, Math.min(1, (t - min) / (max - min || 1)));
  // color-blind-safe-ish blue → amber → red
  if (u < 0.5) {
    const v = u * 2;
    return lerpColor('#3b82f6', '#f59e0b', v);
  }
  return lerpColor('#f59e0b', '#ef4444', (u - 0.5) * 2);
}

function lerpColor(a, b, t) {
  const pa = hex(a); const pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function hex(h) {
  const n = h.replace('#', '');
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
