import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUserinfo, maskAddresses, sanitizeText } from '../../ui/js/sanitize.js';
import { parseSensorName, roundTripOk } from '../../ui/js/parse-sensors.js';

test('strip userinfo from URLs', () => {
  assert.equal(
    stripUserinfo('stratum+tcp://user:pass@pool.invalid:3333'),
    'stratum+tcp://pool.invalid:3333',
  );
});

test('mask bech32-shaped and base58-shaped strings', () => {
  const s = maskAddresses('note bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 and 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa end');
  assert.match(s, /‹masked›/);
  assert.doesNotMatch(s, /bc1q/);
});

test('sanitize composes strip + mask', () => {
  const s = sanitizeText('stratum+tcp://alice@pool.invalid:3333 bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(s.includes('alice@'), false);
  assert.match(s, /‹masked›/);
});

test('sensor name parser round-trips', () => {
  const names = [
    'ttyMOCK00-asic-0-dts',
    'ttyMOCK00-asic-3-vs-ch2',
    'ttyMOCK00-asic-1-vs',
  ];
  for (const n of names) assert.equal(roundTripOk(n), true, n);
  assert.equal(parseSensorName('<img src=x>'), null);
});

// #23: userinfo is stripped from scheme-less strings too, up to the LAST '@'.
test('#23 scheme-less userinfo is stripped, and a password containing @ does not leak', () => {
  assert.equal(sanitizeText('alice:hunter2@pool.example:3333'), 'pool.example:3333');
  const s = sanitizeText('stratum+tcp://u:p@ss@h:1');
  assert.equal(s, 'stratum+tcp://h:1');
});

// #24: addresses joined to '_' or to letters are still masked (hard rule 2:
// false positives are acceptable, false negatives are not).
test('#24 the masker catches addresses joined to underscores or letters', () => {
  for (const s of ['bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh_rig', 'worker_1BvBMSEYstWetqTEn5Au4m4GFg7xJaNVN2',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq_rig1', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2_rig1',
    'addr_1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'payoutbc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq.rig1']) {
    const m = maskAddresses(s);
    assert.match(m, /‹masked›/, s);
    for (const frag of ['bc1qxy2', 'bc1qar0', '1BvBMSEY']) assert.ok(!m.includes(frag), `${s} -> ${m}`);
  }
});
