# mujina-frontend

The **Mujina Device UI**: a read-only, live telemetry dashboard for the Mujina
miner (a 256 Foundation project) on BZM2 hashboards.
It shows one unit: a safety strip, the key figures, one card and heatmap per
hashboard bus, and charts. It never writes to the miner.

The page is plain static files. It has no build step, no npm runtime
dependencies and no CDN, and it works offline on the LAN.

> **References to a private predecessor.** This code was developed in a
> private predecessor repository. Bare issue references such as `#90`, links
> to `Blockscale-Solutions/mujina-bzm2-dev`, `Blockscale-Solutions/rdsmujina-env`
> or `Blockscale-Solutions/mujina-bzm2-device-ui`, and mentions of "the spec",
> "spec :NN", "hard rule N" or gap codes such as G7 all point at that
> predecessor's trackers and its Device UI specification (mujina-bzm2-dev#124).
> Those are not public, and a bare `#NN` is not an issue in this repository.

## What this is

- Standalone static app (`ui/`) + zero-dependency mock API (`dev/mock-api.mjs`)
- Vanilla JS ES modules — **no build step, no npm runtime deps, no CDN**
- Serial poller, budget meter, pause when hidden, freshness live/stale/lost
- Safety strip (never “OK” / green safety), KPI row, one card + heatmap per bus,
  charts (hashrate, die temperature with fans, J/TH, coverage; 1m default / 5m / 15m),
  footer cost meter
- Theme: light / dark / system (`localStorage` key `mujina-theme`)

## What the page reads

All requests are `GET`s. Nothing is ever written.

**Mujina's API**, allowlisted in `ui/js/config.js` (any other path is refused
before it is sent):

- `/api/v0/miner`
- `/api/v0/boards/{name}/bzm2/asic-summary`
- `/api/v0/boards/{name}/bzm2/chain-summary`
- `/api/v0/health`

**Files served next to the page** (`ui/js/app.js`):

- `./layout.json` and `./metrics.json`: the heatmap grid and the display
  scales. Both ship in `ui/`; if they fail to load, polling still starts.
- `./pools.json`: pool names and domains, shipped in `ui/` (see `NOTICE`).
  Without it the pool card shows the host only.
- `./history.json?since=<ms>`: **optional**. On load and on each return to the
  tab the page asks for chart samples newer than the ones it holds, so the
  charts refill at once. Mujina itself does not serve it; without it the charts
  start empty and fill from polling. The shape is the one
  `mergeHistory` in `ui/js/store.js` reads: `hashrate`, `power`, and per-board
  `die`, `coverage` and `fans` rows, each a `[t, ...values]` array.

**Optional `miner.harness` object.** A test harness may add a `harness` object
to the `/miner` body it relays: `case`, `worker`, `input_w`, `input_w_at` and
`j_per_th` (`ui/js/render/kpi.js`, `ui/js/store.js`). The power tile and the
J/TH chart then show that wall-side input power, labelled as the harness's and
never as Mujina's. Mujina itself sends no `harness`, and the tile reads "not
reported".

## How to run (mock)

Requires Node ≥ 18.

```bash
node dev/mock-api.mjs
# open http://127.0.0.1:7785/ui/
# default scenario: nominal-3b (one board object, 3 buses × 100 ASICs: the real driver shape)
```

Scenarios:

```bash
node dev/mock-api.mjs --scenario nominal-3b
node dev/mock-api.mjs --scenario nominal-3b-sparse   # 9 populated / 100 configured
node dev/mock-api.mjs --scenario fault-stub --port 7785
node dev/mock-api.mjs --hang /api/v0/miner --hang-after 10000   # /miner stops answering after 10 s
node dev/mock-api.mjs --hang all --hang-after 10000             # every API path hangs (wedged runtime)
node dev/mock-api.mjs --freeze-uptime-after 10000   # uptime_secs frozen, /miner still answers (stale scheduler, #8)
node dev/mock-api.mjs --summary-500-after 10000     # asic-summary 500 / empty body (slow diagnostic, #6)
```

Every request carries a deadline (`CONFIG.minerTimeoutIntervals` × `minerIntervalMs`
for `/miner`, `healthTimeoutMs`, `asicSummaryTimeoutMs`, `chainSummaryTimeoutMs`),
and a 1 s clock (`CONFIG.freshnessTickMs`, paused while the tab is hidden)
re-renders freshness, so a hung feed goes live → stale → lost on its own.

The safety headline reaches **STALE** (amber) when a board summary is stale, lost or
unavailable (a failed asic-summary keeps its last data, shown as "summary unavailable
(reason not exposed)"), or when `uptime_secs` has not changed for `schedulerStaleSecs`
(25 s): hashrate, shares, uptime and paused are then marked "stale Ns". Non-live summary
chips drop "(measured)" and say "last measured … ago"; a last-known asserted bit still
gives the red FAULT headline, labelled with its time.

**Lost values (#14, #56).** A value that is lost (hard rule 6) reads "—". The last value
and its browser receipt time appear only in its tooltip (`title`). One renderer
(`ui/js/render/value-state.js`) does this for the KPI row and the board cards:
- Hashrate, shares and uptime go lost when uptime has been frozen for more than 60 s,
  the last `/miner` reply is more than 60 s old, or the API is down. The headline keeps
  the scheduler STALE text.
- Board-card values go lost when that board's own asic-summary is more than 60 s old,
  was never received, or the API is down. They never borrow the `/miner` time.
- A failing asic-summary reports its age class and "summary unavailable" side by side
  (`summaryState` in `ui/js/freshness.js`, shared by the strip and the cards), and
  reaches lost at 60 s.
- A FAULT headline still wins over stale and lost.

Replay a capture directory of your own, kept outside git (see
[Replaying a capture](#replaying-a-capture)):

```bash
node dev/mock-api.mjs --replay /path/to/capture-dir
```

Smoke tests:

```bash
node --test dev/test/*.test.mjs
```

## Fixtures (seed → expand)

Committed trees under `dev/fixtures/` are **small seeds** only. At serve time
`dev/gen-scenario.mjs` expands them to gen2-shaped
`MinerTelemetry` / `Bzm2AsicSummaryResponse` / `Bzm2ChainSummaryResponse`
bodies. Key set follows Mujina's `mujina-miner/src/api_client/types.rs` at the private
predecessor's commit `mujina-bzm2-dev@3f783d9`.
Numeric values are synthetic (a real capture is served by `--replay` instead); **keys are not invented**.

Every scenario models the shape the driver emits (mujina-bzm2-dev#124 amendment,
issue #32): **one** board object `bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20` spanning three
buses, threads `BZM2 UART 0..2`, one chassis fan set, `asics[]` rows
`{ id, thread_index, faults }` with the wire id 0..99 repeating on every bus and no
`serial_path`, sensor rows ordered as on the unit (second and third bus interleaved,
first bus last), and a 3-bus `asic-summary` / `chain-summary`.

| Scenario | Seed bytes (approx) | Expanded `/miner` | `asic-summary` (3 buses) | `chain-summary` |
|---|---:|---:|---:|---:|
| `nominal-3b` | ~2.6 KB | **~220 KB** (3 buses × 100, ~86 KB `bzm2_tuning`) | ~5.7 KB | ~0.4 KB |
| `nominal-3b-sparse` | ~2.5 KB | ~22 KB (3 buses × 9 of 100) | ~6.0 KB | ~0.4 KB |
| `fault-stub` | ~2.7 KB | ~22 KB | ~6.1 KB | ~0.4 KB |

Committed fixture total ≪ 400 KB (seeds only). The expanded `/miner` is sized like the
unit's (161 KB at uptime 0, about 230 KB after a while mining, most of the growth in
`bzm2_tuning`).

**Poll budget:** the `/miner` delay adapts to the last body size so every 60 s window stays
under `maxKBps` (100 KiB/s). It is sized against the *planned* rate of the other endpoints
(boards × last asic-summary size × summaries per window, plus chain-summary / `/health`
bytes still in the window), reserves one extra `/miner` body for the window edges, and aims
`byteCapMargin` (3 %) under the cap (#46). For the 219,788 B seed body that is about 2.33 s;
headless Chromium measured 94.3 KiB/s (wire) for the worst 60 s window. The footer shows the
effective interval. Failures back off per endpoint (2 s … 30 s, ±20 % jitter). One failed
`/miner` is a blip: normal polling continues on backoff. After `apiDownAfterFailures` (3)
consecutive `/miner` failures the API is declared down and only `/health` is probed; a
`/health` success gives `/miner` the full three strikes again. A known red FAULT stays the
headline (labelled "last known HH:MM:SS", with a ticking "N s ago" beside it outside the
live region), with API-down shown as a chip. The pill follows `/miner` freshness alone
(stale at 2× interval, lost at 60 s).

Measured time from the last good `/miner` to API-down (headless Chromium, default config):
**refused connection ≈ 9 s** (three fast failures plus 2 s and 4 s backoff); **hung feed
≈ 30–40 s**, because each strike waits out the 4 s `/miner` deadline, and a hung
asic-summary (8 s deadline) sits in the serial queue ahead of each retry. Allowlist
unchanged.

The UI keys per-hashboard cards by **bus**, not by board object: one card per bus,
from chain-summary `buses` (else asic-summary `buses[]`, else the `-dts` row
prefixes), and the heatmap joins `asics[]` on `(thread_index, id)`.

`ui/layout.json` remains 10×10 / 100; heatmaps render 100 cells. Die min/mean/max
come from `asic-summary` aggregates (not averaged in the browser).

## Replaying a capture

`node dev/mock-api.mjs --replay DIR` serves a directory of API responses you
recorded from your own unit. Keep that directory outside git.

- It plays the `*miner*.json` files in lexical order, with the `*asic-summary*`
  and `*chain-summary*` files beside them.
- It scrubs before it serves: each bus tty becomes its own mock tty (first bus
  `ttyMOCK00`, second `ttyMOCK10`, third `ttyMOCK20`) on every row prefix, board
  name and `serial_path`, and the pool becomes `stratum+tcp://pool.invalid:3333`.
- It serves `/miner` in the capture's own shape: the same boards, rows and keys.
  Nothing is split or cloned.
- A class of response missing from the directory is a gap, not something to
  invent. The mock lists the gaps when it starts and answers those paths with
  404, so the UI shows them as not reported.
- Summary frames do not yet advance in step with the `/miner` frames.

Check a capture for payout addresses, pool credentials, serials and addresses
before any of it comes near this repo (see `PUBLISHING.md`).

## Logo

Header uses the Reckless Systems mark at:

**`ui/img/reckless-systems-logo.svg`**

(SVG kept as SVG — not rasterized.) Next to it: **MUJINA** (Orbitron) + **BZM2**
(JetBrains Mono), then the 256 Foundation mark. No invented Mujina pictorial
logo. The logos are their owners' marks and are not covered by the code
licence (see `NOTICE`).

## Fonts (self-hosted latin woff2)

| File | Weight |
|------|--------|
| Ubuntu | 400, 500 |
| Orbitron | 600 |
| JetBrains Mono | 400, 500 |

**Measured total woff2 bytes: 114968** (budget ≤ 120 KB). Licences, each with the
font's own copyright notice, are under `ui/fonts/licenses/` and listed in `NOTICE`.

## Later embed (Route B2) — deferred

v1 is intentionally standalone. Design so assets can later be vendored/embedded
into `mujina-minerd` behind cargo feature `web-ui` (mount `/ui/`, same-origin
on the API port). That work stays out of this scaffold. Embedding would not
relicense anything: these files stay MIT, and the daemon keeps its own licence
(GPL-3.0-or-later).

## Layout

- `ui/` — the static app: `index.html`, `js/`, `css/`, `fonts/`, `img/`, and the
  files it reads beside it (`layout.json`, `metrics.json`, `pools.json`,
  `licenses/`)
- `dev/` — tooling, none of it needed at runtime:
  - `dev/mock-api.mjs` — mock API + static server with CSP headers, `--replay`
  - `dev/gen-scenario.mjs` — seed expander / scrub / capture inventory
  - `dev/gen-pools.mjs` — regenerates `ui/pools.json` from mempool/mining-pools
  - `dev/publish-files.mjs` — lists the files a public seed carries
  - `dev/fixtures/` — synthetic seeds only (see `PUBLISHING.md`)
  - `dev/test/` — the test suite (`node --test dev/test/*.test.mjs`)
- `docs/` — design notes (`docs/design/delegated-mode.md`)
- `AGENTS.md` — design rules for anyone changing the UI
- `PUBLISHING.md` — what may be committed here
- `README.md` — this file
- `LICENSE` — MIT
- `NOTICE` — marks and third-party files
- `.gitignore`

## License

MIT (see `LICENSE`). The names and logos, the fonts and the pool data are
covered separately (see `NOTICE`).
