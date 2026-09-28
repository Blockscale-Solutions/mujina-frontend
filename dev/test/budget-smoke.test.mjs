import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowlistedPath, CONFIG } from '../../ui/js/config.js';

test('allowlist helper accepts only known GET shapes', () => {
  assert.equal(isAllowlistedPath('/api/v0/miner'), true);
  assert.equal(isAllowlistedPath('/api/v0/health'), true);
  assert.equal(isAllowlistedPath('/api/v0/boards/bzm2-ttyMOCK00/bzm2/asic-summary'), true);
  assert.equal(isAllowlistedPath('/api/v0/boards/bzm2-ttyMOCK00/bzm2/chain-summary'), true);
  assert.equal(isAllowlistedPath('/api/v0/boards'), false);
  assert.equal(isAllowlistedPath('/api/v0/boards/x'), false);
  assert.equal(isAllowlistedPath('/api/v0/miner/../boards'), false);
});

test('budget caps are within issue hard limits', () => {
  assert.ok(CONFIG.maxReqPerSec <= 1.2);
  assert.ok(CONFIG.maxKBps <= 100);
  assert.ok(CONFIG.minerIntervalMs >= 1000);
  assert.ok(CONFIG.asicSummaryIntervalMs >= 1000);
});

test('steady-state planned rate under 1.2 req/s (3 boards)', () => {
  // miner every 2s = 0.5; asic-summary every 5s × 3 = 0.6; total 1.1
  const miner = 1000 / CONFIG.minerIntervalMs;
  const summaries = (3 * 1000) / CONFIG.asicSummaryIntervalMs;
  const total = miner + summaries;
  assert.ok(total <= CONFIG.maxReqPerSec + 1e-9, `planned ${total} > ${CONFIG.maxReqPerSec}`);
});
