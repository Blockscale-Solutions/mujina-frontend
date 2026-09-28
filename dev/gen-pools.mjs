#!/usr/bin/env node
// Generate ui/pools.json from mempool's pool dataset (#101).
//
//   node dev/gen-pools.mjs <mining-pools clone> [out dir (ui)] [commit]
//
// Source: https://github.com/mempool/mining-pools, pools-v2.json, MIT. Each
// row keeps id, name, mempool's slug (name, alphanumerics, lower case:
// backend/src/api/pools-parser.ts) and the domain of its link. Rows with no
// link, and domains several pools share (github.com, twitter.com), are
// dropped by rule and counted. The commit comes from the clone's git.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [src, outDir = new URL('../ui', import.meta.url).pathname, given] = process.argv.slice(2);
if (!src) { console.error('usage: node dev/gen-pools.mjs <mining-pools clone> [out dir] [commit]'); process.exit(64); }
const commit = given || execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const rows = JSON.parse(fs.readFileSync(path.join(src, 'pools-v2.json'), 'utf8'));
const domainOf = (link) => {
  try { return new URL(link).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
};
const count = new Map();
for (const p of rows) { const d = domainOf(p.link); if (d) count.set(d, (count.get(d) || 0) + 1); }
const dropped = { no_link: 0, shared_domain: 0 };
const pools = [];
for (const p of rows) {
  const d = domainOf(p.link);
  if (!d) { dropped.no_link++; continue; }
  if (count.get(d) > 1) { dropped.shared_domain++; continue; }
  pools.push({ id: p.id, name: p.name, slug: p.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), domain: d });
}
pools.sort((a, b) => a.id - b.id);
const out = { source: 'https://github.com/mempool/mining-pools', commit, license: 'MIT', file: 'pools-v2.json',
  generated_by: 'dev/gen-pools.mjs', dropped, pools };
fs.writeFileSync(path.join(outDir, 'pools.json'), JSON.stringify(out, null, 1) + '\n');
fs.mkdirSync(path.join(outDir, 'licenses'), { recursive: true });
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(outDir, 'licenses', 'mining-pools.txt'));
console.log(`${pools.length} pools (dropped: ${JSON.stringify(dropped)}) from ${commit.slice(0, 12)}`);
