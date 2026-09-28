import * as store from './store.js';
import { startPoller } from './poller.js';
import { CONFIG } from './config.js';
import { renderSafety } from './render/safety.js';
import { renderKpi } from './render/kpi.js';
import { renderBoards } from './render/boards.js';
import { renderFans } from './render/fans.js';
import { renderCharts, wireChartControls } from './render/charts.js';
import { renderFooter } from './render/footer.js';
import { classifyFreshness } from './freshness.js';
import { setTextIfChanged } from './sanitize.js';

async function loadStatic() {
  const [layout, metrics] = await Promise.all([
    fetch('./layout.json', { method: 'GET', cache: 'no-store' }).then((r) => r.json()),
    fetch('./metrics.json', { method: 'GET', cache: 'no-store' }).then((r) => r.json()),
  ]);
  store.setLayout(layout);
  store.setMetrics(metrics);
  // #101: the pool dataset is a nicety; its absence never blocks the dashboard.
  fetch('./pools.json', { method: 'GET', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
    .then((p) => { if (p) store.setPools(p); }).catch(() => {});
}

function renderAll(state, now = Date.now()) {
  renderSafety(document.querySelector('[data-safety]'), state, now);
  renderKpi(document.querySelector('[data-kpi]'), state, now);
  renderBoards(document.querySelector('[data-boards]'), state, now);
  renderFans(document.querySelector('[data-fans]'), state);
  renderCharts(document.querySelector('[data-charts]'), state);
  renderFooter(document.querySelector('[data-footer]'), state, now);

  const pill = document.querySelector('[data-freshness-pill]');
  if (pill) {
    // #15 / acceptance 9: /miner freshness alone drives the pill (stale at
    // 2x interval, lost at lostAfterMs). API down is shown in the safety strip.
    const fres = classifyFreshness(state.minerAt, CONFIG.minerIntervalMs, now);
    if (pill.getAttribute('data-state') !== fres) pill.setAttribute('data-state', fres);
    setTextIfChanged(pill, fres);
  }
}

/**
 * Freshness clock (#4). Every freshness verdict (pill, board stale class,
 * safety chips, 'last fetch' age, measured cost) depends on the time as well
 * as on the data, so re-render on a clock, not only when a request completes.
 * Stopped while the tab is hidden; on return, re-render at once so pre-hide
 * data is judged against the current time before the first new response.
 */
let clockTimer = null;

function tick() {
  renderAll(store.getState());
}

function startClock() {
  stopClock();
  if (document.hidden) return;
  clockTimer = setInterval(tick, CONFIG.freshnessTickMs);
}

function stopClock() {
  if (clockTimer != null) clearInterval(clockTimer);
  clockTimer = null;
}

function onVisibilityClock() {
  if (document.hidden) {
    stopClock();
  } else {
    tick();
    startClock();
    loadHistory();
  }
}

/**
 * Refill the charts from the server (Ronald, 2026-09-28): on load and on each
 * return to the tab, ask for the samples since the newest one held. Whoever
 * serves the page may answer; with no history source the page is as before.
 */
function loadHistory() {
  const held = store.getState().history.hashrate;
  const since = held.length ? held[held.length - 1].t : Date.now() - CONFIG.chartBufferMs;
  return fetch(`./history.json?since=${Math.floor(since)}`, { method: 'GET', cache: 'no-store' })
    .then((r) => (r && r.ok ? r.json() : null))
    .then((h) => { if (h) store.mergeHistory(h); })
    .catch(() => {});
}

/** Test helper: stop the freshness clock and drop its listener. */
export function _stopClockForTests() {
  stopClock();
  document.removeEventListener('visibilitychange', onVisibilityClock);
}

function main() {
  wireChartControls(document.querySelector('[data-charts]'), (key) => {
    store.setChartWindow(key);
  });
  store.setChartWindow(CONFIG.defaultChartWindow);
  store.subscribe((state) => renderAll(state));
  document.addEventListener('visibilitychange', onVisibilityClock);
  startClock();
  loadStatic().then(() => {
    loadHistory();
    startPoller();
    renderAll(store.getState());
  }).catch(() => {
    loadHistory();
    startPoller();
    renderAll(store.getState());
  });

  window.addEventListener('resize', () => renderAll(store.getState()));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
