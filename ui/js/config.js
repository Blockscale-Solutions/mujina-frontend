/** Poll intervals and budgets — single source of truth. */
export const CONFIG = {
  /** Allowlisted GET paths only. */
  allowlist: Object.freeze([
    '/api/v0/miner',
    '/api/v0/boards/{name}/bzm2/asic-summary',
    '/api/v0/boards/{name}/bzm2/chain-summary',
    '/api/v0/health',
  ]),

  minerIntervalMs: 2000,
  asicSummaryIntervalMs: 5000,
  chainSummaryOnLoad: true,

  /**
   * Per-request deadlines (#3). Every fetch carries an AbortSignal; a request
   * that has not delivered its full body by the deadline is aborted, recorded
   * as a failure and releases the serial queue.
   *  - /miner: minerTimeoutIntervals x minerIntervalMs (default 2 x 2000 ms).
   *  - asic-summary / chain-summary: 8000 ms, longer than the server's 5 s
   *    COMMAND_REPLY_WAIT so replies the board is still producing are kept.
   */
  minerTimeoutIntervals: 2,
  healthTimeoutMs: 2000,
  asicSummaryTimeoutMs: 8000,
  chainSummaryTimeoutMs: 8000,

  /**
   * Freshness clock (#4): re-render time-dependent output this often, so
   * live -> stale -> lost happens even when no request completes. Stopped
   * while the tab is hidden.
   */
  freshnessTickMs: 1000,

  /**
   * Backoff (#11), per endpoint and per board for summaries: base, 2 x base,
   * ... capped, with +/- jitter, never an immediate retry. While /miner is
   * failing only /health is probed, on this backoff.
   */
  backoffBaseMs: 2000,
  backoffCapMs: 30000,
  backoffJitter: 0.2,

  /**
   * API down (#15): one failed /miner is a blip, not an outage. The API is
   * declared down, and the poller goes health-only, after this many
   * consecutive /miner failures (a timeout, a network error, a non-2xx, or a
   * 200 whose body does not parse). Below it, /miner keeps its normal cadence
   * plus backoff. The pill follows /miner freshness only (stale at
   * liveMultiplier x interval, lost at lostAfterMs), never apiDown.
   */
  apiDownAfterFailures: 3,

  /**
   * Restart detection (#25): besides uptime going backwards, a restart is
   * inferred when the implied start time (receipt time - uptime) jumps
   * forward by more than this, which catches a restart inside a long hidden
   * or down gap. Larger than the ~10 s publish jitter plus one poll.
   */
  restartStartJumpMs: 30000,

  /** Caps (hard). */
  maxReqPerSec: 1.2,
  maxReqWindowMs: 10000,
  maxKBps: 100,
  maxKBWindowMs: 60000,
  // #22: /miner is ~161-230 KB on the unit, so its delay adapts to the last
  // body size to keep the tab under maxKBps (see poller nextMinerDelayMs).
  // #46: the delay is sized against the *planned* rate of the other
  // endpoints (boards x summary size / asicSummaryIntervalMs, plus one-shot
  // chain-summary / health bytes still in the window), counts the extra body
  // a 60 s window can hold at its edges, and aims this fraction under the cap
  // (headers, jitter, a summary that grows).
  byteCapMargin: 0.03,
  // Assumed asic-summary size for a board whose first summary has not
  // arrived yet (the mock's is ~5.7 KB), so early windows are not underrated.
  summaryBytesPrior: 8192,

  /** Freshness. */
  liveMultiplier: 2,
  schedulerStaleSecs: 25,
  // #13: shares/min = Δshares_submitted ÷ Δuptime_secs over this much server
  // uptime (both only move on the scheduler's 10 s publish), shown once the
  // span reaches the minimum; "deriving…" before that, never a fake 0.0.
  sharesRateWindowSecs: 300,
  sharesRateMinSpanSecs: 30,
  lostAfterMs: 60000,

  /** Chart windows (ms). Default 1m for heavy charts. */
  chartWindows: Object.freeze({
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
  }),
  defaultChartWindow: '1m',
  chartBufferMs: 900_000,
  // #103: the fan axis runs 0 to this (100 % duty measured 6,660 to 6,900 rpm on the test unit).
  fanRpmMax: 7000,

  /** Optional cheap KPI spark cadence (not used for heavy charts). */
  sparkLiveMs: 3000,

  footerCreditUrl: '',
  footerCreditLabel: 'Built on Mujina · GPL-3.0-or-later',

  storageThemeKey: 'mujina-theme',
};

/** Build allowlisted asic-summary path for a board name. */
export function asicSummaryPath(boardName) {
  return `/api/v0/boards/${encodeURIComponent(boardName)}/bzm2/asic-summary`;
}

export function chainSummaryPath(boardName) {
  return `/api/v0/boards/${encodeURIComponent(boardName)}/bzm2/chain-summary`;
}

/** Deadline (ms) for one request to an allowlisted path (#3). */
export function requestTimeoutFor(path) {
  const bare = String(path).split('?')[0];
  if (bare === '/api/v0/miner') return CONFIG.minerTimeoutIntervals * CONFIG.minerIntervalMs;
  if (bare === '/api/v0/health') return CONFIG.healthTimeoutMs;
  if (bare.endsWith('/bzm2/asic-summary')) return CONFIG.asicSummaryTimeoutMs;
  if (bare.endsWith('/bzm2/chain-summary')) return CONFIG.chainSummaryTimeoutMs;
  return CONFIG.healthTimeoutMs;
}

/** Return true if path matches allowlist (with {name} wildcard). */
export function isAllowlistedPath(path) {
  const bare = path.split('?')[0];
  if (bare === '/api/v0/miner' || bare === '/api/v0/health') return true;
  const m = bare.match(/^\/api\/v0\/boards\/[^/]+\/bzm2\/(asic-summary|chain-summary)$/);
  return !!m;
}
