# Delegated mode: design

*Delegated mode: a node app on Umbrel or StartOS runs one UI for one or more units, paired by a scoped code; each unit keeps its miner, a minimal API and all of its safety*

**Design for issue #91 (epic-level concept).** It is kept here because this repo is the UX home. Issue references here (`#NN`, and the `Blockscale-Solutions/...` repositories) point at a private predecessor's trackers; see the README. It has three parts, to be split into their own issues once the decisions below are answered:
- **Part A, the node app and its UX:** this repo.
- **Part B, the unit's OS side:** Blockscale-Solutions/rdsmujina-env.
- **Part C, Mujina's side:** Blockscale-Solutions/mujina-bzm2-dev.

**Concept (Ronald, 2026-09-28, paraphrased).** The unit is short of processing, RAM and storage, and it already has a "quiet" way to run. A delegated mode would be quieter still: the bare minimum of options and no chrome. The unit generates a key that carries its credentials and IP. The UX is packaged as Start9 and Umbrel apps, so the owner's Bitcoin node runs it for one or more miners. From there the owner can mine to the node (a local stratum server in lottery mode, DATUM, or Stratum V2 to pools that support it) or to external pools as usual, with the pool splits that already have issues.

**Sources:** the URLs, file:line references and issue numbers below are the primary sources. Nothing was cloned.

## Goal

A unit in **delegated mode** runs only what it must run itself: the miner, its control loops, every safety layer and a small authenticated API. It serves no browser UI, keeps no charts and has no chrome.

The UI moves to an app on the owner's Bitcoin node, packaged for Umbrel and StartOS. That app:
- pairs with each unit once, by a code the unit issues;
- shows one or more units in one UI;
- points each unit at a mining target: a pool hosted on the node (solo, DATUM, or Stratum V2 through a translator), or an external pool, with the splits already filed.

**The one rule that outranks the rest: the node is never in the safety loop.** Every protection keeps working, unchanged, when the node is off, updating or unreachable.

## Current state (measured, 2026-09-28)

**The unit** (the full table is in rdsmujina-env `docs/DESIGN.md:112-116` and mujina-bzm2-dev `docs/rds/control-board-budget.md`):
- 2x Cortex-A9, 1 GiB RAM, no swap, no RTC.
- NAND: 3951 UBI LEBs of 126,976 B. Our root slot `a_root` is 86 LEB, 10,919,936 B (`DESIGN.md:423`).
- The binding limits are NAND space and wear, no swap (pressure is an OOM kill), and timing: a logging write once blocked a power-on (`control-board-budget.md:44-52`). RAM is not binding.
- The budget doc's headline, "860 MB free and a fifth of one core" (`control-board-budget.md:67-71`), was measured on the vendor daemon powering one board. **Mujina's own figure is different.** In MJ-HASH-07, run `20260925T014028Z`, over a 2,216 s hold on three chains with wire recording on:
  - `mujina.cpu_ticks` rose from 2,372 to 251,882. That is about 1.13 CPU-seconds per second, or more than half of the two cores (DERIVED; assumes USER_HZ = 100, the ARM Linux value).
  - `mujina.rss_kb` stayed between 21,144 and 22,232 kB.
  - `host.mem_avail_kb` never fell below 735,412 kB.
  - No browser UI was polling. So CPU, not RAM or flash, is where a UI's load on the unit would show. How much one polling tab costs is **UNMEASURED** (see Part B3).

**The Device UI** (this repo, measured on 2026-09-28):
- It is single-unit by construction. The store holds one `miner` (`state` in `ui/js/store.js`), and Blockscale-Solutions/mujina-bzm2-dev#124 lists "A multi-unit fleet view" in its "Out of scope" section.
- `ui/` is 252,768 B in 34 files: code (HTML, CSS, JS, SVG) 130,601 B, woff2 fonts 114,968 B, JSON 553 B, licence text 6,646 B. As `git archive ... ui | xz -9e` it is 153,460 B.
- On 2026-09-25 it was 245,629 B. The code grew by 7,139 B in three days.
  - Blockscale-Solutions/mujina-bzm2-dev#124's size gate (code ≤ 100 KB, fonts ≤ 120 KB, total ≤ 230 KB) has no test yet: `dev/test/` checks only network bytes and request rates.
  - So the code is over its line and nothing fails. That drift is a measurement of the missing gate.
- Each open tab polls `/miner` on its own:
  - the body is 161 KB at uptime 0 and about 230 KB after a while mining (README, Fixtures);
  - its interval is about 2.33 s under the 100 KiB/s cap, and headless Chromium measured 94.3 KiB/s for the worst 60 s window (README, **Poll budget**).
  - "Two open tabs double the load" (Blockscale-Solutions/mujina-bzm2-dev#124, polling rules).
- How the UI reaches the unit is not yet one fact. Blockscale-Solutions/mujina-bzm2-dev#124 recommends embedding it in the Mujina binary behind a `web-ui` cargo feature (Route B, target ≤ 250 KB binary growth, UNMEASURED). This repo's README defers that embed (README, Later embed). Blockscale-Solutions/rdsmujina-env#40 plans it as a separate `rds-device-ui` rootfs package. Delegated mode has to remove it from whichever route wins.

**Mujina's API** (mujina-bzm2-dev at 2ba1e70, `mujina-miner/src/`):
- It binds `127.0.0.1:7785` unless `MUJINA_API_LISTEN` says otherwise (`daemon.rs:315-323`), with no authentication (`api/mod.rs:1-5`).
- The routes are health, miner (GET and PATCH for pause), boards, fans, sources (GET only), the two BZM2 summaries and seven diagnostic POSTs (`api/v0.rs:29-46`).
- **There is no write path for pools.** Pools come from `MUJINA_POOL_URL/USER/PASS` only (Blockscale-Solutions/mujina-bzm2-dev#150).
- The authenticated API (HTTPS by default, a per-unit certificate, revocable bearer tokens, read-only/operator/admin roles) is **specified, not built** (Blockscale-Solutions/mujina-bzm2-dev#195).

**Mining protocols:**
- Mujina speaks Stratum V1 only, with version rolling through `mining.configure` (`stratum_v1/client.rs:209-261`).
- `job_source/` has no V2 or DATUM source. Blockscale-Solutions/mujina-bzm2-dev#160 lists SV2 as a non-goal.

**On the node stores** (Umbrel `getumbrel/umbrel-apps` at d06a1f6; StartOS v0.4.0.1 with SDK v2.0.9):
- No app pairs with a miner. The fleet apps reach miners by an IP the user types, using the firmware's own API:
  - Bitaxe Sentry and MinerSentinel on Umbrel;
  - AxeOS Monitor and Blisspoint on StartOS.
- The Bitaxe firmware's API has no credential at all. It admits private-range peers (bitaxeorg/ESP-Miner at e9645da, `main/http_server/http_server.c:345-400`).
- No app exists for Mujina.
- asic-rs, the library Blisspoint uses, has no Mujina backend: none at our pin 9ae9371, and none upstream at 90184d3 (2026-09-24).

**"Quiet mode" is not defined anywhere in the three repositories.** "Quiet mode", "low noise", "home mode" and "acoustic" have no hits in their issues, PRs, comments or trees, and every "quiet", "noise" or "silent" is the ordinary word, never a mode.

The only occurrence is the concept above. The named modes that do exist are Mode 1 (Blockscale-Solutions/mujina-bzm2-dev#11), Mode 2 (Blockscale-Solutions/mujina-bzm2-dev#12), Mode 3 HashBed (Blockscale-Solutions/mujina-bzm2-dev#10), room thermostat (Blockscale-Solutions/mujina-bzm2-dev#161, #70) and hybrid (Blockscale-Solutions/mujina-bzm2-dev#51, vendor daemon on two boards and Mujina on the third). None of them is a quiet mode. Decision 1 asks.

## Proposal

### 1. What "delegated" means on the unit

"Quieter" is defined here by what the unit serves and by what it is asked to do, so it can be measured: request counts, bytes and Mujina's CPU ticks, on the unit.

| stays on the unit | goes to the node |
|---|---|
| Mujina: mining, tuning, the thermal and power control loops, fans (mujina-bzm2-dev scope) | The browser UI: HTML, CSS, JS, fonts and icons (this repo's `ui/`) |
| Every safety layer (section 2) | Charts and their history |
| The pool configuration, on the unit's own disk (Blockscale-Solutions/mujina-bzm2-dev#150, Blockscale-Solutions/mujina-bzm2-dev#193) | The multi-unit view, and all chrome |
| A minimal API over HTTPS with the Blockscale-Solutions/mujina-bzm2-dev#195 tokens and roles: the telemetry GETs, and only the writes the node needs (pools, pause/resume, power target) | Per-tab polling. The node polls each unit once, whatever the number of browsers |
| Fault, audit and pool-change events, fsynced on the unit (Blockscale-Solutions/mujina-bzm2-dev#194, Blockscale-Solutions/mujina-bzm2-dev#195, Blockscale-Solutions/mujina-bzm2-dev#197) | Bulk telemetry history: the 1 Hz samples and their per-minute aggregates (Blockscale-Solutions/mujina-bzm2-dev#194), kept in SQLite with a Postgres-compatible schema, tiered by age (Decision 6, decided by Ronald 2026-09-28, #91) |
| The per-unit key and certificate (Blockscale-Solutions/mujina-bzm2-dev#195) | Pairing records, the node's tokens and the unit list |

The seven raw chain diagnostic POSTs are already admin-only and off in production builds (Blockscale-Solutions/mujina-bzm2-dev#195, decision 4). Delegated mode changes nothing there.

**What removing the UI saves, from measured figures only.** Each figure comes from Current state, and each row says where it is not measured.

| resource | what delegated mode removes | saving |
|---|---|---|
| Root-slot flash | the UI assets | The compressed `ui/`, about 1.4% of the root slot (DERIVED from the two figures in Current state). The squashfs figure inside our image is **UNMEASURED**. DESIGN.md's 210,545 B was taken at an earlier commit by a method it does not record, so the two are not comparable. |
| Binary size | the `web-ui` embed, if Blockscale-Solutions/mujina-bzm2-dev#124's Route B wins | **UNMEASURED** (Blockscale-Solutions/mujina-bzm2-dev#124 targets ≤ 250 KB growth). |
| RAM | asset pages, and a response buffer per tab | **UNMEASURED**. RAM is not binding (Current state). |
| CPU | serializing the `/miner` body for every open tab, at each tab's interval (Current state) | **UNMEASURED**, and the most likely place for a real saving, because Mujina alone already uses more than half of the two cores (Current state). The measurement is Part B3. Blockscale-Solutions/mujina-bzm2-dev#124 names a cruder form of it: daemon CPU with a tab open and closed, left to Ronald on a live run. |
| NAND writes | the Blockscale-Solutions/mujina-bzm2-dev#194 1 Hz aggregates, if moved to the node | **UNMEASURED**: Blockscale-Solutions/mujina-bzm2-dev#194 is not built. |

**What the numbers say** (imperative 4). Removing the UI saves little flash and an unknown amount of CPU. It is not a case for delegated mode on bytes alone. The case rests on four things:
- one poller per unit instead of one per tab;
- records kept off the unit's NAND;
- one UI for several units;
- mining to the node.

If Part B3 finds that one tab's polling is a small fraction of a core, "quieter" is mostly about NAND and polling discipline, not the UI's weight. The issue should say so rather than promise a saving it has not measured.

**The unit enforces its own budget.** Today the byte and request caps (`maxReqPerSec` and `maxKBps` in `ui/js/config.js`) are promises a well-behaved tab makes. A node app is software we do not control once it is packaged, and it can have bugs. In delegated mode the unit should enforce a per-token budget itself: over the budget, a 429 response and a counted event. The cap then moves from the client's good behaviour to a gate the unit keeps (imperative 5: make divergence a failure, not a discovery).

### 2. Safety never leaves the unit

Every layer runs on the unit. None of them reads from the node or waits for it.

| layer | where it is defined | does it depend on the node or the network? |
|---|---|---|
| Board-controller shed when the heartbeat stops | Blockscale-Solutions/mujina-bzm2-dev#29. Measured at 74 to 80 s after Mujina stops, and once about 16 min (Blockscale-Solutions/rdsmujina-env#73). Nothing relies on it (`DESIGN.md` §6.4). | no |
| Thermal interlock: no dispatch the unit cannot thermally protect | Blockscale-Solutions/mujina-bzm2-dev#70, Blockscale-Solutions/mujina-bzm2-dev#119 (closed), Blockscale-Solutions/mujina-bzm2-dev#141 | no |
| Fan failsafe: full duty on every channel when the PWM holder exits | Blockscale-Solutions/rdsmujina-env#31, Blockscale-Solutions/rdsmujina-env#50; `DESIGN.md` §6.4 | no |
| Fan-loss derate, shutdown and guarded resume | Blockscale-Solutions/mujina-bzm2-dev#169, Blockscale-Solutions/mujina-bzm2-dev#175 | no |
| Unit-side watcher: runs the stop ladder when Mujina dies or stalls | Blockscale-Solutions/mujina-bzm2-dev#152 | no |
| Stop ladder and killswitch. They work "with no network, no controller, and no miner", and the announce never gates the action. | Blockscale-Solutions/mujina-bzm2-dev#98, Blockscale-Solutions/mujina-bzm2-dev#151, Blockscale-Solutions/mujina-bzm2-dev#159 | no |
| No-work floor through a pool outage | Blockscale-Solutions/mujina-bzm2-dev#149 | no |
| Safe limits enforced below the API, whatever the role | Blockscale-Solutions/mujina-bzm2-dev#195 ("Nobody can exceed the firmware's safe limits") | no |

**Rules for the node:**
- The node may **observe**: telemetry, faults, audit and pool-change events.
- The node may **request**, through role-checked writes: pause, resume and power target. The unit's interlocks decide whether a request is safe. A request can never loosen a limit.
- **No protection may wait for the node, read from it, or change state because it disappeared.**

**A rule not to inherit silently.** The test harness's failsafe design has the unit stop itself when a controller keepalive goes stale: layers 3 and 4 "deadman each other" (mujina-bzm2-dev `docs/rds/failsafe-architecture.md:23-38`). That is right for an attended test window. In a home deployment it would make the node a safety dependency: every node reboot or app update would stop every miner. Decision 5 asks whether a production unit ever acts on the loss of its controller. The proposal is no. The unit-side watcher (Blockscale-Solutions/mujina-bzm2-dev#152) covers an unobserved unit.

**What the miner does when the node disappears depends on what the node was doing:**
- **The node was only the UI** (the unit mines to an external pool). Nothing changes on the unit. Mining, tuning and safety carry on. Telemetry history has a gap on the node for the outage. Faults and audit events stay in the unit's log (Blockscale-Solutions/mujina-bzm2-dev#194), and the node catches up on reconnect by sequence number (Blockscale-Solutions/mujina-bzm2-dev#197's sequenced change feed).
- **The node also hosted the pool** (local solo pool, DATUM gateway, or SV2 translator). Losing the node is then losing the pool, so the node is in the **work** loop even though it is not in the safety loop.
  - A clean node shutdown closes the TCP connection, and Mujina sees a disconnect.
  - A power cut or a pulled cable is a silent drop. Mujina does not detect that at the connection level today (Blockscale-Solutions/mujina-bzm2-dev#137, Blockscale-Solutions/mujina-bzm2-dev#191).
  - With a backup pool configured, Blockscale-Solutions/mujina-bzm2-dev#191's failover moves work to it, and failback returns when the node's pool is healthy again.
  - With no backup, the chain keeps hashing its last job (Blockscale-Solutions/mujina-bzm2-dev#149) until the no-work floor arms the stop ladder.
  - DATUM adds its own case: by default the gateway disconnects every miner when *its* link to the pool drops (OCEAN-xyz/datum_gateway README L273, L280). So Blockscale-Solutions/mujina-bzm2-dev#191 is a prerequisite for mining through DATUM.
- **Decision 4 asks what the unit should do** on node loss when the node hosted the pool:
  - A: fail over to a configured backup that is not on the node, and stop at the no-work floor without one;
  - B: pause at once;
  - C: A, and also refuse to save a pool list whose only pools are on the node.

  The proposal is C. Hashing blind is not an option (Blockscale-Solutions/mujina-bzm2-dev#149).

### 3. The pairing key

**Ronald's version:** the unit generates a key that carries the credentials and the IP. Either form below is shown as text and as a QR of the same URI.

**The risks of a plain password plus an IP, from first principles and from the prior art:**
- **A leak is total and lasting.** Whoever holds the string can do what the password can do, from anywhere on the LAN, until the password is changed. That includes adding or editing pool URLs: "the classic way to steal hashrate" (Blockscale-Solutions/mujina-bzm2-dev#195, decision 4). One controller cannot be revoked without cutting off every other.
- **The IP moves.** DHCP moves it, and Blockscale-Solutions/mujina-bzm2-dev#196 records that an identity bound to an address breaks when the address changes.
- **Nothing pins the unit's identity.** A node that trusts "whatever answers at this IP" can be pointed at an impostor.
- **The same mistake exists on a node store.** StartOS's own LND package publishes a connection URI carrying the full-power admin credential (Start9Labs/lnd-startos `startos/interfaces.ts` L33, L66-76 at 06b5047).

**The safer variant: a pairing code.** In our words: a one-time enrolment code that the node exchanges for its own scoped token, with the unit's key pinned.

| | Ronald's version | safer variant (S1) | S1 plus a node key (S2) |
|---|---|---|---|
| address | the IP | the IP and port, **as a hint only** | same |
| credential in the QR | the password, or a long-lived token | a **one-time enrolment secret**, 128 bits or more, that expires in minutes | same |
| what the node keeps | the same credential | a **per-controller bearer token** minted at first use. It never appears in the QR. The unit stores only its hash (Blockscale-Solutions/mujina-bzm2-dev#195's token rules). | the node's **own key pair**. The unit keeps only the public key (mTLS client certificate, Blockscale-Solutions/mujina-bzm2-dev#195 add-ons) |
| scope | whatever the password's role allows | a named scope (Decision 3) | same |
| unit identity | none | the **hash of the unit's public key** (SPKI). A new node accepts the unit at any address only if the key matches. | same |
| expiry and one-time use | none | the code: single use, minutes. The token: Blockscale-Solutions/mujina-bzm2-dev#195's expiry rules, or long-lived and revocable (Decision 7) | same |
| revocation | change the password, which cuts off everyone | per controller: an admin lists controllers and revokes one. Revoking a code also revokes every token minted from it. A password change revokes all (Blockscale-Solutions/mujina-bzm2-dev#195). | same, and the public key can be deleted |
| a leaked unused QR gives | full control | one enrolment, until it expires. The unit shows every enrolment in its controller list and audit log. | same |
| a leaked used QR gives | full control | nothing | nothing |
| a leaked node token gives | not applicable | its scope, until it is revoked | nothing without the node's private key |

**Why the pin is on the key, not the certificate.** Blockscale-Solutions/mujina-bzm2-dev#195 re-issues the certificate **with the same key** whenever the address or hostname changes, and shows the new `tls.cert_sha256`. A node that pinned the certificate would lose each unit at every DHCP change. A hash of the public key survives a re-issue and changes only with a new key: a factory reset, an admin certificate upload, or a revert. So Part C asks Blockscale-Solutions/mujina-bzm2-dev#195 for a `tls.spki_sha256` next to `tls.cert_sha256`. An uploaded certificate or a revert changes the key, so the node must re-pair. The unit announces the change in its audit log before it switches.

**Where the code is shown.** The unit in delegated mode has no page to show a QR on. Whether the control board has a user button or LED usable to prove physical presence is **UNKNOWN**. The candidates, for Decision 7:
- **(a) Before switching.** An admin mints the code in the full Device UI (the #87 settings screen: masked, copyable, with a QR), then switches the unit to delegated mode.
- **(b) The CLI over SSH.** It prints the text and a terminal QR. This is also the way back in when the node is gone.
- **(c) The node asks.** The user types the unit's IP and admin password into the node app once. The app exchanges them for a scoped token and never stores the password, and the user compares the key fingerprint with one printed by (a) or (b). This follows BTCPay's authorize flow (btcpayserver-doc `docs/Development/ecommerce-integration-guide.md` L42-92).

**The way back must not depend on the node.** If the node dies for good, the owner still reaches the unit through the CLI, through a second node, or by switching the local UI back on. Decision 8 covers whether the local UI can come back without reflashing.

**Prior art for each property** (our words):
- scoped: LND macaroons, BTCPay permission strings;
- revocable per client: macaroons, NIP-47 per-connection keys;
- one-time and expiring: Tailscale one-off auth keys. Their gap, "Revoking a key does not deauthorize nodes using the key", is the one to avoid;
- identity pinned: lndconnect carries the certificate, and Stratum V2 pins the pool's authority key;
- asymmetric: BTCPay's legacy pairing.

**The scope collides with Blockscale-Solutions/mujina-bzm2-dev#195.** Blockscale-Solutions/mujina-bzm2-dev#195's accepted role table makes adding or editing pool URLs and credentials **admin-only**. Pointing a unit at a pool on the node is exactly that, and it is delegated mode's main job. Decision 3:
- **(a) The key grants admin.** Simple, but a leak also reaches users, TLS and firmware.
- **(b) A new scope between operator and admin** for pool configuration only: pool URLs and credentials, not users, TLS, firmware or diagnostics. Blockscale-Solutions/mujina-bzm2-dev#197's audit and read-only broadcast make every change visible.
- **(c) An operator-scope key.** The node's pool URLs are added once by an admin step in the node app, with the password typed and not stored. After that the node can only switch among pools already configured.

The proposal is (b), with (c) as the fallback if (b) widens Blockscale-Solutions/mujina-bzm2-dev#195 too far.

### 4. Packaging for Umbrel and StartOS

Sources:
- Umbrel: getumbrel/umbrel-apps at d06a1f6. Its packaging rules now live in `.claude/skills/umbrel-package-app/SKILL.md` (https://github.com/getumbrel/umbrel-apps/tree/master/.claude/skills), and the line numbers below are in that file.
- StartOS: the 0.4 packaging book (https://docs.start9.com/packaging/0.4.0.x/) and Start9Labs/start-technologies `projects/start-sdk/docs/src/publishing.md`. StartOS v0.4.0.1 was released 2026-07-27, and SDK v2.0.9 on 2026-07-25.

| requirement | Umbrel | StartOS |
|---|---|---|
| CPU architectures | `linux/amd64` and `linux/arm64`, prebuilt and public, pinned by multi-arch digest, no `build:` (L229-237) | `x86_64`, `aarch64` or `riscv64` per image. There is no armv7. |
| package | `umbrel-app.yml` plus `docker-compose.yml` (L33-115) | a signed `.s9pk`: TypeScript against `@start9labs/start-sdk`, with manifest, interfaces, dependencies and actions |
| web UI | behind the `app_proxy` service and Umbrel's login. `PROXY_AUTH_WHITELIST` opens narrow paths for clients without the cookie (L168-185) | an HTTP interface with TLS terminated by the OS, and an optional auth gate. LAN addresses are on by default. Tor is opt-in per interface. |
| a stratum port for units on the LAN | a raw `ports:` mapping, allowed for non-HTTP protocols (L220-221) | declared with `secure: { ssl: false }`, or it is not published on the LAN |
| reaching units on the LAN | plain outbound TCP from the bridge network. Bitaxe Sentry and MinerSentinel do this. Host networking only "when required for LAN discovery", with a justification (L225) | plain outbound TCP ("Outbound connections work by default"). AxeOS Monitor and Blisspoint do this. Queries to LAN DNS resolvers are dropped. **Whether `.local` names resolve is UNKNOWN.** |
| Bitcoin dependency | `dependencies: bitcoin` gives the RPC address, user, password and ZMQ port as environment variables | `dependencies.ts` can raise a task on Bitcoin (for example "enable ZMQ" or "set blocknotify") for the user to run |
| secrets at rest | `${APP_DATA_DIR}/data` bind mounts. `derive_entropy` is "not for wallet keys or external tokens" (L271), so our node key and tokens are generated and stored, not derived | the package's volumes; actions can return secrets "masked + copyable" or as a QR |
| resource limits | none imposed by the store (not stated in the four skill documents) | an optional `hardwareRequirements.ram` floor |
| submission | a PR to getumbrel/umbrel-apps, reviewed, or a community app store (a GitHub repo from Umbrel's template, added by URL, no review) | email to Start9, who fork the repo into Start9-Community and review it there; or sideload, or run our own registry |

**Consequences for the app:**
- **None of our armv7 build carries over.** The node app is its own arm64 and amd64 image.
- The Device UI's code is plain static ES modules with no build step (`ui/index.html` loads `./js/app.js` as a module), MIT-licensed with OFL and Ubuntu Font Licence fonts (`DESIGN.md:564`). It can be served by the node app as it is.
- **The node app proxies each unit on the server side.** The browser never calls a unit. That gives:
  - one poller per unit, whatever the number of tabs;
  - the token and the pinned key stay on the node;
  - no cross-origin exposure of the unit's API.

  Blisspoint is built the same way (UI, then a local server, then a proxy to the miner), and Umbrel fetches widgets on the server side (L151-162).
- **Finding units.** v1 uses the address hint in the pairing code, and the user can type a new IP. On a mismatch, a node may scan the /24 as Blisspoint does, and accepts only a matching key. Discovery by mDNS needs host networking on Umbrel and is UNKNOWN on StartOS. It is also not verified on our image (Blockscale-Solutions/mujina-bzm2-dev#195). It comes later, if at all.
- **The offline rule carries over** (Blockscale-Solutions/mujina-bzm2-dev#124 hard rule 5, "Offline on the LAN"): no CDN, no external fonts or scripts, no telemetry. The static scan of Blockscale-Solutions/mujina-bzm2-dev#124 item 16 runs on the node app's assets too.
- **The store rules are a review aim, not a lint gate.** Review can accept an app that departs from a written rule: for example, getumbrel/umbrel-apps#5721 was merged with a privileged, host-networked Docker-in-Docker sidecar, which the skill's L17 and L226-227 advise against. We follow the rules as written anyway.

### 5. One UX for one or more units

What stays: the single-unit dashboard, unchanged, as the drill-down for one unit. That includes its safety strip, freshness rules, byte cap and "measured only" rules (AGENTS.md, Design philosophy).

What is new:
- **A unit list** as the home view. Each unit is named by the owner's label and identified by its pinned key, never by its IP. Each row shows:
  - its own safety headline;
  - its own freshness (live, stale or lost), from its own receipts, under the existing rules (#4, #8, #14);
  - hashrate, power and the active pool;
  - its time since the last reply.
- **The worst state leads.** The list's own headline is the worst unit's state. A lost unit is a state of its own, never "OK", and a fault on any unit is never outranked (the #52 and #62 rules, applied across units).
- **Aggregates are measured only, computed from the rows, and show their coverage:**
  - A total such as fleet hashrate or power is the sum of the units whose value is live and measured. It is labelled with its coverage, e.g. "2 of 3 units measured".
  - A stale or lost unit's last value is never carried into a total.
  - When no unit is measured, no total prints: "not measured", never 0.
  - Nothing is apportioned. A pool-side figure for the whole node (for example the local pool's hashrate) is never split across units. It is shown as the pool's own measurement, next to the per-unit sums.
  - Nothing is typed. Every total comes from the rows above it, in code (imperative 5).
- **Clocks.** The unit has no RTC (`DESIGN.md:112`). The node shows ages from the unit's monotonic clock, with display times from its own receipt clock (the Blockscale-Solutions/mujina-bzm2-dev#191 and #63 convention). It never trusts the unit's wall time for ordering.
- **Budget.** The same two caps now bind the node's poller for each unit, and the unit enforces them (section 1). Traffic between the browser and the node is the node's concern and is not capped by the unit.
- **Pool and target choice** (section 6) is a node-level screen: which targets exist on this node, and which units point where. Changes go through the scoped write (Decision 3) and show up in Blockscale-Solutions/mujina-bzm2-dev#197's feed.

### 6. Mining targets from the node

| target | what the node needs | what the unit needs | Mujina today | notes |
|---|---|---|---|---|
| **Local solo pool.** On the stores today: Public Pool (Umbrel port 2018; StartOS 3333 plain, 4333 TLS), Go Brrr Pool (Umbrel 21420, and 21422 for high difficulty), Kamado Pool (StartOS community) | Bitcoin RPC, plus ZMQ block notifications (StartOS raises "enable ZMQ" on Bitcoin) | Stratum V1 with version rolling; the username is the payout address | **Speaks it** (`stratum_v1/client.rs:209-261`). Pointing it there needs a pool write path (Blockscale-Solutions/mujina-bzm2-dev#193 with Blockscale-Solutions/mujina-bzm2-dev#195), because today the pool comes from environment variables only (Blockscale-Solutions/mujina-bzm2-dev#150). **UNMEASURED** on the unit. | "Lottery mode" in Ronald's words is solo mining here. The node app depends on one of these apps and does not host a pool itself. |
| **DATUM gateway** (OCEAN-xyz/datum_gateway v0.4.1beta, MIT; on both stores, port 23334) | RPC with `getblocktemplate`, a block notification (`blocknotify`, or the gateway's `NOTIFY` endpoint across containers), and block space reserved for the pool's payout (README L62-75) | Stratum V1 with version rolling (README L13); the username is a Bitcoin address, 191 characters at most | **Speaks it.** **UNMEASURED** on the unit. | The link from the gateway to the pool is an encrypted protocol whose specification "will be published elsewhere" (README L20-22): UNKNOWN. **Blockscale-Solutions/mujina-bzm2-dev#191 failover is a prerequisite**, because the gateway drops every miner when its pool link fails. |
| **Stratum V2 through a translator on the node** (StartOS `stratum-v2`, port 34255; Umbrel `sv2-ui`) | Pool mode: nothing. Solo or job-declaration modes: Bitcoin Core **31.0 or later with IPC enabled**. Core 30.0 added the IPC mining interface, and 31.0 broke its schema (Core release notes 30.0 L120-133, 31.0 L249-264). | Stratum V1 to the translator: **no change on the unit** | **Works as is** (UNMEASURED) | SRI's apps (stratum-mining/sv2-apps v0.8.0, 2026-09-17) are "alpha". SV2 pools in sv2-ui's preset list (`src/lib/pools.ts` at e9db092): Braiins Pool; the SRI community pool (with job declaration); and CKPool, Public Pool, Blitzpool, MKPool, NexusPool and PyBLØCK for solo. DEMAND is SV2-native and mined its first job-declaration block on 2026-06-26 (https://www.dmnd.work/). |
| **Stratum V2 native on the unit** | nothing | The Noise NX handshake, and the pool's authority key pinned (sv2-spec at d8bf5b8, `04-Protocol-Security.md` L183, L394-420) | **Not supported.** Blockscale-Solutions/mujina-bzm2-dev#160 lists SV2 as a non-goal. | The translator route makes this unnecessary for delegated mode. Whether the BZM2 dispatch fits an Extended Channel is INFERRED from the Blockscale-Solutions/mujina-bzm2-dev#160 survey and UNMEASURED. |
| **External pool, as today** | nothing | Stratum V1 | **Speaks it**, one pool from environment variables | Failover and failback Blockscale-Solutions/mujina-bzm2-dev#191; the weighted split Blockscale-Solutions/mujina-bzm2-dev#160 with its UI in #69 and #80; outage queueing Blockscale-Solutions/mujina-bzm2-dev#163; share accounting Blockscale-Solutions/mujina-bzm2-dev#162. |

**Splits.** The existing issues split **hashrate across pools**: Blockscale-Solutions/mujina-bzm2-dev#160 partitions jobs and Blockscale-Solutions/mujina-bzm2-dev#191 handles failover. DATUM offers a second kind that Blockscale-Solutions/mujina-bzm2-dev#160 does not mention: its "username modifiers" divide one miner's **credit between payout addresses** by the hash range of each share. All work comes from one template, so the split moves no work and loses no shares (`doc/usernames.md`, Username modifiers). Decision 9 asks which kind Ronald means.

**Where the split runs.** On the unit (Blockscale-Solutions/mujina-bzm2-dev#160) the node stays out of the work loop for external pools. A split done by a proxy on the node would put the node in the work loop for every pool. The proposal: splits stay on the unit.

## Parts, each with its failing test first

Each part becomes its own issue once the decisions are answered. Each test is written first, run, and seen to fail for the reason given.

**Part A: the node app and its UX (this repo, or a new repo; Decision 11)**

- **A1. A multi-unit store and the unit list.**
  - Test: the mock serves two units, and unit 2 stops answering.
    - The list shows unit 1 live and unit 2 lost after `lostAfterMs`.
    - The fleet hashrate equals unit 1's measured value, labelled "1 of 2 units measured".
    - With both units lost, no total prints.
    - A fault on unit 2 still leads the headline while unit 2 is stale.
  - Fails first: the store holds one `miner` (`state` in `ui/js/store.js`).
- **A2. The server-side proxy and poller.**
  - Test: two browser clients on the node app, with one mock unit. The mock's request log shows **one** poll stream within the per-unit caps, not two. The browser's network log shows no request to the unit's address.
  - Fails first: no node server exists.
- **A3. Enrolment and pinning.**
  - Test: a mock unit that presents a key different from the one the pairing code pins is refused. The mismatch is shown, and no token is stored. A mock unit that re-issues its certificate with the same key and a new address is still accepted.
  - Fails first: no enrolment code exists.
- **A4. Packages for both stores.**
  - Test, in CI:
    - `npm run lint:apps -- <id> --check-images` passes for the Umbrel package;
    - `tsc --noEmit` and the `start-cli` pack pass for StartOS;
    - both image manifests list arm64 and amd64 by digest.
  - Fails first: the packages are absent.
- **A5. The offline scan covers the node app.**
  - Test: Blockscale-Solutions/mujina-bzm2-dev#124 item 16's static scan, pointed at the node app's served assets, fails on a planted `https://` import.
  - Fails first: the scan covers only `ui/`.

**Part B: the unit's OS side (Blockscale-Solutions/rdsmujina-env)**

- **B1. The UI becomes optional in the image, or switchable at runtime (Decision 8).**
  - Test: `tests/slow/ui.test.sh` gains a delegated case. Its rootfs holds no UI index. The budget gate (Blockscale-Solutions/rdsmujina-env#21) prints both variants' headroom, and their difference equals the UI package's measured size.
  - Fails first: Blockscale-Solutions/rdsmujina-env#40's package is not built yet, and no variant exists.
- **B2. The service binds the LAN only with authentication.**
  - Test, in QEMU (Blockscale-Solutions/rdsmujina-env#48), with the Blockscale-Solutions/rdsmujina-env#73 service and a delegated config:
    - port 7785 answers only over TLS;
    - a request without a token gets 401;
    - plain HTTP gets the Blockscale-Solutions/mujina-bzm2-dev#195 redirect or nothing.
  - Fails first: no service definition exists (Blockscale-Solutions/rdsmujina-env#73).
- **B3. Measure the per-poller cost on the unit.** This is on-unit work.
  - Take the slope of Mujina's `cpu_ticks` and its RSS during a hold, with 0, 1 and 2 clients polling at the Device UI's rate, and with 1 client at the node app's rate.
  - This is the number that decides whether "quieter" saves CPU.
  - Until it exists, section 1's CPU row stays UNMEASURED.
- **B4 (later). A LAN time source and a remote log target, if the node offers them.**
  - The unit has no RTC. Blockscale-Solutions/rdsmujina-env#58 plans remote syslog, and chrony is in the rootfs (`DESIGN.md:562`).
  - Test: in QEMU, the unit takes time and ships its log to a mock node, and keeps both working when the mock disappears.

**Part C: Mujina's side (Blockscale-Solutions/mujina-bzm2-dev), all under Blockscale-Solutions/mujina-bzm2-dev#195**

- **C1. Enrolment and per-controller tokens.** Tests:
  - a code used twice gets 401 on the second use;
  - an expired code gets 401;
  - revoking controller X makes X's token fail while Y's still works;
  - revoking a code revokes the tokens minted from it;
  - a password change revokes all of them;
  - each step writes one audit event with no secret in it.

  Fails first: no enrolment endpoint exists.
- **C2. Pin the key.**
  - Test: re-issuing the certificate for a new address changes `tls.cert_sha256` and leaves the new `tls.spki_sha256` unchanged. A factory reset changes both.
  - Fails first: there is no SPKI field.
- **C3. The scope from Decision 3.**
  - Test: Blockscale-Solutions/mujina-bzm2-dev#195's role-map test gains the new scope. A pool-config token gets 200 on a pool write and 403 on users, TLS, firmware and diagnostics.
  - Fails first: the scope does not exist.
- **C4. A per-token request budget.**
  - Test: a token over the request cap (`maxReqPerSec` over 10 s, the same value as the UI's) gets 429, and the event is counted. Other tokens are unaffected.
  - Fails first: the API has no budget.
- **C5. Losing a pool hosted on the node.**
  - Test, with mock pools in the Blockscale-Solutions/mujina-bzm2-dev#191 and Blockscale-Solutions/mujina-bzm2-dev#149 harness:
    - the primary pool "on the node" goes silent, and work moves to the backup within the Blockscale-Solutions/mujina-bzm2-dev#191 bound;
    - with no backup, the no-work floor arms at its budget;
    - in both cases, no safety layer changes state.
  - Fails first: there is no failover (Blockscale-Solutions/mujina-bzm2-dev#191) and no floor (Blockscale-Solutions/mujina-bzm2-dev#149).
- **C6. With Decision 4 (C): no pool list made only of pools on the node.**
  - Test: saving a pool list whose every pool is flagged as on the node is refused, with a field-level error.
  - Fails first: there is no flag and no check.

**Order.** Blockscale-Solutions/mujina-bzm2-dev#150, Blockscale-Solutions/mujina-bzm2-dev#193 and Blockscale-Solutions/mujina-bzm2-dev#195 come first: without a pool write path and authentication there is nothing to delegate. Then C1 and C2 with A3, then A1 and A2, then B1 to B3. Blockscale-Solutions/mujina-bzm2-dev#191 must land before DATUM is offered as a target.

## Decisions

The open decisions, and Ronald's answers, are kept in one place: issue #91.

## Prior art (our words)

- **FutureBit Apollo OS** (`jstefanop/apolloapi-v2` 2.1.2 and v2.1.3; https://www.futurebit.io/apollo-iii):
  - It puts a miner, a full node and a solo stratum server behind one browser UI on one board.
  - Its Apollo III "standard" model is a miner-only unit with a quad-core A53 and 1 GB, next to a separate full-node controller. That is the closest analogue to our budget. How that unit is managed is not described (UNKNOWN).
  - Its licence (CC BY-NC-ND) allows study only.
- **Braiins OS** (https://academy.braiins.com/braiins-os/whats-new, by release):
  - a cloud service for managing and monitoring miners (21.04);
  - a miner that keeps running on a bad configuration only when that service is attached, so it can be fixed remotely, and powers off otherwise (21.06). **This is a safety behaviour that depends on a remote controller, the pattern section 2 rules out;**
  - management traffic relayed over the pool connection during failover (20.10);
  - the legacy miner API read-only by default (26.05);
  - a Stratum V2 authority key set per device (20.03).
- **Blisspoint** (heatpunk/blisspoint, MIT; StartOS community 0.6.0, and its own Umbrel community store): a node app that controls miners (power, pause, live telemetry) through asic-rs, by IP, with no pairing.
- **Pairing:** lndconnect, LND macaroons, BTCPay pairing and authorize, Tailscale auth keys, NIP-47 and the Stratum V2 authority key (section 3).

## Related, and what this does not duplicate

- **This repo:** #69, #80 (pools and splits), #87 (login UX, where the pairing code is minted), #31 (GET-only allowlist), #46 (poll budget), #76 (parity).
- **Blockscale-Solutions/mujina-bzm2-dev:**
  - Blockscale-Solutions/mujina-bzm2-dev#124: single unit; the fleet view is out of scope.
  - Blockscale-Solutions/mujina-bzm2-dev#195 and Blockscale-Solutions/mujina-bzm2-dev#196: authentication. This adds enrolment, a scope and a key pin.
  - Blockscale-Solutions/mujina-bzm2-dev#197: the pool-change feed the node reads.
  - Blockscale-Solutions/mujina-bzm2-dev#193, Blockscale-Solutions/mujina-bzm2-dev#150, Blockscale-Solutions/mujina-bzm2-dev#191, Blockscale-Solutions/mujina-bzm2-dev#160, Blockscale-Solutions/mujina-bzm2-dev#149, Blockscale-Solutions/mujina-bzm2-dev#163 and Blockscale-Solutions/mujina-bzm2-dev#194.
  - The safety issues in section 2, under Blockscale-Solutions/mujina-bzm2-dev#167 (fault tolerance) and Blockscale-Solutions/mujina-bzm2-dev#158 (vendor-free cold start).
  - The audiences: Blockscale-Solutions/mujina-bzm2-dev#90, and Blockscale-Solutions/mujina-bzm2-dev#91, where the newcomer must be unable to do harm by accident.
- **Blockscale-Solutions/rdsmujina-env:** Blockscale-Solutions/rdsmujina-env#40 (UI package), Blockscale-Solutions/rdsmujina-env#73 (service), Blockscale-Solutions/rdsmujina-env#31 and Blockscale-Solutions/rdsmujina-env#50 (fan failsafe), Blockscale-Solutions/rdsmujina-env#58 (remote logs), Blockscale-Solutions/rdsmujina-env#53 (owner key enrolment for signed updates). Firmware and OTA stay admin-only and are not in the pairing scope.
- **Not filed anywhere** (titles in all three repos and the bodies read): the pairing code, a node app, a multi-unit view, a per-token request budget, a Mujina backend for asic-rs, and any SV2 or DATUM work on the unit.

<sub>Drafted with Claude (Opus 5.5), 2026-09-28, for issue #91.</sub>
