/**
 * Poller: one serial queue (never more than one request in flight), one
 * timer chain per endpoint, budget meter, pause when hidden.
 * GET allowlist only. Soft-fail: never throw into render.
 *
 * Scheduling rules (#11, #12, #22, #25, #37):
 *  - The queue holds at most one entry per endpoint (per board for
 *    summaries). A tick whose endpoint is already queued or in flight is
 *    skipped and counted, never stacked. /miner goes to the front.
 *  - Each endpoint re-arms its own timer from the start of its last request.
 *    /miner's delay adapts to its last body size so the tab stays under the
 *    byte cap; a request slower than its interval skips ticks.
 *  - Failures back off per endpoint (per board for summaries), with jitter,
 *    never retrying immediately. While /miner is failing only /health is
 *    probed; /miner and summaries resume after a /health success.
 *  - After a restart chain-summary is fetched again; a failed chain-summary
 *    is retried on its backoff.
 *  - Becoming visible polls /miner only if the last one started at least one
 *    interval ago; otherwise it waits for the remainder.
 */
import {
  CONFIG, asicSummaryPath, chainSummaryPath, isAllowlistedPath, requestTimeoutFor,
} from './config.js';
import * as store from './store.js';

const log = []; // {t, path, bytes, ok, timedOut}

function record(path, bytes, ok, timedOut = false) {
  const t = Date.now();
  log.push({ t, path, bytes, ok, timedOut });
  const cutoff = t - CONFIG.maxKBWindowMs;
  while (log.length && log[0].t < cutoff) log.shift();
  // Only lastOkAt is cached; rates are computed at render time (#4).
  store.setCost({ lastOkAt: ok ? t : store.getState().cost.lastOkAt });
}

/**
 * The tab's own measured cost, computed from the request log at `now`
 * (#4, spec: never cached, never typed). An empty window reads 0.
 */
export function measuredCost(now = Date.now()) {
  const win10 = log.filter((e) => e.t <= now && now - e.t <= CONFIG.maxReqWindowMs);
  const win60 = log.filter((e) => e.t <= now && now - e.t <= CONFIG.maxKBWindowMs);
  const reqPerSec = win10.length / (CONFIG.maxReqWindowMs / 1000);
  const bytes60 = win60.reduce((s, e) => s + e.bytes, 0);
  const kbPerSec = bytes60 / 1024 / (CONFIG.maxKBWindowMs / 1000);
  return { reqPerSec, kbPerSec };
}

let stopped = true;
let mode = 'ok'; // 'ok' | 'down' (only /health is probed while down)
let boardNames = [];
const timers = new Map(); // task key -> timeout id
const backoff = Object.create(null); // task key -> current unjittered backoff ms
const chainDone = new Set(); // boards whose chain-summary succeeded since load / restart
let lastMinerStartAt = null;
let minerFailures = 0; // consecutive /miner failures (#15)
let lastMinerBytes = 0;
let lastRestartCount = 0;
const summaryBytes = new Map(); // board -> last asic-summary body size (#46)

// ---- serial queue, one entry per endpoint (#12) ----------------------------
const pending = []; // { key, fn, resolve }
const queuedKeys = new Set(); // keys queued or in flight
const skipped = Object.create(null);
let draining = false;
const SKIPPED = Object.freeze({ skipped: true });

function enqueue(key, fn, { front = false } = {}) {
  if (queuedKeys.has(key)) {
    skipped[key] = (skipped[key] || 0) + 1;
    return Promise.resolve(SKIPPED);
  }
  queuedKeys.add(key);
  return new Promise((resolve) => {
    const job = { key, fn, resolve };
    if (front) pending.unshift(job); else pending.push(job);
    drain();
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  while (pending.length) {
    const job = pending.shift();
    let r = null;
    try { r = await job.fn(); } catch (_) { r = null; }
    queuedKeys.delete(job.key);
    job.resolve(r);
  }
  draining = false;
}

// ---- timing helpers --------------------------------------------------------
/** Next unjittered backoff after a failure: base, 2 x base, ... capped (#11). */
export function nextBackoffMs(prevMs, cfg = CONFIG) {
  return Math.min(cfg.backoffCapMs, prevMs ? prevMs * 2 : cfg.backoffBaseMs);
}

function jittered(ms) {
  const j = CONFIG.backoffJitter || 0;
  return Math.max(1, Math.round(ms * (1 + (Math.random() * 2 - 1) * j)));
}

/**
 * Bytes/s the other endpoints will use over a byte-cap window (#46): the
 * planned asic-summary rate (per board: last body size, or a prior, times
 * the most summaries a window can hold, edges included), plus the one-shot
 * chain-summary and /health bytes still inside the trailing window. The
 * trailing window alone underrates summaries early, when it is part full.
 */
function otherBytesPerSec(now = Date.now()) {
  const win = CONFIG.maxKBWindowMs;
  const known = [...summaryBytes.values()];
  const prior = known.length ? Math.max(...known) : CONFIG.summaryBytesPrior;
  const perWindow = Math.floor(win / CONFIG.asicSummaryIntervalMs) + 1;
  let bytes = 0;
  for (const name of boardNames) bytes += (summaryBytes.get(name) ?? prior) * perWindow;
  for (const e of log) {
    if (e.path === '/api/v0/miner' || e.path.endsWith('/bzm2/asic-summary')) continue;
    if (e.t <= now && now - e.t <= win) bytes += e.bytes;
  }
  return bytes / (win / 1000);
}

/**
 * /miner delay that keeps every byte-cap window under maxKBps (#22, #46).
 * The unit's /miner grows with uptime (bzm2_tuning), so this is measured,
 * not a constant. A window of W s holds up to W/delay + 1 bodies, so one
 * body is reserved on top of the other endpoints' planned rate, and the
 * target sits byteCapMargin under the cap. At least 10% of the target is
 * always left for /miner.
 */
export function nextMinerDelayMs(lastBytes, otherBps, cfg = CONFIG) {
  const winS = cfg.maxKBWindowMs / 1000;
  const target = cfg.maxKBps * 1024 * (1 - (cfg.byteCapMargin ?? 0));
  const avail = Math.max(target * 0.1, target - (otherBps || 0) - lastBytes / winS);
  const need = lastBytes > 0 ? Math.ceil((lastBytes * 1000) / avail) : 0;
  return Math.max(cfg.minerIntervalMs, need);
}

/** The /miner interval the poller is using now (footer). */
export function effectiveMinerIntervalMs() {
  return nextMinerDelayMs(lastMinerBytes, otherBytesPerSec());
}

function arm(key, delayMs, fn) {
  disarm(key);
  if (stopped) return;
  timers.set(key, setTimeout(() => { timers.delete(key); if (!stopped && !document.hidden) fn(); }, Math.max(0, delayMs)));
}

function disarm(key) {
  const id = timers.get(key);
  if (id != null) clearTimeout(id);
  timers.delete(key);
}

function clearTimers() {
  for (const id of timers.values()) clearTimeout(id);
  timers.clear();
}

/**
 * One GET with a hard deadline (#3). The AbortSignal cancels the transfer;
 * the race against the deadline also covers a fetch or body read that ignores
 * the signal, so a hung request always settles, is recorded as a failure and
 * releases the serial queue.
 */
async function getJson(path) {
  if (!isAllowlistedPath(path)) {
    throw new Error(`path not allowlisted: ${path}`);
  }
  if (document.hidden) return null;
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { ctrl.abort(); } catch (_) { /* ignore */ }
      reject(new Error(`timeout: ${path}`));
    }, requestTimeoutFor(path));
  });
  deadline.catch(() => {});
  try {
    const res = await Promise.race([
      fetch(path, { method: 'GET', cache: 'no-store', signal: ctrl.signal }),
      deadline,
    ]);
    const buf = await Promise.race([res.arrayBuffer(), deadline]);
    clearTimeout(timer);
    const bytes = buf.byteLength;
    record(path, bytes, res.ok);
    if (!res.ok) {
      return { ok: false, status: res.status, bytes };
    }
    const text = new TextDecoder().decode(buf);
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = null; }
    }
    return { ok: true, data, bytes };
  } catch (_) {
    clearTimeout(timer);
    record(path, 0, false, timedOut);
    return { ok: false, status: 0, bytes: 0, timedOut };
  }
}

// ---- /miner and /health (#11, #22, #37) ----------------------------------
function scheduleMinerFromStart(startAt, delayMs) {
  arm('miner', startAt + delayMs - Date.now(), pollMiner);
}

async function pollMiner() {
  if (document.hidden || stopped || mode === 'down') return;
  const startAt = Date.now();
  const r = await enqueue('miner', () => {
    if (mode === 'down' || document.hidden) return null;
    lastMinerStartAt = Date.now();
    return getJson('/api/v0/miner');
  }, { front: true });
  if (stopped) return;
  if (r === SKIPPED) { scheduleMinerFromStart(startAt, CONFIG.minerIntervalMs); return; }
  if (!r) return; // hidden or down; visibility / health will resume
  const began = lastMinerStartAt ?? startAt;
  if (r.ok && r.data) {
    backoff.miner = 0;
    minerFailures = 0;
    lastMinerBytes = r.bytes || 0;
    onMiner(r.data);
    scheduleMinerFromStart(began, nextMinerDelayMs(lastMinerBytes, otherBytesPerSec()));
  } else {
    // #15: a blip keeps normal polling on backoff (summaries carry on); only
    // apiDownAfterFailures consecutive failures declare the API down.
    minerFailures += 1;
    if (minerFailures >= CONFIG.apiDownAfterFailures) {
      goDown();
    } else {
      // Measured from the failure, so a timed-out request is never retried
      // at once (#11).
      backoff.miner = nextBackoffMs(backoff.miner);
      arm('miner', Math.max(CONFIG.minerIntervalMs, jittered(backoff.miner)), pollMiner);
    }
  }
}

function goDown() {
  mode = 'down';
  store.markApiDown();
  disarm('miner');
  backoff.health = nextBackoffMs(backoff.health);
  arm('health', jittered(backoff.health), pollHealth);
}

async function pollHealth() {
  if (document.hidden || stopped || mode !== 'down') return;
  const r = await enqueue('health', () => getJson('/api/v0/health'));
  if (stopped || r === SKIPPED || !r) return;
  if (r.ok) {
    mode = 'ok';
    backoff.health = 0;
    // A server that answers /health gets the full three strikes again (#47
    // review): otherwise one slow /miner right after recovery flips straight
    // back to health-only and the page flaps. apiDown itself clears only on
    // a /miner success.
    minerFailures = 0;
    // Resume /miner; the health backoff (>= base) has already spaced it out.
    scheduleMinerFromStart(lastMinerStartAt ?? 0, CONFIG.minerIntervalMs);
    for (const name of boardNames) ensureSummaryTimer(name);
  } else {
    backoff.health = nextBackoffMs(backoff.health);
    arm('health', jittered(backoff.health), pollHealth);
  }
}

function onMiner(miner) {
  store.setMiner(miner);
  const names = Array.isArray(miner.boards) ? miner.boards.map((b) => b.name).filter(Boolean) : [];
  // Restart (#25): fetch chain-summary again for every board.
  const restarts = store.getState().restartMarkers.length;
  if (restarts !== lastRestartCount) {
    lastRestartCount = restarts;
    chainDone.clear();
    for (const name of names) { backoff[`chain:${name}`] = 0; disarm(`chain:${name}`); }
  }
  for (const name of boardNames) {
    if (!names.includes(name)) { disarm(`summary:${name}`); disarm(`chain:${name}`); }
  }
  boardNames = names;
  names.forEach((name, i) => {
    ensureSummaryTimer(name, i, names.length);
    if (CONFIG.chainSummaryOnLoad && !chainDone.has(name) && !timers.has(`chain:${name}`)) pollChain(name);
  });
}

// ---- asic-summary, per board (#11, #12) ------------------------------------
function ensureSummaryTimer(name, i = 0, n = 1) {
  const key = `summary:${name}`;
  if (timers.has(key) || queuedKeys.has(key)) return;
  // Stagger first polls across the interval.
  arm(key, Math.round((CONFIG.asicSummaryIntervalMs * i) / Math.max(1, n)) || CONFIG.asicSummaryIntervalMs, () => pollSummary(name));
}

async function pollSummary(name) {
  const key = `summary:${name}`;
  if (document.hidden || stopped || !boardNames.includes(name)) return;
  const startAt = Date.now();
  if (mode === 'down') { arm(key, CONFIG.asicSummaryIntervalMs, () => pollSummary(name)); return; }
  const path = asicSummaryPath(name);
  const r = await enqueue(key, () => (mode === 'down' || document.hidden ? null : getJson(path)));
  if (stopped || !boardNames.includes(name)) return;
  let delay = CONFIG.asicSummaryIntervalMs;
  if (r && r !== SKIPPED) {
    if (r.ok && r.data) {
      backoff[key] = 0;
      summaryBytes.set(name, r.bytes || 0);
      store.setSummary(name, r.data);
    } else {
      // Keep the last value; freshness marks it stale. Back off this board
      // only. A timed-out asic-summary may still be running on the board, so
      // it is held off like any failure, never retried at once (#3, #11).
      backoff[key] = nextBackoffMs(backoff[key]);
      delay = Math.max(CONFIG.asicSummaryIntervalMs, jittered(backoff[key]));
      store.markSummaryFailed(name); // #6: shown as unavailable, last data kept
    }
  }
  arm(key, startAt + delay - Date.now(), () => pollSummary(name));
}

// ---- chain-summary: at load, after a restart, retried on backoff (#25) -----
async function pollChain(name) {
  const key = `chain:${name}`;
  if (document.hidden || stopped || mode === 'down' || chainDone.has(name)) return;
  const path = chainSummaryPath(name);
  const r = await enqueue(key, () => (mode === 'down' || document.hidden ? null : getJson(path)));
  if (stopped || r === SKIPPED) return;
  if (r && r.ok && r.data) {
    backoff[key] = 0;
    chainDone.add(name);
    store.setChain(name, r.data);
    return;
  }
  if (r === null) return; // hidden / down: retried on the next /miner
  backoff[key] = nextBackoffMs(backoff[key]);
  arm(key, jittered(backoff[key]), () => pollChain(name));
}

// ---- lifecycle -------------------------------------------------------------
function resume() {
  if (mode === 'down') {
    pollHealth();
    return;
  }
  // #37: never start /miner sooner than one interval after the last one.
  const wait = lastMinerStartAt == null ? 0 : lastMinerStartAt + CONFIG.minerIntervalMs - Date.now();
  if (wait > 0) arm('miner', wait, pollMiner);
  else pollMiner();
  boardNames.forEach((name, i) => ensureSummaryTimer(name, i, boardNames.length));
}

export function startPoller() {
  stopped = false;
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) resume();
}

function onVisibility() {
  if (stopped) return;
  if (document.hidden) clearTimers();
  else resume();
}

export function stopPoller() {
  stopped = true;
  clearTimers();
  document.removeEventListener('visibilitychange', onVisibility);
}

/** Test helpers */
export function _requestLog() { return log.slice(); }
/** Pending (queued, not yet started) entries per endpoint key. */
export function _queueDepth() {
  const d = Object.create(null);
  for (const j of pending) d[j.key] = (d[j.key] || 0) + 1;
  return d;
}
export function _skipped() { return { ...skipped }; }
export function _mode() { return mode; }
export function _minerFailures() { return minerFailures; }
export function _resetForTests() {
  stopPoller();
  log.length = 0;
  pending.length = 0;
  queuedKeys.clear();
  draining = false;
  for (const k of Object.keys(skipped)) delete skipped[k];
  for (const k of Object.keys(backoff)) delete backoff[k];
  mode = 'ok';
  boardNames = [];
  chainDone.clear();
  lastMinerStartAt = null;
  lastMinerBytes = 0;
  minerFailures = 0;
  summaryBytes.clear();
  lastRestartCount = store.getState().restartMarkers.length;
}
