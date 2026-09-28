import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 17985;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('mock allowlist: GET miner/health/summaries ok; POST 405; unknown 404', async (t) => {
  const child = spawn(process.execPath, ['dev/mock-api.mjs', '--port', String(PORT), '--scenario', 'nominal-3b-sparse'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill('SIGTERM'); });

  await wait(400);

  const miner = await get('/api/v0/miner');
  assert.equal(miner.status, 200);
  const j = JSON.parse(miner.body.toString());
  assert.ok(Array.isArray(j.boards));
  assert.equal(j.boards.length, 1, 'real shape: one board object spanning three buses');
  assert.equal(j.boards[0].name, 'bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20');

  const health = await get('/api/v0/health');
  assert.equal(health.status, 200);

  const sum = await get('/api/v0/boards/bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20/bzm2/asic-summary');
  assert.equal(sum.status, 200);

  const chain = await get('/api/v0/boards/bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20/bzm2/chain-summary');
  assert.equal(chain.status, 200);

  const post = await get('/api/v0/miner', 'POST');
  assert.equal(post.status, 405);

  const bad = await get('/api/v0/boards');
  assert.equal(bad.status, 404);

  const ui = await get('/ui/');
  assert.equal(ui.status, 200);
  assert.match(ui.headers['content-security-policy'] || '', /default-src 'none'/);
  assert.equal(ui.headers['x-content-type-options'], 'nosniff');
});
