/**
 * shares/min, derived (#13; spec :99, hard rule 4).
 *
 * `shares_submitted` and `uptime_secs` change only when the scheduler
 * publishes (10 s tick, pause / resume), while /miner is polled every ~2 s.
 * A per-poll delta on browser time therefore reads 0 between publishes and
 * spikes on them. Instead the rate uses the server's own clock:
 *
 *   rate = Δshares_submitted ÷ Δuptime_secs over the publishes in the last
 *          sharesRateWindowSecs of server uptime,
 *
 * sampled only when uptime_secs has advanced (a publish), held unchanged
 * between publishes (and while uptime is frozen, #8), and reported only once
 * the span reaches sharesRateMinSpanSecs; before that it is "deriving", never
 * a fake 0.0. A drop in either counter (a restart, #25) starts the
 * derivation again rather than producing a negative rate.
 */
import { CONFIG } from './config.js';

export const EMPTY_RATE = Object.freeze({ samples: [], perMin: null, spanSecs: 0 });

/**
 * Next derivation state after one /miner receipt. `prev` null starts over
 * (first receipt or restart). Pure: returns `prev` itself when nothing moved.
 */
export function nextSharesRate(prev, miner, cfg = CONFIG) {
  const up = miner?.uptime_secs;
  const sh = miner?.shares_submitted;
  const state = prev ?? EMPTY_RATE;
  if (typeof up !== 'number' || typeof sh !== 'number') return state;
  const last = state.samples[state.samples.length - 1];
  if (last && up === last.uptime) return state; // no publish since: hold
  let samples = state.samples;
  if (last && (up < last.uptime || sh < last.shares)) samples = []; // counter reset
  samples = [...samples, { uptime: up, shares: sh }];
  // Keep the newest sample at or before the window start, so the span can
  // reach the full window.
  const start = up - cfg.sharesRateWindowSecs;
  while (samples.length > 2 && samples[1].uptime <= start) samples.shift();
  const first = samples[0];
  const spanSecs = up - first.uptime;
  const perMin = spanSecs >= cfg.sharesRateMinSpanSecs ? ((sh - first.shares) * 60) / spanSecs : null;
  return { samples, perMin, spanSecs };
}

function fmtSpan(secs) {
  return secs < 120 ? `${Math.round(secs)} s` : `${Math.round(secs / 60)} min`;
}

/** KPI note for the shares card: the rate, its derivation and its span. */
export function sharesRateNote(rate, fmtNum, cfg = CONFIG) {
  if (!rate || rate.perMin == null) {
    return `shares/min: deriving… (Δshares ÷ Δuptime needs ${cfg.sharesRateMinSpanSecs} s of scheduler publishes)`;
  }
  return `${fmtNum(rate.perMin, 1)} shares/min (derived: Δshares ÷ Δuptime over ${fmtSpan(rate.spanSecs)})`;
}
