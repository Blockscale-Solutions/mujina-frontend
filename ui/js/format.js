/** Unit formatters — null/absent never render as 0. */

export function fmtUnknown(kind = 'unknown') {
  if (kind === 'not_reported') return 'not reported';
  if (kind === 'not_exposed') return 'not exposed';
  return 'unknown';
}

export function fmtHashrate(hs) {
  if (hs == null || Number.isNaN(hs)) return fmtUnknown();
  const n = Number(hs);
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)} PH/s`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TH/s`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GH/s`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MH/s`;
  return `${n.toFixed(0)} H/s`;
}

export function fmtTemp(c) {
  if (c == null || Number.isNaN(c)) return fmtUnknown();
  return `${Number(c).toFixed(1)} °C`;
}

export function fmtNum(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return fmtUnknown();
  return Number(n).toFixed(digits);
}

export function fmtUptime(secs) {
  if (secs == null || Number.isNaN(secs)) return fmtUnknown();
  const s = Math.max(0, Math.floor(Number(secs)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

export function fmtAge(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Relative age for sighted operators: '12 s ago', '3 min 5 s ago'. */
export function fmtAgo(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s ago`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
}

/** Local HH:MM:SS (browser time). */
export function fmtClock(t) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function fmtKBps(bps) {
  if (bps == null) return '—';
  return `${(bps / 1024).toFixed(1)} KB/s`;
}

export function fmtReqPs(r) {
  if (r == null) return '—';
  return `${r.toFixed(2)} req/s`;
}
