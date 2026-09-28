# Synthetic fixtures only

- One board object `bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20` spanning buses `ttyMOCK00/10/20` (threads `BZM2 UART 0..2`), as the driver emits it (#32)
- Pool: `stratum+tcp://pool.invalid:3333`
- **No** real hostnames, IPs, serials, or pool usernames.

## Scenarios (seed → expand at serve time)

| Scenario | Seed | Expanded density |
|---|---|---|
| `nominal-3b` (default) | `nominal-3b/seed.json` | 1 board × 3 buses × **100** ASICs, gen2 |
| `nominal-3b-sparse` | `nominal-3b-sparse/seed.json` | 3 buses × **9** populated of 100 configured (fast tests / hatched never-seen cells) |
| `fault-stub` | `fault-stub/seed.json` | sparse + `thermal_fault` on wire ids 2–4 of bus `ttyMOCK00` (thread 0) |

Expansion: `dev/gen-scenario.mjs` (keys from `api_client/types.rs` @ `3f783d9`).
Real captures: `node dev/mock-api.mjs --replay DIR`, with the directory kept outside git (top-level README, Replaying a capture).

`ui/layout.json` stays 10×10 / 100 for each bus's heatmap grid.
