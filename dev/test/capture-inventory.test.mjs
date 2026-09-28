import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inventoryCaptureDir,
  scrubMiner,
  scrubSummary,
  ttyMapForMiner,
} from '../gen-scenario.mjs';
import { parseSensorName } from '../../ui/js/parse-sensors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 17987;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('inventory lists gaps when capture has only miner frames', () => {
  const inv = inventoryCaptureDir(['02-miner.json', '08-miner-paused.json', 'psu.tsv']);
  assert.deepEqual(inv.miners, ['02-miner.json', '08-miner-paused.json']);
  assert.ok(inv.gaps.some((g) => /asic-summary/i.test(g)));
  assert.ok(inv.gaps.some((g) => /chain-summary/i.test(g)));
});

test('inventory clean when miner + summaries present', () => {
  const inv = inventoryCaptureDir([
    '02-miner.json',
    '02-asic-summary-bzm2-ttyMOCK00.json',
    '02-chain-summary-bzm2-ttyMOCK00.json',
  ]);
  assert.equal(inv.gaps.length, 0);
});

// A synthetic lab-shaped 3-bus body: one board object, threads 'BZM2 UART 0..2',
// 300 asics (thread_index, id 0..99), rows ordered as on the unit, plus
// non-ASIC rows. Tty names are made up; no capture data is used.
const LAB_TTYS = ['ttyREAL00', 'ttyREAL10', 'ttyREAL20'];
function labMiner({ buses = LAB_TTYS } = {}) {
  const faults = { thermal_trip: false, thermal_fault: false, voltage_fault: false, voltage_shutdown: false };
  const asics = [];
  buses.forEach((_, ti) => { for (let id = 0; id < 100; id++) asics.push({ id, thread_index: ti, faults }); });
  const order = [];
  for (let id = 0; id < 100; id++) for (const tty of buses.slice(1).reverse()) order.push([tty, id]);
  for (let id = 0; id < 100; id++) order.push([buses[0], id]);
  const temperatures = order.map(([tty, id]) => ({ name: `${tty}-asic-${id}-dts`, temperature_c: 40 + id / 10 }));
  temperatures.push({ name: 'board0-inlet', temperature_c: 30 }, { name: 'board0-outlet', temperature_c: 35 });
  const powers = order.flatMap(([tty, id]) => [0, 1, 2].map((ch) => ({
    name: `${tty}-asic-${id}-vs-ch${ch}`, voltage_v: 0.35, current_a: null, power_w: null,
  })));
  const name = `bzm2-${buses.join('-')}`;
  return {
    uptime_secs: 1, hashrate: 1, shares_submitted: 0, paused: false,
    sources: [{ name: 'user.worker:secret@real-pool:3333', url: 'stratum+tcp://secret.example:3333' }],
    boards: [{
      name, model: 'BZM2', serial: name,
      fans: [0, 1, 2, 3].map((i) => ({ name: `fan${i}`, rpm: 1000, percent: 50, target_percent: null })),
      temperatures, powers,
      threads: buses.map((_, i) => ({ name: `BZM2 UART ${i}`, hashrate: 1, is_active: true })),
      asics,
    }],
  };
}
function labChain(buses = LAB_TTYS) {
  return {
    total_asics: 100 * buses.length,
    buses: buses.map((t, i) => ({ thread_index: i, serial_path: `/dev/${t}`, asic_start: i * 100, asic_count: 100 })),
  };
}

// Issues #32/#33: scrub keeps the real shape and maps each bus to its own mock tty.
test('scrubMiner keeps one 3-bus board and maps each bus prefix to its own mock tty', () => {
  const raw = labMiner();
  const out = scrubMiner(raw);
  assert.equal(out.boards.length, 1);
  const b = out.boards[0];
  assert.equal(b.name, 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20');
  assert.equal(b.serial, b.name);
  assert.equal(b.asics.length, 300);
  assert.equal(b.temperatures.length, 302, 'rows dropped or added');
  // ASIC die sensors only: board inlet and outlet rows parse too (#10).
  const dts = b.temperatures.map((r) => parseSensorName(r.name)).filter((p) => p && p.kind === 'dts');
  assert.equal(dts.length, 300, 'a sensor row no longer parses');
  for (const t of ['ttyMOCK00', 'ttyMOCK10', 'ttyMOCK20']) {
    assert.equal(new Set(dts.filter((p) => p.bus === t).map((p) => p.wireId)).size, 100, t);
  }
  assert.equal(b.temperatures[0].name, 'ttyMOCK20-asic-0-dts');
  assert.ok(b.temperatures.some((r) => r.name === 'board0-inlet'), 'inlet row dropped');
  assert.equal(b.powers.length, 900);
  assert.deepEqual(b.threads.map((t) => t.name), ['BZM2 UART 0', 'BZM2 UART 1', 'BZM2 UART 2']);
  assert.equal(b.fans.length, 4);
  assert.equal(out.sources[0].name, 'pool.invalid:3333');
  assert.equal(out.sources[0].url, 'stratum+tcp://pool.invalid:3333');
  assert.doesNotMatch(JSON.stringify(out), /ttyREAL|secret/);

  const chain = scrubSummary(labChain(), ttyMapForMiner(raw));
  assert.deepEqual(chain.buses.map((x) => x.serial_path), ['/dev/ttyMOCK00', '/dev/ttyMOCK10', '/dev/ttyMOCK20']);
});

async function replay(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mujina-replay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), JSON.stringify(body));
  const child = spawn(process.execPath, ['dev/mock-api.mjs', '--port', String(PORT), '--replay', dir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', r));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  await wait(500);
}

test('--replay serves a 3-bus capture as the one board it is (no split); chain keeps per-bus paths', async (t) => {
  await replay(t, { '02-miner.json': labMiner(), '05-chain-summary.json': labChain() });
  const res = await get('/api/v0/miner');
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body.toString());
  assert.equal(j.boards.length, 1);
  assert.equal(j.boards[0].name, 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20');
  assert.equal(j.boards[0].asics.length, 300);
  assert.equal(j.boards[0].threads.length, 3);
  assert.equal(j.boards[0].fans.length, 4);

  const board = encodeURIComponent(j.boards[0].name);
  const chain = await get(`/api/v0/boards/${board}/bzm2/chain-summary`);
  assert.equal(chain.status, 200);
  const c = JSON.parse(chain.body.toString());
  assert.deepEqual(c.buses.map((x) => x.serial_path), ['/dev/ttyMOCK00', '/dev/ttyMOCK10', '/dev/ttyMOCK20']);
  // capture gap: no asic-summary in the directory
  assert.equal((await get(`/api/v0/boards/${board}/bzm2/asic-summary`)).status, 404);
});

test('--replay serves a 1-bus capture as one board (no clone)', async (t) => {
  await replay(t, { '02-miner.json': labMiner({ buses: ['ttyREAL0'] }) });
  const j = JSON.parse((await get('/api/v0/miner')).body.toString());
  assert.equal(j.boards.length, 1);
  assert.equal(j.boards[0].name, 'bzm2-ttyMOCK00');
  assert.equal(j.boards[0].asics.length, 100);
  assert.equal(j.boards[0].temperatures.filter((r) => /-dts$/.test(r.name)).length, 100);
});
