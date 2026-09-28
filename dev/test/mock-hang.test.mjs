// The mock can play a hung endpoint (issues #3, #4): with --hang, a listed
// path is accepted and never answered, while other paths still answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 17988;
const base = `http://127.0.0.1:${PORT}`;

async function ready(child) {
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('UI:')) resolve(); });
    child.on('exit', (c) => reject(new Error(`mock exited ${c}`)));
  });
}

test('--hang /api/v0/miner: miner never answers, health still does', async (t) => {
  const child = spawn(process.execPath,
    ['dev/mock-api.mjs', '--port', String(PORT), '--scenario', 'nominal-3b-sparse', '--hang', '/api/v0/miner'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  await ready(child);

  const health = await fetch(`${base}/api/v0/health`, { signal: AbortSignal.timeout(2000) });
  assert.equal(health.status, 200);

  await assert.rejects(
    fetch(`${base}/api/v0/miner`, { signal: AbortSignal.timeout(300) }),
    (e) => e.name === 'TimeoutError' || e.name === 'AbortError',
    'hung /miner answered',
  );
});
