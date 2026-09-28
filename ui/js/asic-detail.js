/**
 * What hovering, tapping or focusing a heatmap cell shows (#102, a slice of
 * #81): one ASIC's die temperature, VS channels, work and fault bits, all
 * from the /miner reply already in the store. The ASIC is its bus and wire;
 * work and faults are joined by (thread, wire), and not at all when the bus
 * has no thread (#19): never by wire alone.
 */
import { fmtHashrate, fmtTemp, fmtNum, fmtClock } from './format.js';
import { sanitizeText } from './sanitize.js';

const NR = 'not reported';
const RESULTS = [['accepted', 'accepted'], ['decoded', 'decoded'], ['below_target', 'below target'],
  ['invalid_nonce', 'invalid nonce'], ['stale_sequence', 'stale sequence'], ['no_dispatch', 'no dispatch'],
  ['unknown_engine', 'unknown engine']];

export function asicDetail(board, { tty, threadIndex }, wire, { at, cls }) {
  const pfx = `${tty}-asic-${wire}-`;
  const temps = Array.isArray(board?.temperatures) ? board.temperatures : [];
  const powers = Array.isArray(board?.powers) ? board.powers : [];
  const dts = temps.find((r) => r?.name === `${pfx}dts`)?.temperature_c;
  const vs = powers.filter((r) => typeof r?.name === 'string' && r.name.startsWith(`${pfx}vs-ch`) && Number.isFinite(r.voltage_v))
    .map((r) => [Number(r.name.slice(`${pfx}vs-ch`.length)), r.voltage_v]).sort((a, b) => a[0] - b[0]);
  const rows = [['die temperature', Number.isFinite(dts) ? fmtTemp(dts) : NR]];
  if (vs.length) for (const [k, v] of vs) rows.push([`VS ch${k}`, `${fmtNum(v * 1000, 1)} mV`]);
  else rows.push(['VS', NR]);
  if (threadIndex == null) {
    rows.push(['work and faults', 'not joined: bus map unavailable (the wire alone does not name an ASIC)']);
  } else {
    const same = (a) => a?.thread_index === threadIndex && a?.id === wire;
    const t = (Array.isArray(board?.bzm2_tuning?.asics) ? board.bzm2_tuning.asics : []).find(same);
    if (t) {
      rows.push(['hashrate estimate', Number.isFinite(t.throughput_hs) ? fmtHashrate(t.throughput_hs) : NR]);
      rows.push(['scheduler shares', Number.isFinite(t.scheduler_share_count) ? String(t.scheduler_share_count) : NR]);
      const r = t.results || {};
      const parts = RESULTS.filter(([k]) => Number.isFinite(r[k])).map(([k, label]) => `${label} ${r[k]}`);
      rows.push(['results', parts.length ? parts.join(' · ') : NR]);
    } else rows.push(['work', NR]);
    const f = (Array.isArray(board?.asics) ? board.asics : []).find(same);
    const bits = f?.faults && typeof f.faults === 'object' ? Object.entries(f.faults).filter(([, v]) => v === true).map(([k]) => sanitizeText(k)) : null;
    rows.push(['faults', bits == null ? NR : bits.length ? bits.join(', ') : 'none asserted']);
  }
  const state = cls === 'lost' ? 'lost' : cls === 'stale' ? 'stale' : 'live';
  const when = at != null ? `${fmtClock(at)} (browser time)` : 'time unknown';
  return {
    title: `${sanitizeText(String(tty))} · thread ${threadIndex ?? 'unknown'} · wire ${wire}${state === 'live' ? '' : ` · ${state}`}`,
    rows,
    footer: `${state === 'live' ? 'as of' : 'last known, as of'} the /miner reply at ${when}; Mujina reports no per-reading age`,
  };
}
