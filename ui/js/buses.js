/**
 * Bus model: per-hashboard views are keyed by bus, never by board object
 * (mujina-bzm2-dev#124 amendment). The unit publishes ONE board object that
 * spans three buses; a future RDS with three board objects would carry one bus
 * each, and this model serves both.
 *
 * Identity of one die = (bus, wire id). `-dts` rows name the bus by their tty
 * prefix. `asics[]` rows carry only (thread_index, id), so they are joined on
 * thread_index -> serial_path from chain-summary `buses` (or asic-summary
 * `buses[]`), and the serial_path basename is the row prefix.
 */
import { parseSensorName } from './parse-sensors.js';

export function ttyOfPath(p) {
  if (typeof p !== 'string') return null;
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** thread_index -> { threadIndex, serialPath, tty, asicStart, asicCount } for one board. */
export function busMapFor(state, boardName) {
  const map = new Map();
  const chain = state?.chain?.[boardName]?.data?.buses;
  const summary = state?.summaries?.[boardName]?.data?.buses;
  for (const src of [chain, summary]) { // chain-summary first, per the amendment
    if (!Array.isArray(src)) continue;
    for (const b of src) {
      if (!b || b.thread_index == null || typeof b.serial_path !== 'string') continue;
      const cur = map.get(b.thread_index);
      if (cur) {
        if (cur.asicCount == null && b.asic_count != null) cur.asicCount = b.asic_count;
        continue;
      }
      map.set(b.thread_index, {
        threadIndex: b.thread_index,
        serialPath: b.serial_path,
        tty: ttyOfPath(b.serial_path),
        asicStart: b.asic_start ?? null,
        asicCount: b.asic_count ?? null,
      });
    }
  }
  return map;
}

function dtsPrefixes(board) {
  const seen = [];
  for (const row of (Array.isArray(board?.temperatures) ? board.temperatures : [])) {
    const p = parseSensorName(row?.name);
    if (p && p.kind === 'dts' && !seen.includes(p.bus)) seen.push(p.bus);
  }
  return seen;
}

function hasFault(f) {
  return !!(f && (f.thermal_trip || f.thermal_fault || f.voltage_fault || f.voltage_shutdown));
}

/**
 * Heatmap cells of one board, grouped by bus and keyed by (bus, wire id).
 * `asics[]` faults are joined on (thread_index -> bus, id). When no bus map
 * is known, a board with one bus and at most one thread is unambiguous;
 * otherwise no cell is guessed and the fault rows are returned as `unjoined`.
 *
 * @returns {{ byBus: Map<string, Array<{bus,wireId,temp,fault}>>, unjoined: object[] }}
 */
export function cellsByBus(board, busMap = new Map()) {
  const byBus = new Map();
  const index = new Map();
  const cellFor = (bus, wireId, create) => {
    const key = `${bus}#${wireId}`;
    let c = index.get(key);
    if (!c && create) {
      c = { bus, wireId, temp: null, fault: false };
      index.set(key, c);
      if (!byBus.has(bus)) byBus.set(bus, []);
      byBus.get(bus).push(c);
    }
    return c;
  };

  for (const row of (Array.isArray(board?.temperatures) ? board.temperatures : [])) {
    const p = parseSensorName(row?.name);
    if (!p || p.kind !== 'dts') continue;
    const c = cellFor(p.bus, p.wireId, true);
    c.temp = row.temperature_c ?? null;
  }

  let threadToBus = (ti) => busMap.get(ti)?.tty ?? null;
  if (!busMap.size) {
    const prefixes = dtsPrefixes(board);
    const nThreads = Array.isArray(board?.threads) ? board.threads.length : 0;
    if (prefixes.length === 1 && nThreads <= 1) threadToBus = (ti) => (ti === 0 || ti == null ? prefixes[0] : null);
  }

  const unjoined = [];
  for (const a of (Array.isArray(board?.asics) ? board.asics : [])) {
    if (a?.id == null) continue;
    const bus = threadToBus(a.thread_index ?? null);
    if (!bus) {
      if (hasFault(a.faults)) unjoined.push(a);
      continue;
    }
    const c = cellFor(bus, a.id, true);
    if (hasFault(a.faults)) c.fault = true;
  }
  for (const cells of byBus.values()) cells.sort((x, y) => x.wireId - y.wireId);
  return { byBus, unjoined };
}

/**
 * One panel per bus, for every board object. A board whose buses cannot be
 * resolved at all still gets one board-level panel.
 */
export function busPanels(state) {
  const boards = Array.isArray(state?.miner?.boards) ? state.miner.boards : [];
  const panels = [];
  boards.forEach((board, bi) => {
    const boardName = board?.name || `board-${bi}`;
    const map = busMapFor(state, boardName);
    const { byBus, unjoined } = cellsByBus(board, map);
    const summary = state?.summaries?.[boardName];
    const sumBuses = Array.isArray(summary?.data?.buses) ? summary.data.buses : [];
    const threads = Array.isArray(board?.threads) ? board.threads : [];

    const entries = [...map.values()].sort((a, b) => a.threadIndex - b.threadIndex);
    const known = new Set(entries.map((e) => e.tty));
    for (const tty of [...byBus.keys()].sort()) {
      if (!known.has(tty)) entries.push({ threadIndex: null, serialPath: null, tty, asicStart: null, asicCount: null });
    }
    if (!entries.length) entries.push({ threadIndex: null, serialPath: null, tty: null, asicStart: null, asicCount: null });

    for (const e of entries) {
      const sb = e.threadIndex != null ? sumBuses.find((b) => b?.thread_index === e.threadIndex) : null;
      const agg = sb?.aggregate ?? (entries.length === 1 && e.tty == null ? summary?.data?.board ?? null : null);
      let panelThreads = [];
      if (e.threadIndex != null && threads[e.threadIndex]) panelThreads = [threads[e.threadIndex]];
      else if (entries.length === 1) panelThreads = threads;
      panels.push({
        key: `${boardName}|${e.tty ?? e.threadIndex ?? 'board'}`,
        boardName,
        board,
        tty: e.tty,
        threadIndex: e.threadIndex,
        serialPath: e.serialPath,
        threadActive: sb?.thread_active ?? null,
        aggregate: agg,
        summaryAt: summary?.at ?? null,
        summaryUnavailable: !!summary?.unavailable,
        threads: panelThreads,
        cells: e.tty != null ? (byBus.get(e.tty) || []) : [],
        configured: agg?.coverage?.asics_configured ?? e.asicCount ?? null,
        unjoinedFaults: unjoined.length,
      });
    }
  });
  return panels;
}
