/** Snapshot store — widgets subscribe; no widget fetches. */
import { nextSharesRate } from './shares-rate.js';
import { CONFIG } from './config.js';
import { schedulerFieldsStale } from './freshness.js';

const listeners = new Set();

const state = {
  miner: null,
  minerAt: null,
  summaries: Object.create(null), // boardName -> { data, at }
  // #54: boardName -> { bit -> { n, ids, at } }; cleared only by a measured clear.
  faultLatch: Object.create(null),
  // #62: boardName -> { seen: {key: bool}, rises: {key: firstSeenAt} }, key = thread:wire:bit.
  minerFaults: Object.create(null),
  chain: Object.create(null),
  layout: null,
  metrics: null,
  chartWindow: '1m',
  history: {
    hashrate: [],
    die: Object.create(null), // board -> [{t,min,mean,max}]
    coverage: Object.create(null),
    fans: Object.create(null), // board -> [{t, fans:[{name,rpm,percent}]}] (#103)
    power: [], // [{t, v: J/TH, w: input W}] from the harness (#106)
  },
  lastUptime: null,
  lastUptimeAt: null,
  uptimeAdvancedAt: null, // browser time uptime_secs last changed value (#8)
  lastImpliedStart: null,
  restartMarkers: [],
  sharesPrev: null,
  sharesPrevAt: null,
  // Pool card (Ronald, 2026-09-28): when the pool's accepted count last rose,
  // and when this page first saw a count, both on the browser's clock.
  poolAcceptedAt: null,
  poolAcceptedPrev: null,
  poolWatchFrom: null,
  sharesPerMin: null,
  sharesRate: null, // shares-rate.js derivation state (#13)
  cost: { lastOkAt: null }, // rates: poller.measuredCost(now)
  apiDown: false,
  apiDownSince: null, // browser time the API was declared down (#15)
};

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { /* keep other subscribers alive */ }
  }
}

export function setLayout(layout) {
  state.layout = layout;
  notify();
}

/**
 * Merge server-held history (./history.json) into the chart rings. Ronald,
 * 2026-09-28: the page lost everything on a tab switch and refilled slowly.
 * The poller pauses while the tab is hidden (by design), so the page asks
 * whoever serves it for the samples it missed, on load and on return. Past
 * samples only: the current state (miner, minerAt, summaries) comes from the
 * next poll, so history can never make stale data look live.
 */
export function mergeHistory(h) {
  if (!h || typeof h !== 'object') return;
  const cut = Date.now() - CONFIG.chartBufferMs;
  const merge = (ring, rows, toEntry) => {
    if (!Array.isArray(rows) || !rows.length) return ring;
    const have = new Set(ring.map((x) => x.t));
    for (const r of rows) {
      const e = Array.isArray(r) ? toEntry(r) : null;
      if (e && Number.isFinite(e.t) && e.t >= cut && !have.has(e.t)) { ring.push(e); have.add(e.t); }
    }
    ring.sort((a, b) => a.t - b.t);
    return ring;
  };
  merge(state.history.hashrate, h.hashrate, ([t, v]) => ({ t, v }));
  for (const [b, rows] of Object.entries(h.die || {})) {
    state.history.die[b] = merge(state.history.die[b] || [], rows, ([t, min, mean, max, spread]) => ({ t, min, mean, max, spread }));
  }
  for (const [b, rows] of Object.entries(h.coverage || {})) {
    state.history.coverage[b] = merge(state.history.coverage[b] || [], rows,
      ([t, reporting, configured, suppressed, neverSeen]) => ({ t, reporting, configured, suppressed, neverSeen }));
  }
  for (const [b, rows] of Object.entries(h.fans || {})) {
    state.history.fans[b] = merge(state.history.fans[b] || [], rows,
      ([t, fans]) => ({ t, fans: (Array.isArray(fans) ? fans : []).map(([name, rpm, percent]) => ({ name, rpm, percent })) }));
  }
  merge(state.history.power, h.power, ([t, v, w]) => ({ t, v, w }));
  notify();
}

/** The pool dataset (#101); absent until loaded, and the card then shows the host. */
export function setPools(pools) {
  state.pools = pools;
  notify();
}

export function setMetrics(metrics) {
  state.metrics = metrics;
  notify();
}

export function setChartWindow(key) {
  state.chartWindow = key;
  notify();
}

function pushRing(arr, sample, maxAgeMs) {
  arr.push(sample);
  const cutoff = sample.t - maxAgeMs;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

/**
 * Restart detection (#25). A restart is (a) uptime going backwards, or (b)
 * the implied start time (receipt - uptime) jumping forward by more than
 * CONFIG.restartStartJumpMs while uptime did change, which catches a restart
 * inside a long hidden / down gap. A frozen uptime (scheduler stale, #8) moves
 * the implied start too, but uptime is unchanged, so it is not a restart.
 */
function detectRestart(uptimeSecs, at) {
  const prev = state.lastUptime;
  if (prev == null) return false;
  if (uptimeSecs < prev) return true;
  if (uptimeSecs === prev || state.lastImpliedStart == null) return false;
  const implied = at - uptimeSecs * 1000;
  return implied - state.lastImpliedStart > CONFIG.restartStartJumpMs;
}

export function setMiner(miner, at = Date.now()) {
  trackMinerFaults(miner, at);
  const acc = Array.isArray(miner?.sources) ? miner.sources[0]?.shares_accepted : undefined;
  if (Number.isFinite(acc)) {
    if (state.poolWatchFrom == null) state.poolWatchFrom = at;
    if (state.poolAcceptedPrev != null && acc > state.poolAcceptedPrev) state.poolAcceptedAt = at;
    state.poolAcceptedPrev = acc;
  }
  if (miner && typeof miner.uptime_secs === 'number') {
    if (detectRestart(miner.uptime_secs, at)) {
      state.restartMarkers.push(at);
      const cutoff = at - CONFIG.chartBufferMs;
      while (state.restartMarkers.length && state.restartMarkers[0] < cutoff) state.restartMarkers.shift();
      state.sharesPrev = null;
      state.sharesPerMin = null;
    }
    // #8: first receipt, and every change of value (a drop included).
    if (state.lastUptime == null || miner.uptime_secs !== state.lastUptime) state.uptimeAdvancedAt = at;
    state.lastUptime = miner.uptime_secs;
    state.lastUptimeAt = at;
    state.lastImpliedStart = at - miner.uptime_secs * 1000;
  }

  if (miner && miner.paused === true) {
    // #66 (Ronald, 2026-09-25): no rate is derived while paused, and on
    // resume the derivation starts over from after the resume.
    state.sharesPrev = null;
    state.sharesRate = null;
    state.sharesPerMin = null;
  } else if (miner && typeof miner.shares_submitted === 'number') {
    // #13: Δshares ÷ Δuptime on the server's clock, only on a publish.
    // sharesPrev is null on the first receipt and after a restart (#25).
    state.sharesRate = nextSharesRate(state.sharesPrev == null ? null : state.sharesRate, miner);
    state.sharesPerMin = state.sharesRate.perMin;
    state.sharesPrev = miner.shares_submitted;
    state.sharesPrevAt = at;
  }

  state.miner = miner;
  state.minerAt = at;
  state.apiDown = false;
  state.apiDownSince = null;

  if (miner && typeof miner.hashrate === 'number') {
    pushRing(state.history.hashrate, { t: at, v: miner.hashrate }, 900_000);
  }
  // #103: each board's fans on every reply; #106: the harness's power, once per reading.
  for (const b of Array.isArray(miner?.boards) ? miner.boards : []) {
    if (!b?.name || !Array.isArray(b.fans) || !b.fans.length) continue;
    if (!state.history.fans[b.name]) state.history.fans[b.name] = [];
    pushRing(state.history.fans[b.name], { t: at, fans: b.fans.map((f) => ({ name: f?.name, rpm: f?.rpm ?? null, percent: f?.percent ?? null })) }, 900_000);
  }
  const hz = miner?.harness;
  if (hz && Number.isFinite(hz.input_w) && hz.input_w_at && hz.input_w_at !== state.powerAt) {
    state.powerAt = hz.input_w_at;
    pushRing(state.history.power, { t: at, v: Number.isFinite(hz.j_per_th) ? hz.j_per_th : null, w: hz.input_w }, 900_000);
  }
  notify();
}

/** Scheduler fields stale at `now` (#8): uptime unchanged > schedulerStaleSecs. */
export function schedulerStale(now = Date.now()) {
  return schedulerFieldsStale(state.uptimeAdvancedAt, now);
}

/**
 * An asic-summary failed (#6; spec :90-91): keep the last data, marked
 * unavailable, never replaced by zero. The next success clears it.
 */
export function markSummaryFailed(boardName, at = Date.now()) {
  const prev = state.summaries[boardName];
  state.summaries[boardName] = { data: prev?.data ?? null, at: prev?.at ?? null, unavailable: true, failedAt: at };
  notify();
}

export function setSummary(boardName, data, at = Date.now()) {
  state.summaries[boardName] = { data, at };
  latchFaults(boardName, data?.board?.faults, at);
  // #62: once a live summary returns, it is the only source again.
  if (state.minerFaults[boardName]) state.minerFaults[boardName].rises = Object.create(null);
  const die = data?.board?.die_temperature_c;
  if (die && die.min != null) {
    if (!state.history.die[boardName]) state.history.die[boardName] = [];
    pushRing(state.history.die[boardName], {
      t: at, min: die.min, mean: die.mean, max: die.max, spread: die.spread,
    }, 900_000);
  }
  const cov = data?.board?.coverage;
  if (cov && cov.asics_configured != null) {
    if (!state.history.coverage[boardName]) state.history.coverage[boardName] = [];
    pushRing(state.history.coverage[boardName], {
      t: at,
      reporting: cov.asics_reporting,
      configured: cov.asics_configured,
      suppressed: cov.asics_value_suppressed,
      neverSeen: cov.asics_never_seen,
    }, 900_000);
  }
  notify();
}

export function setChain(boardName, data, at = Date.now()) {
  state.chain[boardName] = { data, at };
  notify();
}

export function setCost(cost) {
  state.cost = { ...state.cost, ...cost };
  notify();
}

export function markApiDown(at = Date.now()) {
  if (!state.apiDown) state.apiDownSince = at;
  state.apiDown = true;
  notify();
}

/**
 * #54 (Ronald, 2026-09-28): a red fault stays red until a later summary
 * MEASURES that bit clear. bits: null, not_retained, or a stale or aged-out
 * ASIC never clears it: a chain that goes quiet after a trip is exactly how a
 * bit stops being reported.
 */
function latchFaults(boardName, faults, at) {
  const latch = (state.faultLatch[boardName] ||= Object.create(null));
  if (faults?.availability !== 'measured' || !Array.isArray(faults.bits)) return;
  const asserted = new Set();
  for (const b of faults.bits) {
    if ((b.asics_asserting || 0) > 0) {
      asserted.add(b.bit);
      latch[b.bit] = { n: b.asics_asserting, ids: Array.isArray(b.asic_ids) ? b.asic_ids : [], at };
    }
  }
  for (const bit of Object.keys(latch)) if (!asserted.has(bit)) delete latch[bit];
}

/**
 * #62 (Ronald, 2026-09-25): record each /miner asics[] fault flag, and the
 * moment this browser saw one rise from clear to asserted. A flag already set
 * at first sight is not a rise; a flag that clears drops its rise.
 */
function trackMinerFaults(miner, at) {
  for (const b of (Array.isArray(miner?.boards) ? miner.boards : [])) {
    const mf = (state.minerFaults[b.name] ||= { seen: Object.create(null), rises: Object.create(null) });
    for (const a of (Array.isArray(b.asics) ? b.asics : [])) {
      for (const [bit, on] of Object.entries(a?.faults || {})) {
        const key = `${a.thread_index}:${a.id}:${bit}`;
        if (on === true && mf.seen[key] === false && !(key in mf.rises)) mf.rises[key] = at;
        if (on !== true) delete mf.rises[key];
        mf.seen[key] = on === true;
      }
    }
  }
}
