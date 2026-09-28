import { clearChildren, sanitizeText } from '../sanitize.js';
import { fmtUnknown } from '../format.js';
import { minerFieldsState } from '../freshness.js';
import { renderValue } from './value-state.js';

export function renderFans(root, state, now = Date.now()) {
  if (!root) return;
  const table = root.querySelector('[data-fans-table]');
  if (!table) return;
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  clearChildren(thead);
  clearChildren(tbody);
  const fres = minerFieldsState(state, now);

  const boards = Array.isArray(state.miner?.boards) ? state.miner.boards : [];
  const fanNames = new Set();
  for (const b of boards) {
    for (const f of (b.fans || [])) {
      if (f.name) fanNames.add(f.name);
    }
  }
  const names = [...fanNames].sort();

  const hr = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.textContent = 'fan';
  hr.appendChild(th0);
  for (const b of boards) {
    const th = document.createElement('th');
    th.textContent = sanitizeText(b.name || '?');
    hr.appendChild(th);
  }
  thead.appendChild(hr);

  if (!names.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = boards.length + 1;
    td.textContent = 'fans: not reported';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const fname of names) {
    const tr = document.createElement('tr');
    const tdN = document.createElement('td');
    tdN.textContent = sanitizeText(fname);
    tr.appendChild(tdN);
    for (const b of boards) {
      const td = document.createElement('td');
      const f = (b.fans || []).find((x) => x.name === fname);
      if (!f) {
        td.textContent = fmtUnknown('not_reported');
      } else {
        const rpm = f.rpm == null ? 'rpm unknown' : `${f.rpm} rpm`;
        const duty = f.percent == null ? 'duty unknown' : `${f.percent}%`;
        // never render target_percent. #90: ages with /miner, lost with it.
        renderValue(td, { text: `${rpm} · ${duty}`, ...fres, now });
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}
