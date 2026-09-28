/**
 * Expand a small seed into gen2-shaped MinerTelemetry / Bzm2AsicSummaryResponse /
 * Bzm2ChainSummaryResponse bodies. Key set follows mujina-miner api_client/types.rs
 * at mujina-bzm2-dev@3f783d9 — do not invent fields not present there.
 *
 * Numeric values are synthetic; a real capture is served by --replay instead.
 */
export const MOCK_POOL_URL = 'stratum+tcp://pool.invalid:3333';

/** Deterministic pseudo-noise in [-1, 1]. */
function noise(i, salt = 0) {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function statsOf(values) {
  if (!values.length) return null;
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    min,
    max,
    mean: sum / values.length,
    spread: max - min,
    samples: values.length,
    asics_value_suppressed: 0,
  };
}

function extremeOf(temps, pick) {
  if (!temps.length) return null;
  let best = temps[0];
  for (const t of temps) {
    if (pick === 'hot' ? t.temperature_c > best.temperature_c : t.temperature_c < best.temperature_c) {
      best = t;
    } else if (t.temperature_c === best.temperature_c && t.asic_id < best.asic_id) {
      best = t;
    }
  }
  return {
    asic_id: best.asic_id,
    wire_asic_id: best.wire_asic_id,
    thread_index: best.thread_index,
    temperature_c: best.temperature_c,
  };
}

function faultBits(map) {
  return {
    thermal_trip: !!map.thermal_trip,
    thermal_fault: !!map.thermal_fault,
    voltage_fault: !!map.voltage_fault,
    voltage_shutdown: !!map.voltage_shutdown,
  };
}

function emptyFaults() {
  return faultBits({});
}

/** Default mock bus ttys: first bus ttyMOCK00, second ttyMOCK10, third ttyMOCK20, ... */
export function mockTty(i) {
  return `ttyMOCK${String(i * 10).padStart(2, '0')}`;
}

/** Board name the driver derives from its buses: `bzm2-<tty0>-<tty1>-...` (config.rs device_id). */
export function boardNameForTtys(ttys) {
  return `bzm2-${ttys.join('-')}`;
}

/** The one mock board object, as the real 3-bus unit publishes it. */
export const MOCK_BOARD = boardNameForTtys([0, 1, 2].map(mockTty));
/** Mock bus serial paths, in thread order. */
export const MOCK_BUSES = Object.freeze([0, 1, 2].map((i) => `/dev/${mockTty(i)}`));

function faultBitCounts(assertByBit) {
  return ['thermal_trip', 'thermal_fault', 'voltage_fault', 'voltage_shutdown'].map((bit) => {
    const ids = assertByBit[bit];
    const out = { bit, asics_asserting: ids.length };
    // Board-wide ids, capped at 32; the driver skips the key when empty (types.rs Vec::is_empty).
    if (ids.length) out.asic_ids = ids.slice(0, 32);
    out.asic_ids_omitted = Math.max(0, ids.length - 32);
    return out;
  });
}

/** One Bzm2AsicAggregate over a set of per-ASIC readings. */
function aggregateOf(rows, nConfigured, sparseNote) {
  const assert = { thermal_trip: [], thermal_fault: [], voltage_fault: [], voltage_shutdown: [] };
  for (const r of rows) {
    for (const bit of Object.keys(assert)) if (r.faults[bit]) assert[bit].push(r.asic_id);
  }
  const neverSeen = Math.max(0, nConfigured - rows.length);
  return {
    coverage: {
      asics_configured: nConfigured,
      asics_reporting: rows.length,
      asics_stale: 0,
      asics_value_suppressed: 0,
      asics_never_seen: neverSeen,
      reading_age: {
        availability: 'measured',
        max_age_secs: 30,
        oldest_included_secs: 2.5,
        note: neverSeen && sparseNote ? 'mock sparse density: only first N ASICs populated in fixture' : null,
      },
    },
    die_temperature_c: statsOf(rows.map((r) => r.temperature_c)),
    hottest: extremeOf(rows, 'hot'),
    coldest: extremeOf(rows, 'cold'),
    voltage_channels: [0, 1, 2].map((channel) => ({
      channel,
      stats: statsOf(rows.map((r) => r.vs[channel])),
    })),
    faults: { availability: 'measured', bits: faultBitCounts(assert), note: null },
  };
}

function tuningBlock(boardSeed, perBus, threads) {
  const domainsPerBus = boardSeed.tuning_domains_per_bus ?? 25;
  const asics = perBus.flatMap((b) => b.rows.map((r) => {
    const salt = r.thread_index * 1000 + r.wire;
    const hs = Math.round(1.1e11 * (1 + noise(salt, 40) * 0.05));
    const accepted = 20 + Math.round(10 * (1 + noise(salt, 41)));
    const stale = Math.round(4 * (1 + noise(salt, 42)));
    const below = Math.round(6 * (1 + noise(salt, 43)));
    return {
      id: r.wire,
      thread_index: r.thread_index,
      throughput_hs: hs,
      scheduler_share_count: accepted,
      results: {
        decoded: accepted + stale + below,
        accepted,
        invalid_nonce: 0,
        unknown_engine: 0,
        no_dispatch: 0,
        stale_sequence: stale,
        below_target: below,
      },
      plls: [{ pll_index: 0 }, { pll_index: 1, throughput_hs: hs }],
    };
  }));
  return {
    board_throughput_hs: threads.reduce((sum, t) => sum + (t.is_active ? t.hashrate : 0), 0),
    reuse_saved_operating_point: false,
    needs_retune: false,
    desired_voltage_mv: boardSeed.desired_voltage_mv ?? 17500,
    desired_clock_mhz: boardSeed.desired_clock_mhz ?? 1150,
    desired_accept_ratio: 0.975,
    retune_pending: false,
    saved_operating_point_status: boardSeed.saved_operating_point_status ?? 'pending',
    planner_notes: [
      'building fresh domain-aware calibration plan',
      'domain-first planning enabled for multi-domain hardware',
      'planner uses one domain aggregation pass and one ASIC tuning pass',
    ],
    domains: Array.from({ length: domainsPerBus * perBus.length }, (_, i) => ({ domain_id: i })),
    asics,
  };
}

/**
 * Expand one board object that spans several buses, the shape the driver
 * emits (board/bzm2/mod.rs:1025-1036): one board, one thread per bus
 * ('BZM2 UART <i>'), one chassis fan set, `asics[]` rows `{ id, thread_index,
 * faults }` with the wire id 0..N-1 repeating on every bus and no
 * `serial_path`. Sensor rows are `<tty>-asic-<wire>-dts|vs-chK`, ordered as on
 * the unit: the second and third bus interleaved first, the first bus last.
 *
 * @param {object} boardSeed { name?, model, fans, startup_path, saved_operating_point_status, buses[] }
 * @param {number} nPopulated populated ASICs per bus
 * @param {number} nConfigured configured ASICs per bus
 */
export function expandBoard(boardSeed, nPopulated, nConfigured = nPopulated) {
  const busSeeds = boardSeed.buses || [];
  const ttys = busSeeds.map((b, i) => b.tty || mockTty(i));
  const name = boardSeed.name || boardNameForTtys(ttys);
  const cols = 10;

  // Per-bus readings, in wire order.
  const perBus = busSeeds.map((bs, ti) => {
    const tty = ttys[ti];
    const asicStart = ti * nConfigured;
    const rows = [];
    for (let w = 0; w < nPopulated; w++) {
      const row = Math.floor(w / cols);
      const col = w % cols;
      const salt = ti * 1000 + w;
      const temperature_c = round2(
        (bs.base_temp_c ?? 62)
          + row * (bs.temp_row_delta ?? 0.3)
          + col * (bs.temp_col_delta ?? 0.2)
          + noise(salt, 1) * (bs.temp_noise_amp ?? 0.5),
      );
      const vs = [0, 1, 2].map((ch) => round4(
        (bs.base_v ?? 0.72)
          + ch * (bs.v_channel_delta ?? 0.01)
          + w * (bs.v_wire_delta ?? 0.001)
          + noise(salt, 10 + ch) * 0.002,
      ));
      const fmap = (bs.fault_asics && bs.fault_asics[String(w)]) || {};
      rows.push({
        tty, wire: w, asic_id: asicStart + w, wire_asic_id: w, thread_index: ti,
        temperature_c, vs, faults: faultBits(fmap),
      });
    }
    return { tty, ti, asicStart, rows, seed: bs };
  });

  // Unit ordering: buses 1 and 2 interleaved (2 first), then bus 0.
  const ordered = [];
  const later = perBus.slice(1).reverse();
  const maxLen = Math.max(0, ...later.map((b) => b.rows.length));
  for (let w = 0; w < maxLen; w++) for (const b of later) if (b.rows[w]) ordered.push(b.rows[w]);
  if (perBus[0]) ordered.push(...perBus[0].rows);

  const temperatures = ordered.map((r) => ({ name: `${r.tty}-asic-${r.wire}-dts`, temperature_c: r.temperature_c }));
  // PowerMeasurement always serialises voltage_v / current_a / power_w (Option -> null).
  const powers = ordered.flatMap((r) => r.vs.map((v, ch) => ({
    name: `${r.tty}-asic-${r.wire}-vs-ch${ch}`, voltage_v: v, current_a: null, power_w: null,
  })));
  const asics = perBus.flatMap((b) => b.rows.map((r) => ({ id: r.wire, thread_index: r.thread_index, faults: r.faults })));

  const fans = (boardSeed.fans || []).map((f) => ({
    name: f.name,
    rpm: f.rpm ?? null,
    percent: f.percent ?? null,
    target_percent: f.target_percent ?? null, // always present on wire; null = auto
  }));

  const threads = perBus.map((b) => ({
    name: b.seed.thread_name || `BZM2 UART ${b.ti}`,
    hashrate: b.seed.thread_hashrate ?? 4_000_000_000_000_000,
    is_active: b.seed.thread_active !== false,
  }));

  const board = {
    name,
    model: boardSeed.model || 'BZM2',
    serial: name,
    fans,
    temperatures,
    powers,
    threads,
    asics,
    // Bzm2TuningState sized like the unit after a while mining (#22): about
    // 90 KB for 300 ASICs (per-ASIC throughput, share and result counts,
    // two PLLs), 25 domains per bus. Every key is Option/Vec on the wire.
    bzm2_tuning: tuningBlock(boardSeed, perBus, threads),
  };

  const sparse = nPopulated < nConfigured;
  const allRows = perBus.flatMap((b) => b.rows);
  const asicSummary = {
    dts_vs_generation: 'gen2',
    configured_asics: nConfigured * perBus.length,
    discovered_asics: nPopulated * perBus.length,
    board: aggregateOf(allRows, nConfigured * perBus.length, sparse),
    buses: perBus.map((b) => ({
      thread_index: b.ti,
      serial_path: `/dev/${b.tty}`,
      asic_start: b.asicStart,
      thread_active: b.seed.thread_active !== false,
      aggregate: aggregateOf(b.rows, nConfigured, sparse),
    })),
    per_asic_current: {
      availability: 'unavailable_on_platform',
      note: 'per-ASIC current is not published on this platform',
    },
    per_asic_power: {
      availability: 'unavailable_on_platform',
      note: 'per-ASIC power is not published on this platform',
    },
  };

  const chainSummary = {
    total_asics: nConfigured * perBus.length,
    startup_path: boardSeed.startup_path ?? 'live_calibration',
    saved_operating_point_status: boardSeed.saved_operating_point_status ?? 'pending',
    buses: perBus.map((b) => ({
      thread_index: b.ti,
      serial_path: `/dev/${b.tty}`,
      asic_start: b.asicStart,
      asic_count: nConfigured,
    })),
  };

  return { board, asicSummary, chainSummary };
}

/** Expand a scenario seed into { miner, summaries: { [boardName]: { asic, chain } } }. */
export function expandSeed(seed) {
  const nConfigured = seed.asics_per_bus ?? 100;
  const nPopulated = seed.asics_populated_per_bus ?? nConfigured;
  const boards = [];
  const summaries = Object.create(null);
  for (const b of seed.boards) {
    const { board, asicSummary, chainSummary } = expandBoard(b, nPopulated, nConfigured);
    boards.push(board);
    summaries[board.name] = { asic: asicSummary, chain: chainSummary };
  }
  const miner = {
    uptime_secs: seed.uptime_secs ?? 3600,
    hashrate: seed.hashrate ?? 0,
    shares_submitted: seed.shares_submitted ?? 0,
    paused: !!seed.paused,
    boards,
    sources: (seed.sources || [
      { name: 'pool.invalid:3333', url: MOCK_POOL_URL, difficulty: 65536 },
    ]).map((s) => ({
      name: s.name,
      url: s.url ?? null,
      difficulty: s.difficulty ?? null,
    })),
  };
  return { miner, summaries };
}

const TTY_TOKEN = /tty[A-Za-z0-9]+/g;

/**
 * Build the real-tty -> mock-tty map for a captured /miner body. Bus ttys are
 * taken in the order the board name lists them (the driver joins them in
 * thread order), then any other tty seen in a sensor-row prefix or
 * serial_path. The first bus maps to ttyMOCK00, the second to ttyMOCK10, ...
 * Across several board objects, numbering continues.
 */
export function ttyMapForMiner(miner) {
  const order = [];
  const add = (t) => { if (t && !order.includes(t) && !/^ttyMOCK\d+$/.test(t)) order.push(t); };
  for (const b of (Array.isArray(miner?.boards) ? miner.boards : [])) {
    for (const t of (typeof b.name === 'string' ? b.name.match(TTY_TOKEN) || [] : [])) add(t);
    for (const t of (typeof b.serial === 'string' ? b.serial.match(TTY_TOKEN) || [] : [])) add(t);
    for (const r of [...(b.temperatures || []), ...(b.powers || [])]) {
      const m = typeof r?.name === 'string' && r.name.match(/^(tty[A-Za-z0-9]+)-/);
      if (m) add(m[1]);
    }
    for (const a of (b.asics || [])) {
      const m = typeof a?.serial_path === 'string' && a.serial_path.match(/\/(tty[A-Za-z0-9]+)$/);
      if (m) add(m[1]);
    }
  }
  const map = new Map();
  order.forEach((t, i) => map.set(t, mockTty(i)));
  return map;
}

/** Replace whole tty tokens (never a greedy run across '-') by their mock names. */
function rewriteTtys(str, ttyMap) {
  if (typeof str !== 'string' || !ttyMap.size) return str;
  return str.replace(/(^|[^A-Za-z0-9])(tty[A-Za-z0-9]+)(?![A-Za-z0-9])/g, (all, pre, tok) => {
    const to = ttyMap.get(tok);
    return to ? pre + to : all;
  });
}

function rewriteDeep(node, ttyMap) {
  if (Array.isArray(node)) return node.map((x) => rewriteDeep(x, ttyMap));
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = rewriteDeep(node[k], ttyMap);
    return node;
  }
  return typeof node === 'string' ? rewriteTtys(node, ttyMap) : node;
}

/**
 * Scrub a captured /miner body for fixture/replay use, keeping its shape:
 * same board count, same rows (including non-ASIC rows such as board inlet /
 * outlet), same keys. Every real bus tty becomes its own mock tty wherever it
 * appears (board name, serial, sensor-row prefix, serial_path); the pool
 * becomes pool.invalid.
 */
export function scrubMiner(miner, ttyMap = ttyMapForMiner(miner)) {
  const out = structuredClone(miner);
  if (Array.isArray(out.sources)) {
    for (const s of out.sources) {
      if (s && typeof s === 'object') {
        s.name = 'pool.invalid:3333';
        if ('url' in s) s.url = MOCK_POOL_URL;
      }
    }
  }
  if (Array.isArray(out.boards)) out.boards = rewriteDeep(out.boards, ttyMap);
  return out;
}

/** Scrub an asic-summary / chain-summary with the same tty map: each bus keeps its own serial_path. */
export function scrubSummary(summary, ttyMap) {
  return rewriteDeep(structuredClone(summary), ttyMap);
}

/**
 * Inventory a capture directory for allowlisted API artifacts.
 * Expected lexical names (as cited in #124): `NN-miner.json`, `NN-*-asic-summary*.json`, etc.
 */
export function inventoryCaptureDir(entries) {
  const names = entries.map((e) => e.replace(/\\/g, '/').split('/').pop());
  const miners = names
    .filter((n) => /miner/i.test(n) && /\.json$/i.test(n) && !/asic-summary|chain-summary/i.test(n))
    .sort();
  const asic = names.filter((n) => /asic-summary/i.test(n)).sort();
  const chain = names.filter((n) => /chain-summary/i.test(n)).sort();
  const health = names.filter((n) => /health/i.test(n) && /\.json$/i.test(n)).sort();
  return {
    miners,
    asicSummaries: asic,
    chainSummaries: chain,
    health,
    gaps: [
      !miners.length && 'missing */miner JSON (e.g. 02-miner.json)',
      !asic.length && 'missing asic-summary dumps',
      !chain.length && 'missing chain-summary dumps',
      miners.length && asic.length === 0 && 'miner present but no asic-summary (aggregates cannot be replayed)',
    ].filter(Boolean),
  };
}
