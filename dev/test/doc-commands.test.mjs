// Documented commands are part of the product. Issue #2: `node --test <dir>`
// runs the suite on Node 20 and fails on Node 22, so the docs gave two verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? markdownFiles(p) : e.name.endsWith('.md') ? [p] : [];
  });
}

test('documented node --test commands name files, never a bare directory', () => {
  const bad = [];
  let seen = 0;
  for (const f of markdownFiles(ROOT)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/node --test\s+(\S+)/);
      if (!m) return;
      seen++;
      const target = path.join(ROOT, m[1].replace(/['"]/g, ''));
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.ok(seen > 0, 'no documented node --test command found: this check measured nothing');
  assert.deepEqual(bad, []);
});
