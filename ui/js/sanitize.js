/** textContent-only rendering helpers; mask addresses; strip userinfo. */

// #24: no word boundaries, so an address joined to '_' or to letters is
// still caught. Hard rule 2: false positives are acceptable, false negatives
// are not.
const BECH32 = /((?:bc1|tb1|bcrt1)[a-z0-9]{20,90})/gi;
const BASE58 = /([13mn2][a-km-zA-HJ-NP-Z1-9]{25,34})/g;
const MASK = '‹masked›';

export function stripUserinfo(s) {
  if (s == null || typeof s !== 'string') return s;
  // #23: up to the LAST '@' of the authority, so a password containing '@'
  // cannot leak; and scheme-less too, since sources[].name is the pool URL
  // with its scheme removed.
  s = s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s]*@/g, '$1');
  if (!s.includes('://') && /^[^\s/]*@[^\s@/]+$/.test(s)) s = s.slice(s.lastIndexOf('@') + 1);
  return s;
}

/**
 * #23, with Ronald's direction (2026-09-28): the userinfo of a pool URL, so
 * the UI can show the user and keep the password hidden until asked.
 * Returns { user, pass } (pass null when absent), or null without userinfo.
 */
export function splitUserinfo(raw) {
  const s = String(raw ?? '');
  const i = s.indexOf('://');
  const authority = s.slice(i < 0 ? 0 : i + 3).split('/')[0];
  const at = authority.lastIndexOf('@');
  if (at < 0) return null;
  const info = authority.slice(0, at);
  const c = info.indexOf(':');
  return c < 0 ? { user: info, pass: null } : { user: info.slice(0, c), pass: info.slice(c + 1) };
}

export function maskAddresses(s) {
  if (s == null || typeof s !== 'string') return s;
  return s.replace(BECH32, MASK).replace(BASE58, MASK);
}

export function sanitizeText(s) {
  if (s == null) return '';
  return maskAddresses(stripUserinfo(String(s)));
}

/** Set element text via textContent only (never innerHTML with API data). */
export function setText(el, value) {
  if (!el) return;
  el.textContent = sanitizeText(value == null ? '' : String(value));
}

/**
 * Like setText, but only writes when the text changes. Use on aria-live
 * regions so a periodic re-render does not re-announce the same text (#4).
 */
export function setTextIfChanged(el, value) {
  if (!el) return;
  const next = sanitizeText(value == null ? '' : String(value));
  if (el.textContent !== next) el.textContent = next;
}

export function clearChildren(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function appendText(el, value) {
  if (!el) return;
  el.appendChild(document.createTextNode(sanitizeText(value == null ? '' : String(value))));
}
