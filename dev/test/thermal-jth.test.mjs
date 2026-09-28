// Ronald, 2026-09-28: a J/TH chart card and a fan/temperature chart card (#103: die temperature and
// fan speed on two fixed axes, superseding the Fans card and the die band chart; J/TH from the
// harness, #82 / #106). Synthetic data only (spec hard rule 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.document ||= { documentElement: { getAttribute: () => null } };
const store = await import('../../ui/js/store.js');
const { chartHoverText } = await import('../../ui/js/render/chart-hover.js');
const { drawThermalChart } = await import('../../ui/js/render/charts.js');

const fans = (rpm) => [0, 1, 2, 3].map((i) => ({ name: `fan${i}`, rpm: rpm + i, percent: 100, target_percent: null }));
const miner = (x = {}) => ({ uptime_secs: 100, hashrate: 1e14, boards: [{ name: 'bzm2-A', fans: fans(6700), threads: [] }], sources: [], ...x });

test('the store keeps fan history per board, and harness power once per reading', () => {
  const hz = { input_w: 1234, input_w_at: '2026-09-28T18:40:00.000Z', j_per_th: 12.3 };
  store.setMiner(miner({ harness: hz }), 1000);
  store.setMiner(miner({ uptime_secs: 102, harness: hz }), 3000);
  store.setMiner(miner({ uptime_secs: 104, harness: { ...hz, input_w_at: '2026-09-28T18:40:02.000Z', j_per_th: 12.4 } }), 5000);
  const s = store.getState();
  assert.equal(s.history.fans['bzm2-A'].length, 3);
  assert.equal(s.history.fans['bzm2-A'][2].fans[0].rpm, 6700);
  assert.deepEqual(s.history.power.map((p) => p.v), [12.3, 12.4], 'a repeated reading is not a new sample');
});

test('hover: fans and die together; J/TH with its watts, labelled wall-side', () => {
  const th = chartHoverText('thermal', { t: 1, die: { min: 55.1, mean: 66.2, max: 76.3 }, fans: fans(6700) }, []);
  const t = th.rows.join(' | ');
  assert.match(t, /min 55\.1 °C · mean 66\.2 °C · max 76\.3 °C/);
  assert.match(t, /fan0 6700 rpm · 100 %/);
  assert.match(t, /fan3 6703 rpm/);
  const j = chartHoverText('jth', { t: 1, v: 12.3, w: 1234 }, []).rows.join(' | ');
  assert.match(j, /12\.3 J\/TH/);
  assert.match(j, /1,234 W/);
  assert.match(j, /wall-side/);
});

function recordingCanvas() {
  const texts = [];
  const st = {};
  const ctx = new Proxy({}, {
    get: (_, k) => (k in st ? st[k] : k === 'fillText' ? (s) => texts.push(s) : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}),
    set: (_, k, v) => { st[k] = v; return true; },
  });
  const rect = () => ({ width: 400, height: 160 });
  return { texts, canvas: { getBoundingClientRect: rect, parentElement: { getBoundingClientRect: rect }, getContext: () => ctx, style: {} } };
}

test('the thermal chart\'s axes are fixed: the same labels for 60 °C and 70 °C data', () => {
  const draw = (c) => {
    const { texts, canvas } = recordingCanvas();
    drawThermalChart(canvas, { die: [{ t: 0, min: c - 5, mean: c, max: c + 5 }, { t: 10, min: c - 5, mean: c, max: c + 5 }],
      fans: [{ t: 0, fans: fans(3000) }, { t: 10, fans: fans(3100) }], scale: { min: 40, max: 100 }, rpmMax: 7000, markers: [] });
    return texts.filter((x) => /°C|rpm/.test(x));
  };
  const a = draw(60), b = draw(70);
  assert.ok(a.some((x) => /°C/.test(x)) && a.some((x) => /rpm/.test(x)), `both axes labelled: ${a}`);
  assert.deepEqual(a, b);
});

test('markup: one thermal card replaces the die band chart, the fans table stays as its table view, and a J/TH card', () => {
  const html = fs.readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-chart="thermal"/);
  assert.match(html, /data-chart="jth"/);
  assert.doesNotMatch(html, /data-chart="die"/);
  assert.match(html, /<details[^>]*>[\s\S]*data-fans-table[\s\S]*<\/details>/, 'the fans table as the chart\'s table view');
  assert.doesNotMatch(html, /section-eyebrow">Fans</, 'the separate Fans card is gone');
});
