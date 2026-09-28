#!/usr/bin/env node
/**
 * The files a public seed of this repo carries: every tracked file, less the
 * paths and globs listed in .publish-exclude at the repo root. This module is
 * the one home of that rule; the seed step and dev/test/publish-tree.test.mjs
 * both read it.
 *
 * .publish-exclude: one path or glob per line, relative to the repo root.
 * Blank lines and lines starting with '#' are skipped. A path names that file,
 * or that directory and everything under it; a trailing '/' names a directory
 * only. '*' and '?' stay within one path segment; '**' crosses segments.
 * Negation, absolute paths, '..' and whitespace are errors, never skipped.
 *
 *   node dev/publish-files.mjs        # shipped files, one per line
 *   node dev/publish-files.mjs -z     # NUL-separated, for xargs -0 / tar --null
 *   node dev/publish-files.mjs --excluded
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function globToRegExp(pattern) {
  const dirOnly = pattern.endsWith('/');
  const p = dirOnly ? pattern.slice(0, -1) : pattern;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(dirOnly ? `^${re}/.+$` : `^${re}(?:/.+)?$`);
}

/** Parse .publish-exclude text into [{ line, pattern, re }]. Throws on a line it cannot honour. */
export function parseExclude(text) {
  const out = [];
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const where = `.publish-exclude:${i + 1}`;
    if (line.startsWith('!')) throw new Error(`${where}: negation is not supported: ${line}`);
    if (line.startsWith('/') || line.split('/').includes('..')) throw new Error(`${where}: must be relative to the repo root: ${line}`);
    if (/\s/.test(line)) throw new Error(`${where}: whitespace in a path is not supported: ${line}`);
    out.push({ line: i + 1, pattern: line, re: globToRegExp(line) });
  });
  return out;
}

export function isExcluded(file, patterns) {
  return patterns.some((p) => p.re.test(file));
}

/** Tracked files that exist on disk, repo-relative. Throws outside a git checkout. */
export function trackedFiles(root = ROOT) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`not a git checkout, or git is missing (${String(e.message).split('\n')[0]})`);
  }
  return out.split('\0').filter((f) => f && fs.existsSync(path.join(root, f)));
}

/** { files, excluded, patterns, unmatched }: unmatched patterns exclude nothing here. */
export function shippedFiles(root = ROOT) {
  const listPath = path.join(root, '.publish-exclude');
  const patterns = fs.existsSync(listPath) ? parseExclude(fs.readFileSync(listPath, 'utf8')) : [];
  const tracked = trackedFiles(root);
  const files = [];
  const excluded = [];
  // The exclude list is the private repo's publication control: it never ships
  // itself (one rule with rdsmujina-env tools/publish-seed).
  for (const f of tracked) (f === '.publish-exclude' || isExcluded(f, patterns) ? excluded : files).push(f);
  const unmatched = patterns.filter((p) => !tracked.some((f) => p.re.test(f))).map((p) => p.pattern);
  return { files, excluded, patterns, unmatched };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const s = shippedFiles();
  for (const u of s.unmatched) process.stderr.write(`publish-files: .publish-exclude pattern matches no tracked file: ${u}\n`);
  const list = args.includes('--excluded') ? s.excluded : s.files;
  process.stdout.write(args.includes('-z') ? list.map((f) => `${f}\0`).join('') : list.map((f) => `${f}\n`).join(''));
}
