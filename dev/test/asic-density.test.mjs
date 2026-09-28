import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expandSeed } from '../gen-scenario.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 17986;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), bytes: Buffer.concat(chunks).length }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const BOARD = 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20';
const TTYS = ['ttyMOCK00', 'ttyMOCK10', 'ttyMOCK20'];

function seedOf(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, `dev/fixtures/${name}/seed.json`), 'utf8'));
}

// Issue #32: the default seed must be the shape the driver emits
// (mujina-bzm2-dev#124 amendment): ONE board object spanning three buses.
test('nominal-3b is the real driver shape: 1 board, 3 threads, 300 asics as (thread_index, id 0..99)', () => {
  const { miner, summaries } = expandSeed(seedOf('nominal-3b'));
  assert.equal(miner.boards.length, 1);
  const b = miner.boards[0];
  assert.equal(b.name, BOARD);
  assert.deepEqual(b.threads.map((t) => t.name), ['BZM2 UART 0', 'BZM2 UART 1', 'BZM2 UART 2']);

  assert.equal(b.asics.length, 300);
  for (const ti of [0, 1, 2]) {
    const ids = b.asics.filter((a) => a.thread_index === ti).map((a) => a.id).sort((x, y) => x - y);
    assert.deepEqual(ids, [...Array(100).keys()], `thread ${ti} wire ids`);
  }
  assert.ok(b.asics.every((a) => !('serial_path' in a)), 'asics[] carries no serial_path on the unit');
  assert.deepEqual(Object.keys(b.asics[0]).sort(), ['faults', 'id', 'thread_index']);

  const dts = b.temperatures.filter((r) => /-dts$/.test(r.name));
  assert.equal(dts.length, 300);
  for (const tty of TTYS) assert.equal(dts.filter((r) => r.name.startsWith(`${tty}-asic-`)).length, 100, tty);
  // Unit ordering: second and third bus interleaved first, first bus last.
  assert.match(dts[0].name, /^ttyMOCK(10|20)-/);
  assert.ok(dts.slice(200).every((r) => r.name.startsWith('ttyMOCK00-')), 'first bus is not last');
  assert.equal(b.powers.length, 900);
  assert.equal(Object.keys(b.powers[0]).sort().join(','), 'current_a,name,power_w,voltage_v');

  assert.equal(b.fans.length, 4, 'one chassis fan set');
  assert.ok('target_percent' in b.fans[0]);
  assert.ok(b.bzm2_tuning && typeof b.bzm2_tuning === 'object');
  // #22: realistic tuning block (the unit's grows to ~90 KB with uptime).
  assert.equal(b.bzm2_tuning.asics.length, 300);
  const tuningBytes = JSON.stringify(b.bzm2_tuning).length;
  assert.ok(tuningBytes > 60_000 && tuningBytes < 120_000, `bzm2_tuning ${tuningBytes} B`);

  assert.deepEqual(Object.keys(summaries), [BOARD]);
  const s = summaries[BOARD].asic;
  assert.equal(s.dts_vs_generation, 'gen2');
  assert.equal(s.configured_asics, 300);
  assert.equal(s.board.coverage.asics_configured, 300);
  assert.equal(s.buses.length, 3);
  s.buses.forEach((bus, i) => {
    assert.equal(bus.thread_index, i);
    assert.equal(bus.serial_path, `/dev/${TTYS[i]}`);
    assert.equal(bus.asic_start, i * 100);
    assert.equal(bus.thread_active, true);
    const cov = bus.aggregate.coverage;
    assert.equal(cov.asics_configured, 100);
    assert.equal(cov.asics_reporting + (cov.asics_stale ?? 0) + cov.asics_value_suppressed + cov.asics_never_seen, 100);
    assert.ok(bus.aggregate.die_temperature_c);
    assert.equal(bus.aggregate.hottest.thread_index, i);
    assert.ok(bus.aggregate.hottest.wire_asic_id < 100);
    assert.equal(bus.aggregate.hottest.asic_id, i * 100 + bus.aggregate.hottest.wire_asic_id);
  });
  const chain = summaries[BOARD].chain;
  assert.equal(chain.total_asics, 300);
  assert.deepEqual(chain.buses.map((x) => [x.thread_index, x.serial_path, x.asic_start, x.asic_count]),
    TTYS.map((t, i) => [i, `/dev/${t}`, i * 100, 100]));
});

test('sparse seed: one board, 3 buses × 9 populated of 100 configured', () => {
  const { miner, summaries } = expandSeed(seedOf('nominal-3b-sparse'));
  assert.equal(miner.boards.length, 1);
  const b = miner.boards[0];
  assert.equal(b.asics.length, 27);
  const s = summaries[b.name].asic;
  assert.equal(s.board.coverage.asics_configured, 300);
  assert.equal(s.board.coverage.asics_reporting, 27);
  for (const bus of s.buses) {
    assert.equal(bus.aggregate.coverage.asics_configured, 100);
    assert.equal(bus.aggregate.coverage.asics_reporting, 9);
    assert.equal(bus.aggregate.coverage.asics_never_seen, 91);
  }
});

test('fault-stub: faults on (thread 0, wires 2-4) only, board-wide ids in the summary', () => {
  const { miner, summaries } = expandSeed(seedOf('fault-stub'));
  const b = miner.boards[0];
  const faulted = b.asics.filter((a) => a.faults.thermal_fault).map((a) => [a.thread_index, a.id]);
  assert.deepEqual(faulted, [[0, 2], [0, 3], [0, 4]]);
  const bit = summaries[b.name].asic.board.faults.bits.find((x) => x.bit === 'thermal_fault');
  assert.deepEqual(bit.asic_ids, [2, 3, 4]);
  assert.equal(summaries[b.name].asic.buses[1].aggregate.faults.bits.find((x) => x.bit === 'thermal_fault').asics_asserting, 0);
});

test('mock serves nominal-3b as one board object with a 3-bus summary', async (t) => {
  const child = spawn(process.execPath, ['dev/mock-api.mjs', '--port', String(PORT), '--scenario', 'nominal-3b'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
  });
  await wait(500);

  const miner = await get('/api/v0/miner');
  assert.equal(miner.status, 200);
  const j = JSON.parse(miner.body.toString());
  assert.equal(j.boards.length, 1);
  assert.equal(j.boards[0].temperatures.filter((r) => /-dts$/.test(r.name)).length, 300);
  assert.equal(j.boards[0].asics.length, 300);
  // #22: the unit's /miner is 161,111 B at uptime 0 and ~230 KB after a
  // while mining; the seed must sit in that range so budgets are realistic.
  assert.ok(miner.bytes >= 150_000 && miner.bytes <= 260_000, `miner ${miner.bytes} B outside the real 150-260 KB range`);

  const sum = await get(`/api/v0/boards/${BOARD}/bzm2/asic-summary`);
  assert.equal(sum.status, 200);
  const s = JSON.parse(sum.body.toString());
  assert.equal(s.configured_asics, 300);
  assert.equal(s.buses.length, 3);
});
