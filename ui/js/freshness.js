import { CONFIG } from './config.js';

/**
 * Freshness state machine: live | stale | lost
 * Uses browser receipt time (monotonic performance.now / Date.now).
 */
export function classifyFreshness(lastOkMs, intervalMs, nowMs = Date.now()) {
  if (lastOkMs == null) return 'lost';
  const age = nowMs - lastOkMs;
  if (age > CONFIG.lostAfterMs) return 'lost';
  if (age > intervalMs * CONFIG.liveMultiplier) return 'stale';
  return 'live';
}

/**
 * Scheduler fields (#8; spec :101, hard rule 6). uptime_secs, hashrate,
 * shares_submitted and paused change only when the scheduler publishes (10 s
 * tick, pause / resume), while /miner keeps answering from the watch. They
 * are stale when uptime_secs has not changed value for more than
 * schedulerStaleSecs. `uptimeAdvancedAtMs` is the browser time uptime last
 * changed (store.uptimeAdvancedAt), not the time of the last receipt.
 */
export function schedulerFieldsStale(uptimeAdvancedAtMs, nowMs = Date.now()) {
  if (uptimeAdvancedAtMs == null) return false; // nothing received yet: no scheduler fields shown
  return nowMs - uptimeAdvancedAtMs > CONFIG.schedulerStaleSecs * 1000;
}

/**
 * Per-board asic-summary state, shared by the safety strip and the board
 * cards so the page gives one answer per board (#56, #14).
 *
 * The age class and the failure are reported side by side, never one
 * instead of the other:
 *   age: 'live' | 'stale' | 'lost'. It comes from the receipt time of the
 *        last GOOD summary only (hard rule 6). No summary ever received is
 *        'lost'. While the API is down every summary is 'lost'.
 *   unavailable: the last asic-summary request failed (spec :90-91). The
 *        last data is kept.
 *   live: age is 'live' and the last request did not fail.
 */
export function summaryState(entry, nowMs = Date.now(), apiDown = false) {
  const at = entry?.at ?? null;
  // #90 (Ronald, 2026-09-28): each value keeps its own freshness, so a
  // /miner-only outage (apiDown) does not age a summary its own endpoint still
  // answers; and a failed poll is a flap, not a state: the age alone decides,
  // turning stale past liveMultiplier x the interval (two polls), so
  // intermittent failures raise no flood of changes. 'unavailable' is still
  // reported at once, for the legend and the chip. (apiDown is kept in the
  // signature for callers; it no longer changes the age.)
  void apiDown;
  const age = classifyFreshness(at, CONFIG.asicSummaryIntervalMs, nowMs);
  const unavailable = !!entry?.unavailable;
  return { age, unavailable, at, never: at == null, live: age === 'live' };
}

/**
 * Fields read straight from /miner's watch (fans, thread rows), #90: they
 * age with the last /miner reply, and are lost while the API is down.
 */
export function minerFieldsState(state, nowMs = Date.now()) {
  const minerAt = state?.minerAt ?? null;
  const secs = minerAt != null ? Math.max(0, Math.floor((nowMs - minerAt) / 1000)) : null;
  if (state?.apiDown) return { cls: 'lost', cause: 'Mujina API not answering', asOf: minerAt };
  const cls = classifyFreshness(minerAt, CONFIG.minerIntervalMs, nowMs);
  if (cls === 'lost') return { cls, cause: minerAt == null ? 'no /miner reply yet' : `no /miner reply for ${secs} s`, asOf: minerAt };
  if (cls === 'stale') return { cls, staleText: `stale ${secs} s`, cause: '/miner reply late', asOf: minerAt };
  return { cls: 'live', asOf: minerAt };
}

/**
 * Scheduler-published fields (hashrate, shares, uptime), per Ronald's
 * lost-tiles decision on #14 (2026-09-25). Priority lost > stale > live:
 *   lost:  the API is down, OR the last /miner reply is more than
 *          lostAfterMs old, OR uptime has been frozen for more than
 *          lostAfterMs;
 *   stale: uptime frozen for more than schedulerStaleSecs (#8).
 * `asOf` is the browser receipt time of the newest value: when uptime last
 * changed, which is never later than the last /miner reply.
 * The #63 derived-rate states ("calculating…", "preliminary") belong only
 * inside 'live'; stale and lost always take priority over them.
 */
export function schedulerFieldsState(state, nowMs = Date.now()) {
  const minerAt = state?.minerAt ?? null;
  const advancedAt = state?.uptimeAdvancedAt ?? null;
  const asOf = advancedAt ?? minerAt;
  const secs = (t) => Math.floor((nowMs - t) / 1000);
  const lostMs = CONFIG.lostAfterMs;
  if (state?.apiDown) return { cls: 'lost', cause: 'Mujina API not answering', asOf };
  if (minerAt != null && nowMs - minerAt > lostMs) {
    return { cls: 'lost', cause: `no /miner reply for ${secs(minerAt)} s`, asOf };
  }
  if (advancedAt != null && nowMs - advancedAt > lostMs) {
    return { cls: 'lost', cause: `uptime unchanged for ${secs(advancedAt)} s: scheduler not publishing`, asOf };
  }
  if (schedulerFieldsStale(advancedAt, nowMs)) {
    return { cls: 'stale', staleText: `stale ${secs(advancedAt)} s`, cause: 'scheduler not publishing, uptime unchanged', asOf };
  }
  return { cls: 'live', asOf };
}
