import { setText } from '../sanitize.js';
import { sharesRateNote } from '../shares-rate.js';
import { fmtHashrate, fmtUptime, fmtUnknown, fmtNum } from '../format.js';
import { sanitizeText, maskAddresses, splitUserinfo, stripUserinfo, clearChildren } from '../sanitize.js';
import { schedulerFieldsState } from '../freshness.js';
import { renderValue } from './value-state.js';
import { identifyPool, monogram } from '../pools.js';

/**
 * Scheduler-published KPI cells (#8): stale together when uptime freezes,
 * lost together per Ronald's lost-tiles decision on #14.
 */
const SCHEDULER_KEYS = ['hashrate', 'shares', 'uptime'];

export function renderKpi(root, state, now = Date.now()) {
  if (!root) return;
  const miner = state.miner;
  const set = (key, val, note) => {
    const v = root.querySelector(`[data-kpi="${key}"]`);
    const n = root.querySelector(`[data-kpi-note="${key}"]`);
    setText(v, val);
    if (n) setText(n, note || '');
  };
  const cell = (key) => root.querySelector(`[data-kpi="${key}"]`);
  const note = (key, text) => { const n = root.querySelector(`[data-kpi-note="${key}"]`); if (n) setText(n, text || ''); };

  if (!miner) {
    for (const k of SCHEDULER_KEYS) renderValue(cell(k), { text: '—' });
    set('hashrate', '—', 'waiting for /miner');
    set('shares', '—', '');
    set('accept', fmtUnknown('not_exposed'), 'accepted / rejected by the pool');
    set('pool', fmtUnknown('not_exposed'), 'pool and worker');
    set('uptime', '—', '');
    set('power', fmtUnknown('not_reported'), '');
    return;
  }

  // Hard rule 6 through the shared renderer (#14): live, stale ("stale N s",
  // desaturated and hatched) or lost ("—", last value in the tooltip).
  // Stale and lost take priority over any derived-rate state (#63).
  const sched = schedulerFieldsState(state, now);
  const stale = sched.cls === 'stale' ? sched.staleText : null;
  const lost = sched.cls === 'lost' ? `lost · ${sched.cause}` : null;
  const draw = (key, text) => renderValue(cell(key), { text, cls: sched.cls, staleText: sched.staleText, cause: sched.cause, asOf: sched.asOf, now });

  draw('hashrate', fmtHashrate(miner.hashrate));
  note('hashrate', lost || (stale ? `${stale} · last measured from shares` : 'measured from shares'));
  const shares = miner.shares_submitted;
  draw('shares', shares == null ? fmtUnknown() : String(shares));
  note('shares', lost ? `${lost} · shares/min not current`
    : stale ? `${stale} · shares/min not current`
      : miner.paused === true ? 'paused · shares/min not derived' : sharesRateNote(state.sharesRate, fmtNum));
  const sources = Array.isArray(miner.sources) ? miner.sources : [];
  // The pool's own accepted and rejected counts, when Mujina reports them
  // for the active source. Counts only: a ratio would be a figure computed in
  // the browser (AGENTS.md, measured only). Stale and lost with the scheduler
  // fields, like shares submitted.
  const acc = sources[0]?.shares_accepted;
  const rej = sources[0]?.shares_rejected;
  if (Number.isFinite(acc) && Number.isFinite(rej)) {
    draw('accept', `${acc} / ${rej}`);
    const why = sources[0].shares_rejected_by_reason;
    const reasons = why && typeof why === 'object'
      ? Object.entries(why).map(([k, n]) => `${sanitizeText(String(k))}×${n}`).join(', ') : '';
    // A source other than Mujina itself (the live view's log count) is named.
    const by = sources[0].shares_counted_by ? ` · ${sanitizeText(String(sources[0].shares_counted_by))}` : '';
    const last = sources[0].shares_last_at ? ` · last share ${sanitizeText(String(sources[0].shares_last_at))}` : '';
    note('accept', lost ? `${lost} · accepted / rejected not current`
      : stale ? `${stale} · accepted / rejected by the pool${by}`
        : `accepted / rejected by the pool${by}${last}${reasons ? ` · rejected: ${reasons}` : ''}`);
  } else {
    renderValue(cell('accept'), { text: fmtUnknown('not_exposed') });
    note('accept', 'accepted / rejected by the pool');
  }
  if (sources[0]) poolCard(cell('pool'), root.querySelector('[data-kpi-note="pool"]'), sources, state, now, lost || stale);
  else {
    set('pool', fmtUnknown('not_reported'), '');
    cell('pool')?.setAttribute('data-pool-state', 'unknown');
  }

  draw('uptime', fmtUptime(miner.uptime_secs));
  note('uptime', lost || (stale ? `${stale} · not advancing` : ''));
  // The harness's wall-side power and J/TH (Ronald, 2026-09-28), when the
  // lab controller's live view supplies them; never Mujina's figure, and labelled.
  const hz = miner.harness;
  if (hz && Number.isFinite(hz.input_w)) {
    const at = Date.parse(hz.input_w_at || '');
    const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
    const jth = Number.isFinite(hz.j_per_th) ? ` · ${fmtNum(hz.j_per_th, 1)} J/TH` : '';
    set('power', `${String(Math.round(hz.input_w)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} W${jth}`,
      `${age == null ? 'time unknown · ' : age > 30 ? `stale ${age} s · ` : ''}wall-side PSU input (harness ${sanitizeText(String(hz.case || ''))})`
      + ` · J/TH: 5-min mean input ÷ Mujina's 5-min hashrate`);
  } else set('power', fmtUnknown('not_reported'), 'W / J/TH absent on unit');
}

// Pool card (Ronald, 2026-09-28): the tile overflowed, so one fact per line.
// "Connected" is measured: the pool accepted a share within POOL_OK_MS (at
// about 5 a minute, a connected pool misses 2 min about once in e^10). The
// API reports no connection state and no pool role, so neither is invented:
// one source is the primary; with more, only its position is stated.
const POOL_OK_MS = 120_000;
const span = (ms) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`);
function hostPort(raw) {
  const hp = stripUserinfo(String(raw || '')).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  const m = hp.match(/^(.*):(\d+)$/);
  return m ? { host: m[1], port: m[2] } : { host: hp, port: null };
}
function poolCard(value, note, sources, state, now, notCurrent) {
  const s = sources[0];
  const role = sources.length === 1 ? 'Primary pool' : `Pool 1 of ${sources.length}`;
  const since = state.poolAcceptedAt != null ? now - state.poolAcceptedAt : null;
  const watched = state.poolWatchFrom != null ? now - state.poolWatchFrom : null;
  let text, st;
  if (notCurrent) { text = `${role} · connection not current`; st = 'unknown'; }
  else if (!Number.isFinite(s.shares_accepted)) { text = `${role} · connection not reported`; st = 'unknown'; }
  else if (since != null && since <= POOL_OK_MS) { text = `✓ ${role} connected`; st = 'ok'; }
  else if (since != null) { text = `${role} · no accepted share for ${span(since)}`; st = 'warn'; }
  else if (watched != null && watched > POOL_OK_MS) { text = `${role} · no accepted share for ${span(watched)} (since page load)`; st = 'warn'; }
  else { text = `${role} · awaiting an accepted share`; st = 'unknown'; }
  setText(value, text);
  value?.setAttribute('data-pool-state', st);
  if (!note) return;
  clearChildren(note);
  const { host, port } = hostPort(s.url || s.name);
  const line = (t, title) => {
    const d = document.createElement('div');
    d.textContent = t;
    if (title) d.setAttribute('title', title);
    note.appendChild(d);
    return d;
  };
  // #101: named from mempool's pool dataset, with a lettered icon until a
  // logo is cleared (#85); an unknown host is shown as is, never renamed.
  const known = identifyPool(host, state.pools);
  const active = line('', sanitizeText(host));
  if (known) {
    const mono = document.createElement('span');
    mono.setAttribute('class', 'pool-mono');
    mono.setAttribute('aria-hidden', 'true');
    mono.textContent = monogram(known.name);
    active.appendChild(mono);
  }
  const label = document.createElement('span');
  label.textContent = `Active: ${sanitizeText(known ? known.name : host || '—')}`;
  active.appendChild(label);
  line(`Port: ${port ?? 'not reported'}`);
  // The worker is public and separate from the username and password
  // (Ronald, 2026-09-28): shown as is. Only the address masker applies.
  const hw = state.miner?.harness?.worker;
  line(`Worker: ${s.worker != null && s.worker !== '' ? maskAddresses(sanitizeText(String(s.worker)))
    : hw ? `${maskAddresses(sanitizeText(String(hw)))} (harness config, ${sanitizeText(String(state.miner.harness.case || 'case unknown'))})`
      : 'not reported by Mujina'}`);
  line(`Diff: ${s.difficulty != null ? sanitizeText(String(s.difficulty)) : 'not reported'}`);
  const creds = splitUserinfo(s.url || s.name);
  if (creds) poolCredentials(line(''), creds);
}

// #23 (Ronald, 2026-09-28): passwords are hidden by default, with an eye to
// reveal them and catch typos; pool passwords are not high security. The
// password lives in this module, never in a DOM attribute.
let revealPoolPassword = false;
const DOTS = '••••••';
function poolCredentials(note, { user, pass }) {
  if (!note) return;
  clearChildren(note);
  note.textContent = `User: ${maskAddresses(user) || '(none)'}`;
  if (pass == null) return;
  const span = document.createElement('span');
  const btn = document.createElement('button');
  const draw = () => {
    span.textContent = ` · password ${revealPoolPassword ? pass : DOTS} `;
    btn.textContent = revealPoolPassword ? 'hide' : '👁';
    btn.setAttribute('aria-pressed', String(revealPoolPassword));
    btn.setAttribute('aria-label', revealPoolPassword ? 'Hide pool password' : 'Show pool password');
  };
  btn.setAttribute('type', 'button');
  btn.setAttribute('class', 'reveal');
  btn.setAttribute('data-reveal', '');
  btn.onclick = () => { revealPoolPassword = !revealPoolPassword; draw(); };
  draw();
  note.appendChild(span);
  note.appendChild(btn);
}
