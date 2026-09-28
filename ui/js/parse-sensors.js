/**
 * Parse sensor names: <pfx>-asic-<N>-dts|-vs-chK|-vs
 * Returns { bus, wireId, kind, channel? } or null.
 */
const RE = /^(.+)-asic-(\d+)-(dts|vs(?:-ch(\d+))?)$/;

export function parseSensorName(name) {
  if (typeof name !== 'string') return null;
  // #10: board inlet and outlet (safety-relevant; present with the MCU heartbeat).
  const io = name.match(/^board(\d+)-(inlet|outlet)$/);
  if (io) return { kind: `board-${io[2]}`, index: Number(io[1]) };
  const m = name.match(RE);
  if (!m) return null;
  const kind = m[3].startsWith('vs') ? 'vs' : 'dts';
  const out = { bus: m[1], wireId: Number(m[2]), kind };
  if (kind === 'vs' && m[4] != null) out.channel = Number(m[4]);
  return out;
}

export function roundTripOk(name) {
  const p = parseSensorName(name);
  if (!p) return false;
  if (p.kind === 'dts') return `${p.bus}-asic-${p.wireId}-dts` === name;
  if (p.channel != null) return `${p.bus}-asic-${p.wireId}-vs-ch${p.channel}` === name;
  return `${p.bus}-asic-${p.wireId}-vs` === name;
}
