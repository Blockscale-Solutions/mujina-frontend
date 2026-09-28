#!/usr/bin/env node
/**
 * Zero-dep mock API + static UI server for mujina-bzm2-device-ui.
 * Usage:
 *   node dev/mock-api.mjs [--scenario nominal-3b|nominal-3b-sparse|fault-stub] [--port 7785]
 *   node dev/mock-api.mjs --replay DIR [--port 7785]
 *   ... [--hang PATH[,PATH...]] [--hang-after MS]
 *   ... [--freeze-uptime-after MS] [--summary-500-after MS]
 *
 * --hang: once --hang-after ms (default 0) have passed since start, GET
 * requests to the listed API paths are accepted and never answered (the
 * socket stays open), like a wedged runtime or a dead keep-alive peer.
 * Use --hang all to hang every /api/ path. For exercising the UI's request
 * deadline and freshness clock (issues #3, #4).
 *
 * --freeze-uptime-after: from then on uptime_secs stops advancing while
 * /miner keeps answering (the spec's stale-scheduler scenario, issue #8).
 * --summary-500-after: from then on asic-summary answers 500 with an empty
 * body, like a slow diagnostic holding the board queue (spec :90-91, #6).
 *
 * Serves ui/ at /ui/ and allowlisted GET API paths only.
 * Non-GET → 405; unknown → 404. CSP + nosniff + no-cache on UI assets.
 *
 * Scenarios with seed.json are expanded by gen-scenario.mjs (keeps git small).
 * --replay DIR plays captured miner / asic-summary JSON in lexical order
 * (captures stay outside git; see README, Replaying a capture).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandSeed,
  scrubMiner,
  scrubSummary,
  ttyMapForMiner,
  inventoryCaptureDir,
} from './gen-scenario.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI = path.join(ROOT, 'ui');
const FIX = path.join(__dirname, 'fixtures');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = Number(arg('--port', process.env.PORT || '7785'));
const REPLAY = arg('--replay', null);
const SCENARIO = arg('--scenario', REPLAY ? null : 'nominal-3b');
const HANG = (arg('--hang', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const HANG_AFTER_MS = Number(arg('--hang-after', '0')) || 0;
const FREEZE_UPTIME_AFTER_MS = arg('--freeze-uptime-after', null) == null ? null : Number(arg('--freeze-uptime-after'));
const SUMMARY_500_AFTER_MS = arg('--summary-500-after', null) == null ? null : Number(arg('--summary-500-after'));
const STARTED_AT = Date.now();
const hungSockets = new Set();

function shouldHang(p) {
  if (!HANG.length || !p.startsWith('/api/')) return false;
  if (Date.now() - STARTED_AT < HANG_AFTER_MS) return false;
  return HANG.includes('all') || HANG.includes(p);
}

const requestLog = [];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Load scenario: seed.json → expand, else static miner + *-summary files. */
function loadScenario(name) {
  const dir = path.join(FIX, name);
  if (!fs.existsSync(dir)) {
    console.error(`Unknown scenario: ${name}`);
    process.exit(1);
  }
  const seedPath = path.join(dir, 'seed.json');
  if (fs.existsSync(seedPath)) {
    const expanded = expandSeed(readJson(seedPath));
    return {
      kind: 'seed',
      name,
      miner: expanded.miner,
      summaries: expanded.summaries,
      seedBytes: fs.statSync(seedPath).size,
    };
  }
  const miner = readJson(path.join(dir, 'miner.json'));
  const summaries = Object.create(null);
  for (const b of miner.boards || []) {
    const asicFile = path.join(dir, `asic-summary-${b.name}.json`);
    const chainFile = path.join(dir, `chain-summary-${b.name}.json`);
    summaries[b.name] = {
      asic: fs.existsSync(asicFile) ? readJson(asicFile) : null,
      chain: fs.existsSync(chainFile) ? readJson(chainFile) : null,
    };
  }
  return { kind: 'static', name, miner, summaries };
}

/**
 * Load --replay DIR: lexical miner + asic-summary / chain-summary frames.
 * The capture's /miner is served in its own shape (same board count, same
 * rows), only scrubbed: each real bus tty maps to its own ttyMOCK* on every
 * row, board name and serial_path. A 3-bus unit is served as the one board
 * object it publishes (mujina-bzm2-dev#124 amendment), never split or cloned.
 */
function loadReplay(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`Replay dir not found: ${abs}`);
    process.exit(1);
  }
  const files = listJsonFiles(abs);
  const inv = inventoryCaptureDir(files.map((f) => path.basename(f)));
  if (inv.gaps.length) {
    console.warn('[replay] capture gaps:');
    for (const g of inv.gaps) console.warn(`  - ${g}`);
  }

  const minerFiles = files.filter((f) => {
    const n = path.basename(f);
    return /miner/i.test(n) && !/asic-summary|chain-summary/i.test(n);
  });
  const asicFiles = files.filter((f) => /asic-summary/i.test(path.basename(f)));
  const chainFiles = files.filter((f) => /chain-summary/i.test(path.basename(f)));

  if (!minerFiles.length) {
    console.error('[replay] no *miner*.json frames in', abs);
    process.exit(1);
  }

  const rawMiners = minerFiles.map((f) => ({ file: path.basename(f), body: readJson(f) }));
  // One tty map for the whole capture, so every frame and summary agrees.
  const ttyMap = ttyMapForMiner(rawMiners[0].body);
  const minerFrames = rawMiners.map(({ file, body }) => ({ file, body: scrubMiner(body, ttyMap) }));

  // Summaries are served under the scrubbed board names. With one board object
  // (the real 3-bus shape) the capture's summary is that board's; with several
  // board objects the frames are assigned by index. Frames are not advanced
  // with /miner yet (issue #34).
  const boardNames = (minerFrames[0].body.boards || []).map((b) => b.name).filter(Boolean);
  const asicFrames = asicFiles.map((f) => scrubSummary(readJson(f), ttyMap));
  const chainFrames = chainFiles.map((f) => scrubSummary(readJson(f), ttyMap));
  const summaries = Object.create(null);
  boardNames.forEach((name, i) => {
    summaries[name] = {
      asic: asicFrames.length ? asicFrames[i % asicFrames.length] : null,
      chain: chainFrames.length ? chainFrames[i % chainFrames.length] : null,
    };
  });

  return {
    kind: 'replay',
    name: abs,
    minerFrames,
    minerIndex: 0,
    summaries,
    inventory: inv,
    ttyMap,
  };
}

const startedAt = Date.now();
const state = REPLAY ? loadReplay(REPLAY) : loadScenario(SCENARIO);

function currentMiner() {
  if (state.kind === 'replay') {
    const frame = state.minerFrames[state.minerIndex % state.minerFrames.length];
    return structuredClone(frame.body);
  }
  return structuredClone(state.miner);
}

function mutateMiner(miner) {
  // Nudge numeric values so charts move; never add/remove/rename keys.
  const out = miner;
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  const tick = Math.floor(elapsedSec / 2);
  if (typeof out.hashrate === 'number') {
    out.hashrate = Math.max(0, Math.round(out.hashrate * (1 + 0.01 * Math.sin(tick / 5))));
  }
  if (typeof out.shares_submitted === 'number') {
    out.shares_submitted = out.shares_submitted + Math.floor(elapsedSec / 3);
  }
  if (typeof out.uptime_secs === 'number') {
    const frozenAt = FREEZE_UPTIME_AFTER_MS == null ? Infinity : Math.floor(FREEZE_UPTIME_AFTER_MS / 1000);
    out.uptime_secs = out.uptime_secs + Math.min(elapsedSec, frozenAt);
  }
  if (state.kind === 'replay') {
    // Advance frame slowly so lexical captures play through.
    if (elapsedSec > 0 && elapsedSec % 4 === 0) {
      state.minerIndex = Math.min(state.minerFrames.length - 1, Math.floor(elapsedSec / 4));
    }
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Length': buf.length,
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
}

function uiHeaders(type) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  };
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const full = path.normalize(path.join(root, decoded));
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(reqPath, res) {
  let rel = reqPath.replace(/^\/ui\/?/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = safeJoin(UI, rel);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    return;
  }
  const ext = path.extname(file);
  const type = TYPES[ext] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), uiHeaders(type));
}

function handleApi(urlPath, res) {
  if (urlPath === '/api/v0/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (urlPath === '/api/v0/miner') {
    sendJson(res, 200, mutateMiner(currentMiner()));
    return;
  }

  const m = urlPath.match(/^\/api\/v0\/boards\/([^/]+)\/bzm2\/(asic-summary|chain-summary)$/);
  if (m) {
    const board = decodeURIComponent(m[1]);
    const kind = m[2];
    const entry = state.summaries[board];
    if (!entry) {
      send(res, 404, 'board not in scenario', { 'Content-Type': 'text/plain' });
      return;
    }
    if (kind === 'asic-summary' && SUMMARY_500_AFTER_MS != null && Date.now() - STARTED_AT >= SUMMARY_500_AFTER_MS) {
      send(res, 500, '', { 'Content-Type': 'text/plain' });
      return;
    }
    const body = kind === 'asic-summary' ? entry.asic : entry.chain;
    if (!body) {
      send(res, 404, `${kind} not in capture/scenario`, { 'Content-Type': 'text/plain' });
      return;
    }
    sendJson(res, 200, body);
    return;
  }

  send(res, 404, 'not allowlisted', { 'Content-Type': 'text/plain' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  requestLog.push({ t: Date.now(), method: req.method, path: p });
  if (requestLog.length > 5000) requestLog.shift();

  if (p === '/__mock/requests') {
    sendJson(res, 200, requestLog.slice(-200));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    console.warn(`405 ${req.method} ${p}`);
    send(res, 405, 'method not allowed', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    return;
  }

  if (p === '/' || p === '') {
    res.writeHead(302, { Location: '/ui/' });
    res.end();
    return;
  }

  if (p.startsWith('/ui')) {
    if (req.method === 'HEAD') {
      res.writeHead(200, uiHeaders('text/html; charset=utf-8'));
      res.end();
      return;
    }
    serveStatic(p, res);
    return;
  }

  if (p.startsWith('/api/')) {
    if (req.method === 'GET' && shouldHang(p)) {
      // Never answer. Track the socket so shutdown is not held open by it.
      hungSockets.add(req.socket);
      req.socket.on('close', () => hungSockets.delete(req.socket));
      return;
    }
    handleApi(p, res);
    return;
  }

  console.warn(`404 ${req.method} ${p}`);
  send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mujina-bzm2-device-ui mock`);
  if (state.kind === 'replay') {
    console.log(`  mode:     replay`);
    console.log(`  dir:      ${state.name}`);
    console.log(`  frames:   ${state.minerFrames.length} miner`);
    const b0 = state.minerFrames[0].body.boards || [];
    console.log(`  shape:    ${b0.length} board object(s): ${b0.map((b) => `${b.name} (${(b.threads || []).length} threads, ${(b.asics || []).length} ASICs)`).join('; ')}`);
    if (state.inventory?.gaps?.length) {
      console.log(`  gaps:     ${state.inventory.gaps.join('; ')}`);
    }
  } else {
    console.log(`  scenario: ${state.name} (${state.kind})`);
  }
  console.log(`  UI:       http://127.0.0.1:${PORT}/ui/`);
  console.log(`  API:      http://127.0.0.1:${PORT}/api/v0/miner`);
  console.log(`  log:      http://127.0.0.1:${PORT}/__mock/requests`);
  if (HANG.length) console.log(`  hang:     ${HANG.join(', ')} after ${HANG_AFTER_MS} ms (never answered)`);
  if (FREEZE_UPTIME_AFTER_MS != null) console.log(`  uptime:   frozen after ${FREEZE_UPTIME_AFTER_MS} ms (stale scheduler)`);
  if (SUMMARY_500_AFTER_MS != null) console.log(`  summary:  asic-summary 500 / empty after ${SUMMARY_500_AFTER_MS} ms`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of hungSockets) s.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
