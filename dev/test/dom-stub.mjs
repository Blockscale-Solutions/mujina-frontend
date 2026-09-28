// Shared stub DOM and fake-clock helpers for tests that boot ui/js/app.js.
// Not a test file itself (the suite runs dev/test/*.test.mjs).
import { mock } from 'node:test';

const realSetImmediate = setImmediate;

export function el(name) {
  const attrs = Object.create(null);
  const kids = [];
  let text = '';
  const e = {
    name, writes: 0, attrWrites: 0, kids,
    get textContent() { return text; },
    set textContent(v) { text = String(v); e.writes++; },
    setAttribute(k, v) { attrs[k] = String(v); e.attrWrites++; },
    removeAttribute(k) { delete attrs[k]; e.attrWrites++; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(c) { kids.push(c); return c; },
    removeChild(c) { kids.splice(kids.indexOf(c), 1); return c; },
    get firstChild() { return kids[0] || null; },
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector: (sel) => (e.children && e.children[sel]) || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return e;
}

/**
 * Install globalThis.document / window with recording elements for the pill,
 * the safety headline and chips, and the footer. Every other root is null, so
 * those renderers return early.
 */
export function installDom() {
  const pill = el('pill');
  const headline = el('headline');
  const chips = el('chips');
  const age = el('safety-age'); // aria-hidden sibling of the live headline
  age.setAttribute('aria-hidden', 'true');
  const safety = el('safety');
  safety.children = { '[data-safety-headline]': headline, '[data-safety-chips]': chips, '[data-safety-age]': age };
  const lastFetch = el('last-fetch');
  const costReq = el('cost-req');
  const footer = el('footer');
  footer.children = { '[data-last-fetch]': lastFetch, '[data-cost-req]': costReq };
  const roots = { '[data-freshness-pill]': pill, '[data-safety]': safety, '[data-footer]': footer };

  const docListeners = Object.create(null);
  globalThis.document = {
    hidden: false,
    readyState: 'complete',
    querySelector: (sel) => roots[sel] || null,
    createElement: (tag) => el(tag),
    createTextNode: (t) => ({ textContent: t }),
    addEventListener(type, fn) { (docListeners[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { docListeners[type]?.delete(fn); },
  };
  globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    devicePixelRatio: 1,
  };
  const fire = (type) => { for (const fn of docListeners[type] || []) fn(); };
  return { pill, headline, chips, age, lastFetch, costReq, fire };
}

export function okResponse(body) {
  const buf = new TextEncoder().encode(JSON.stringify(body)).buffer;
  return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => buf };
}

export async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => realSetImmediate(r));
}

/** Advance the mocked clock in small steps, letting promise chains run. */
export async function advance(ms, step = 5) {
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); }
}
