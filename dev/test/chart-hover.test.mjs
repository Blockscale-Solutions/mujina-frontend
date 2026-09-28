// #104 (slice of #81): hovering or focusing a line chart reads the sample
// under the pointer. Synthetic data only (spec hard rule 11).
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
const { nearestSample, timeAtX, chartHoverText } = await import('../../ui/js/render/chart-hover.js');

const s = [{ t: 1000, v: 1 }, { t: 3000, v: 2 }, { t: 5000, v: null }, { t: 7000, v: 4 }];

test('#104 the nearest sample by time, and none for an empty series', () => {
  assert.equal(nearestSample(s, 1900).t, 1000);
  assert.equal(nearestSample(s, 2100).t, 3000);
  assert.equal(nearestSample(s, 99999).t, 7000);
  assert.equal(nearestSample([], 5), null);
});

test('#104 the time under x inverts the chart\'s x mapping', () => {
  const g = { t0: 1000, span: 6000, padL: 40, pw: 600 };
  assert.equal(timeAtX(40, g), 1000);
  assert.equal(timeAtX(640, g), 7000);
  assert.equal(timeAtX(340, g), 4000);
});

test('#104 each chart\'s text, a gap and a restart', () => {
  const hr = chartHoverText('hashrate', { t: Date.UTC(2026, 8, 28, 18, 30, 5), v: 2.5e14 }, []);
  assert.match(hr.rows.join(' '), /250\.00 TH\/s/);
  assert.match(hr.rows.join(' '), /5-minute sliding average/);
  assert.match(hr.title, /\d\d:\d\d:\d\d/);
  const die = chartHoverText('die', { t: 1, min: 55.1, mean: 66.2, max: 76.3, spread: 21.2 }, []);
  assert.match(die.rows.join(' '), /min 55\.1 °C/);
  assert.match(die.rows.join(' '), /max 76\.3 °C/);
  const cov = chartHoverText('coverage', { t: 1, reporting: 200, configured: 300, suppressed: 0, neverSeen: 3 }, []);
  assert.match(cov.rows.join(' '), /200 of 300 reporting \(66\.7 %\)/);
  assert.match(cov.rows.join(' '), /never seen 3/);
  const gap = chartHoverText('hashrate', { t: 1, v: null }, []);
  assert.match(gap.rows.join(' '), /no data at this time/);
  assert.doesNotMatch(gap.rows.join(' '), /H\/s/);
  const rs = chartHoverText('hashrate', { t: 10_000, v: 1e12 }, [9_000], 2_000);
  assert.match(rs.rows.join(' '), /Mujina restarted/);
});

// Ronald, 2026-09-28: tooltips hang off the pointer and never cover what it points at.
const { tipPlacement } = await import('../../ui/js/render/tooltip.js');
test('tooltip dangles below-right of the pointer, never over it, and flips left at the edge', () => {
  const p = tipPlacement({ x: 100, y: 50 }, { w: 250, h: 120 }, 600);
  assert.ok(p.left > 100 && p.top > 50, `covers the pointer: ${JSON.stringify(p)}`);
  const e = tipPlacement({ x: 500, y: 50 }, { w: 250, h: 120 }, 600);
  assert.ok(e.left + 250 <= 500, `does not flip clear of the pointer: ${JSON.stringify(e)}`);
  assert.ok(e.left >= 0);
});

const { pointXY } = await import('../../ui/js/render/chart-hover.js');
test('the hovered point sits on the drawn line: x from time, y from the value, per chart', () => {
  const g = { t0: 0, span: 1000, padL: 40, pw: 600, padT: 10, ph: 100, minY: 0, maxY: 200 };
  assert.deepEqual(pointXY('hashrate', { t: 500, v: 100 }, g), { x: 340, y: 60 });
  assert.deepEqual(pointXY('die', { t: 0, mean: 200 }, g), { x: 40, y: 10 });
  assert.deepEqual(pointXY('coverage', { t: 1000, reporting: 50, configured: 100 }, g), { x: 640, y: 85 });
  assert.equal(pointXY('hashrate', { t: 1, v: null }, g), null, 'a gap has no point');
});
