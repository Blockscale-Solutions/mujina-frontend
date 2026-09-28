// The public seed carries every tracked file less the paths and globs in
// .publish-exclude (Ronald, 2026-09-28: lab notes stay private). One rule in
// one module (dev/publish-files.mjs), used by the seed step and by this gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseExclude, isExcluded, shippedFiles } from '../publish-files.mjs';

test('.publish-exclude: comments and blank lines skip; each other line is one path or glob', () => {
  const p = parseExclude('# lab notes\n\nCAPTURE-GAPS.md\n  notes/  \nlab/**/*.tsv\n*.local\n');
  assert.deepEqual(p.map((x) => x.pattern), ['CAPTURE-GAPS.md', 'notes/', 'lab/**/*.tsv', '*.local']);
  assert.deepEqual(p.map((x) => x.line), [3, 4, 5, 6], 'line numbers point at the file');
});

test('.publish-exclude: a line the seed step could not honour is an error, never skipped', () => {
  for (const bad of ['!keep.md', '/abs/path', '../outside', 'a/../b', 'two words.md']) {
    assert.throws(() => parseExclude(`ok.md\n${bad}\n`), /\.publish-exclude:2:/, bad);
  }
});

test('.publish-exclude matching: a path names that file or that directory; * stays in one segment, ** crosses', () => {
  const p = parseExclude('CAPTURE-GAPS.md\nnotes/\ndocs/lab\n*.local\nlab/**/*.tsv\n');
  const hit = (f) => isExcluded(f, p);
  assert.ok(hit('CAPTURE-GAPS.md'));
  assert.ok(!hit('docs/CAPTURE-GAPS.md'), 'anchored at the repo root');
  assert.ok(!hit('CAPTURE-GAPS.md.bak'));
  assert.ok(hit('notes/a.md') && hit('notes/deep/b.md'));
  assert.ok(!hit('notes'), 'a trailing slash names a directory only');
  assert.ok(hit('docs/lab') && hit('docs/lab/x.md'), 'no slash: the file, or the directory and all under it');
  assert.ok(!hit('docs/labx.md'));
  assert.ok(hit('drives.local') && !hit('campaign/drives.local'), '* does not cross a slash');
  assert.ok(hit('lab/a.tsv') && hit('lab/x/y/a.tsv') && !hit('lab/a.tsv.gz'));
});

test('the shipped list is the tracked files less the excluded ones, and it measured something', (t) => {
  let s;
  try { s = shippedFiles(); } catch (e) {
    t.skip(`unmeasured: ${e.message}`);
    return;
  }
  assert.ok(s.files.length > 0, 'no shipped file found: this gate measured nothing');
  assert.ok(s.files.includes('README.md') && s.files.includes('LICENSE'));
  for (const f of s.excluded) assert.ok(!s.files.includes(f), f);
  for (const f of s.files) assert.ok(!isExcluded(f, s.patterns), f);
});

// ---- What the shipped files say --------------------------------------------
const SELF = 'dev/test/publish-tree.test.mjs';
/** Shipped text files as [{ file, lines }]; binaries (a NUL byte) are skipped. */
function shippedText(t) {
  let s;
  try { s = shippedFiles(); } catch (e) { t.skip(`unmeasured: ${e.message}`); return null; }
  const out = [];
  for (const file of s.files) {
    const buf = fs.readFileSync(path.join(ROOT, file));
    if (buf.subarray(0, 8000).includes(0)) continue;
    out.push({ file, lines: buf.toString('utf8').split('\n') });
  }
  assert.ok(out.length > 0, 'no shipped text file: this gate measured nothing');
  return { ...s, text: out };
}
function grepShipped(text, re, { skip = [] } = {}) {
  const hits = [];
  for (const { file, lines } of text) {
    if (skip.includes(file)) continue;
    lines.forEach((l, i) => { if (re.test(l)) hits.push(`${file}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  return hits;
}

test('#41 and decision 3: no shipped file points at a note that does not ship', (t) => {
  const s = shippedText(t);
  if (!s) return;
  // UX-GAPS.md (a stock route map and stock labels) was deleted for #41; the
  // excluded notes stay private. A pointer to either would dangle in public.
  // .publish-exclude is the mechanism, not a note: naming it points at nothing.
  const names = ['UX-GAPS.md', ...s.excluded.filter((f) => f !== '.publish-exclude').map((f) => path.basename(f))];
  const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  assert.deepEqual(grepShipped(s.text, re, { skip: ['.publish-exclude', SELF] }), []);
  assert.ok(!s.files.includes('UX-GAPS.md'));
});

// The home host names themselves must not ship, not even inside this gate, so
// they live in .publish-deny: private, excluded from the seed, one
// case-insensitive regex per line ('#' comments). Where it is absent (the
// public tree) that check has nothing to measure, and says so.
test('no name from the private deny list (home hosts, lab paths) in a shipped file', (t) => {
  const s = shippedText(t);
  if (!s) return;
  const listPath = path.join(ROOT, '.publish-deny');
  if (!fs.existsSync(listPath)) { t.skip('unmeasured: .publish-deny is private and absent from this tree'); return; }
  assert.ok(s.excluded.includes('.publish-deny'), '.publish-deny would ship: add it to .publish-exclude');
  const deny = fs.readFileSync(listPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
  assert.ok(deny.length > 0, 'empty deny list: this check measured nothing');
  for (const re of deny) assert.deepEqual(grepShipped(s.text, re), [], `.publish-deny: ${re.source}`);
});

test('no private-network address, ssh target or absolute home path in a shipped file', (t) => {
  const s = shippedText(t);
  if (!s) return;
  // Say "the lab controller", "the test unit", "the build host" instead.
  assert.deepEqual(grepShipped(s.text, /\b(192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/), []);
  assert.deepEqual(grepShipped(s.text, /\broot[@]|\/home\/[a-z]|\/workspace\//), []);
});

// Publication rule (2026-09-28): a hash-rate or efficiency figure appears only
// when its own line names the test or case it came from, and nothing frames it
// as final. In dev/ that id is fictional (MJ-TEST-NN; see the next test). The
// patterns match the sibling repos' publication gate, so the two agree.
test('a hash-rate or efficiency figure names its test or case on its own line, never framed as final', (t) => {
  const s = shippedText(t);
  if (!s) return;
  const figure = /[0-9][0-9.,]*\s*(-\s*[0-9][0-9.,]*\s*)?([KMGTPE]H\/s|J\/TH|W\/TH|J\/GH|W\/GH)\b/;
  const cited = /\b(MJ|RDS)-[A-Z0-9]+-[0-9]+\b|\b20[0-9]{6}T[0-9]{6}Z\b/;
  const final = /\b([Ff]inal|[Hh]eadline|[Uu]p to|[Pp]eak|[Mm]ax(imum)?|[Rr]ecord|[Bb]est|[Gg]uaranteed)\b/;
  const bad = [];
  for (const { file, lines } of s.text) {
    lines.forEach((l, i) => {
      if (figure.test(l) && (!cited.test(l) || final.test(l))) bad.push(`${file}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('fixtures and tests name only fictional case ids (MJ-TEST-NN), never a real one beside a synthetic figure', (t) => {
  const s = shippedText(t);
  if (!s) return;
  const dev = s.text.filter(({ file }) => file.startsWith('dev/'));
  assert.ok(dev.length > 0, 'no dev/ file: this check measured nothing');
  assert.deepEqual(grepShipped(dev, /\bMJ-(?!TEST-\d)[A-Z]+-\d+/), []);
});

test('the UI shows no private-spec gap code (G7) and no private issue ref in a string', (t) => {
  const s = shippedText(t);
  if (!s) return;
  const ui = s.text.filter(({ file }) => file.startsWith('ui/'));
  assert.ok(ui.length > 0, 'no ui/ file: this check measured nothing');
  assert.deepEqual(grepShipped(ui, /\bG\d{1,2}\b/), []);
  // Comments may cite the predecessor's tracker (README); code lines may not.
  const code = ui.map(({ file, lines }) => ({ file, lines: lines.map((l) => (/^\s*(\/\/|\/?\*)/.test(l) ? '' : l)) }));
  assert.deepEqual(grepShipped(code, /\b(mujina-bzm2-dev|rdsmujina-env|mujina-bzm2-device-ui)#\d+/), []);
});

// ---- LICENSE and NOTICE (decision 4, 2026-09-28) ---------------------------
const COPYRIGHT = 'Copyright (c) 2026 Reckless Systems, The 256 Foundation, and Blockscale Solutions';
const readRoot = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('LICENSE is the MIT licence with the one copyright line', () => {
  const lines = readRoot('LICENSE').split('\n');
  assert.equal(lines[0], 'MIT License');
  assert.deepEqual(lines.filter((l) => /copyright \(c\)/i.test(l)), [COPYRIGHT]);
  assert.ok(lines.join('\n').includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'));
});

test('NOTICE keeps the marks out of the code licence and names every logo and third-party file', () => {
  const notice = readRoot('NOTICE');
  assert.ok(notice.includes(COPYRIGHT));
  for (const owner of ['Reckless Systems', '256 Foundation', 'Blockscale Solutions']) assert.ok(notice.includes(owner), owner);
  assert.match(notice, /not covered by the MIT License/);
  const logos = fs.readdirSync(path.join(ROOT, 'ui/img')).filter((f) => /logo/.test(f));
  assert.ok(logos.length > 0, 'no logo file found: this check measured nothing');
  for (const f of logos) assert.ok(notice.includes(`ui/img/${f}`), `NOTICE does not name ui/img/${f}`);
  const licences = fs.readdirSync(path.join(ROOT, 'ui/fonts/licenses')).map((f) => `ui/fonts/licenses/${f}`)
    .concat(fs.readdirSync(path.join(ROOT, 'ui/licenses')).map((f) => `ui/licenses/${f}`));
  for (const f of licences) assert.ok(notice.includes(f), `NOTICE does not name ${f}`);
});

// ---- The README describes the tree that ships ------------------------------
test('README Layout names every top-level shipped path, and nothing that does not ship', (t) => {
  let s;
  try { s = shippedFiles(); } catch (e) { t.skip(`unmeasured: ${e.message}`); return; }
  const readme = readRoot('README.md');
  const at = readme.indexOf('\n## Layout\n');
  assert.ok(at >= 0, 'README has no "## Layout" section');
  const section = readme.slice(at + 1).split(/\n## /)[0];
  const named = new Set([...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1].replace(/\/$/, '')));
  const top = new Set(s.files.map((f) => f.split('/')[0]));
  assert.ok(top.size > 0, 'no top-level path: this check measured nothing');
  assert.deepEqual([...top].filter((p) => !named.has(p)).sort(), [], 'shipped but not in Layout');
  assert.deepEqual([...named].filter((p) => !top.has(p.split('/')[0])).sort(), [], 'in Layout but not shipped');
});

test('README and AGENTS.md say where the #NN and predecessor references point', () => {
  for (const f of ['README.md', 'AGENTS.md']) {
    const text = readRoot(f);
    assert.match(text, /private predecessor/, `${f} lacks the private-predecessor note`);
    assert.doesNotMatch(text, /\bPrivate \*\*Device UI\*\*|\bprivate lab UI\b/, f);
  }
});

// One rule with rdsmujina-env tools/publish-seed (2026-09-28): the exclude list is
// the private repo's publication control and never ships itself, so a public tree
// neither carries it nor lists it in the README's Layout.
test('.publish-exclude itself never ships, and the README Layout does not list it', () => {
  const s = shippedFiles(ROOT);
  assert.ok(!s.files.includes('.publish-exclude'), '.publish-exclude is in the shipped list');
  // In the private repo it exists and is excluded; in a public seed it does not exist at all.
  if (fs.existsSync(path.join(ROOT, '.publish-exclude'))) assert.ok(s.excluded.includes('.publish-exclude'), '.publish-exclude is not reported as excluded');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /^- `\.publish-exclude`/m);
});
