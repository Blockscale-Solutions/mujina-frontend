// Each shipped font travels with its licence in full and with the copyright
// notice the font itself carries (OFL-1.1 condition 2; UFL-1.0 condition 1).
// The notice is read from the woff2's own name table, so the licence file
// and the font cannot drift apart unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

const FONTS = new URL('../../ui/fonts/', import.meta.url);
const LICENCE_FOR = [
  [/^jetbrains-mono-/, 'OFL-JetBrainsMono.txt'],
  [/^orbitron-/, 'OFL-Orbitron.txt'],
  [/^ubuntu-/, 'UBUNTU-FONT-LICENCE.txt'],
];

// WOFF2 (W3C WOFF2 §4-5): a table directory, then one Brotli stream holding
// every table back to back. The name table is never transformed.
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep'];
function copyrightNotice(buf) {
  let p = 48;
  const numTables = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const c = buf[p++]; v = v * 128 + (c & 0x7f); if (!(c & 0x80)) return v; } throw new Error('bad UIntBase128'); };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    let tag = KNOWN_TAGS[flags & 0x3f] ?? `#${flags & 0x3f}`;
    if ((flags & 0x3f) === 63) { tag = buf.subarray(p, p + 4).toString('latin1'); p += 4; }
    const version = flags >> 6;
    let length = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    if (transformed) length = base128();
    tables.push({ tag, length });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + compressed));
  let off = 0;
  let name = null;
  for (const t of tables) { if (t.tag === 'name') name = data.subarray(off, off + t.length); off += t.length; }
  assert.ok(name, 'no name table');
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const [platform, , language, id, len, at] = [0, 2, 4, 6, 8, 10].map((k) => name.readUInt16BE(r + k));
    if (platform !== 3 || language !== 0x409 || id !== 0) continue;
    const s = name.subarray(strings + at, strings + at + len);
    let out = '';
    for (let k = 0; k < s.length; k += 2) out += String.fromCharCode(s.readUInt16BE(k));
    return out;
  }
  throw new Error('no copyright notice (name ID 0) in the font');
}

const woff2 = fs.readdirSync(FONTS).filter((f) => f.endsWith('.woff2'));

test('every shipped font has a licence file, and it carries the font\'s own copyright notice', () => {
  assert.ok(woff2.length > 0, 'no woff2 found: this check measured nothing');
  for (const f of woff2) {
    const hit = LICENCE_FOR.find(([re]) => re.test(f));
    assert.ok(hit, `${f}: no licence file mapped`);
    const text = fs.readFileSync(new URL(`licenses/${hit[1]}`, FONTS), 'utf8');
    const notice = copyrightNotice(fs.readFileSync(new URL(f, FONTS)));
    assert.ok(text.includes(notice), `${hit[1]} lacks ${f}'s notice: ${notice}`);
  }
});

test('the licence texts are complete, not abridged', () => {
  for (const f of ['OFL-JetBrainsMono.txt', 'OFL-Orbitron.txt']) {
    const t = fs.readFileSync(new URL(`licenses/${f}`, FONTS), 'utf8');
    for (const part of ['SIL OPEN FONT LICENSE Version 1.1', 'The OFL allows the licensed fonts', 'DEFINITIONS',
      '"Reserved Font Name" refers to', 'binary files as long as those fields can be easily viewed by the user.',
      'This restriction only applies to the primary font name', 'TERMINATION', 'DISCLAIMER']) assert.ok(t.includes(part), `${f}: ${part}`);
  }
  const u = fs.readFileSync(new URL('licenses/UBUNTU-FONT-LICENCE.txt', FONTS), 'utf8');
  for (const part of ['UBUNTU FONT LICENCE Version 1.0', 'PREAMBLE', 'DEFINITIONS', '"Substantially Changed"',
    'PERMISSION & CONDITIONS', '1) Each copy of the Font Software must contain the above copyright', 'TERMINATION', 'DISCLAIMER']) assert.ok(u.includes(part), `UFL: ${part}`);
});
