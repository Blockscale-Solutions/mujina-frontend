// #101 (slice of #85): the connected pool is named from mempool's MIT pool
// dataset, as mempool does, with a lettered icon until a logo is cleared.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const { identifyPool, monogram } = await import('../../ui/js/pools.js');
const ROOT = new URL('../../', import.meta.url).pathname;
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/pools.json'), 'utf8'));

test('#101 a stratum host under a pool\'s own domain names that pool', () => {
  assert.equal(identifyPool('mine.ocean.xyz', data)?.name, 'OCEAN');
  assert.equal(identifyPool('MINE.OCEAN.XYZ', data)?.name, 'OCEAN');
  assert.equal(identifyPool('stratum.braiins.com', data)?.name, 'Braiins Pool');
  assert.equal(identifyPool('btc.f2pool.com', data)?.name, 'F2Pool');
});

test('#101 look-alikes, private and local hosts never match', () => {
  for (const h of ['evilocean.xyz', 'ocean.xyz.evil.net', '192.0.2.5', '198.51.100.2', '172.20.1.1', 'localhost', 'datum.local',
    'node.lan', 'x.home.arpa', 'fe80::1', '[::1]', '', null]) assert.equal(identifyPool(h, data), null, String(h));
});

test('#101 the committed dataset carries its source, commit and licence; every slug follows mempool\'s rule', () => {
  assert.equal(data.source, 'https://github.com/mempool/mining-pools');
  assert.match(data.commit, /^[0-9a-f]{40}$/);
  assert.equal(data.license, 'MIT');
  assert.ok(data.pools.length > 100, `${data.pools.length} pools`);
  for (const p of data.pools) assert.equal(p.slug, p.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), p.name);
  assert.ok(fs.readFileSync(path.join(ROOT, 'ui/licenses/mining-pools.txt'), 'utf8').includes('MIT License'));
});

test('#101 the generator drops pools with no link and domains several pools share', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pools-'));
  fs.writeFileSync(path.join(d, 'pools-v2.json'), JSON.stringify([
    { id: 1, name: 'Solo One', link: 'https://github.com/a' }, { id: 2, name: 'Solo Two', link: 'https://github.com/b' },
    { id: 3, name: 'Ocean', link: 'https://www.ocean.xyz/' }, { id: 4, name: 'No Link', link: '' }]));
  fs.writeFileSync(path.join(d, 'LICENSE'), 'MIT License\n');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pools-out-'));
  execFileSync('node', [path.join(ROOT, 'dev/gen-pools.mjs'), d, out, '0'.repeat(40)]);
  const g = JSON.parse(fs.readFileSync(path.join(out, 'pools.json'), 'utf8'));
  assert.deepEqual(g.pools, [{ id: 3, name: 'Ocean', slug: 'ocean', domain: 'ocean.xyz' }]);
  assert.deepEqual(g.dropped, { no_link: 1, shared_domain: 2 });
});

test('#101 a two-letter icon: initials of a multi-word name, else the first two characters', () => {
  assert.equal(monogram('OCEAN'), 'OC');
  assert.equal(monogram('Braiins Pool'), 'BP');
  assert.equal(monogram('F2Pool'), 'F2');
  assert.equal(monogram(''), '?');
});
