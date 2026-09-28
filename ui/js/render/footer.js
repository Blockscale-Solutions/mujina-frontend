import { setText } from '../sanitize.js';
import { fmtKBps, fmtReqPs, fmtAge } from '../format.js';
import { CONFIG } from '../config.js';
import { measuredCost, effectiveMinerIntervalMs } from '../poller.js';

export function renderFooter(root, state, now = Date.now()) {
  if (!root) return;
  const cost = state.cost || {};
  // Measured from the request log at render time, so an empty window reads 0 (#4).
  const rate = measuredCost(now);
  setText(root.querySelector('[data-cost-req]'), fmtReqPs(rate.reqPerSec));
  setText(root.querySelector('[data-cost-kb]'), fmtKBps(rate.kbPerSec * 1024));
  setText(
    root.querySelector('[data-poll-intervals]'),
    // Effective /miner interval: adapts to body size to hold the byte cap (#22).
    `miner ${effectiveMinerIntervalMs()}ms (min ${CONFIG.minerIntervalMs}) · asic-summary ${CONFIG.asicSummaryIntervalMs}ms/board · caps ${CONFIG.maxReqPerSec} req/s · ${CONFIG.maxKBps} KB/s`,
  );
  const age = cost.lastOkAt != null ? now - cost.lastOkAt : null;
  setText(root.querySelector('[data-last-fetch]'), age == null ? 'last fetch: —' : `last fetch: ${fmtAge(age)} ago (browser)`);

  const credit = root.querySelector('[data-credit]');
  if (credit) {
    credit.textContent = '';
    if (CONFIG.footerCreditUrl) {
      const a = document.createElement('a');
      a.href = CONFIG.footerCreditUrl;
      a.textContent = CONFIG.footerCreditLabel;
      credit.appendChild(a);
    } else {
      credit.textContent = CONFIG.footerCreditLabel;
    }
  }
}
