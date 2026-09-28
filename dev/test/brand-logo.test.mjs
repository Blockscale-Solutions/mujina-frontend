// The header logo follows the theme (Ronald, 2026-09-28): on a dark header the
// black-drawn parts of the colour logo vanished. The on-dark file is the same
// logo with a white default fill on its root, so its teal and red-orange
// parts are unchanged. This test keeps the two derived, never drifted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(`../../ui/${p}`, import.meta.url), 'utf8');

test('the on-dark logo is the colour logo with only a white default fill added', () => {
  const light = read('img/reckless-systems-logo.svg');
  const dark = read('img/reckless-systems-logo-on-dark.svg');
  assert.equal(dark, light.replace('<svg ', '<svg fill="#ffffff" '));
});

test('the page shows the on-dark logo in dark mode, by toggle or by system preference', () => {
  const html = read('index.html');
  const css = read('css/app.css');
  assert.match(html, /class="brand-logo brand-logo--on-light"[^>]*src="\.\/img\/reckless-systems-logo\.svg"/);
  assert.match(html, /class="brand-logo brand-logo--on-dark"[^>]*src="\.\/img\/reckless-systems-logo-on-dark\.svg"/);
  assert.match(css, /html\[data-theme="dark"\] \.brand-logo--on-light\s*\{\s*display:\s*none/);
  assert.match(css, /prefers-color-scheme: dark[\s\S]*html:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \.brand-logo--on-dark\s*\{\s*display:\s*inline-block/);
});

// Ronald, 2026-09-28: the Reckless Systems mark links to the bzm2-hwref site
// (until reckless.systems exists); the 256 Foundation mark follows MUJINA and
// links to their site. Offline on the LAN (#124 hard rule 5): the images are
// local files, and only the links point outside.
test('the Reckless Systems mark links to the bzm2-hwref site', () => {
  const html = read('index.html');
  assert.match(html, /<a class="brand-link" href="https:\/\/blockscale-solutions\.github\.io\/bzm2-hwref\/" target="_blank" rel="noopener noreferrer"[^>]*>\s*<img class="brand-logo brand-logo--on-light"/);
});

test('the 256 Foundation mark follows MUJINA, links to their site, and loads local images for both themes', () => {
  const html = read('index.html');
  const mark = html.indexOf('class="brand-mark"'), f256 = html.indexOf('class="brand-256"');
  assert.ok(mark > 0 && f256 > mark, 'the 256 Foundation link comes after the MUJINA wordmark');
  assert.match(html, /<a class="brand-256" href="https:\/\/www\.256foundation\.org\/" target="_blank" rel="noopener noreferrer"/);
  for (const v of ['on-light', 'on-dark']) {
    assert.match(html, new RegExp(`class="brand-256-logo brand-logo--${v}" src="\\./img/256-foundation-logo-${v}\\.png"[^>]*alt="256 Foundation"`));
    assert.ok(fs.statSync(new URL(`../../ui/img/256-foundation-logo-${v}.png`, import.meta.url)).size < 16_000, `${v} logo stays small`);
  }
  assert.doesNotMatch(html, /<img[^>]+src="https?:/, 'no image loads from the network');
});
