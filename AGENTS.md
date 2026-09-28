# AGENTS.md

Guidance for agents (and humans) working on the Mujina BZM2 Device UI. The full specification is Blockscale-Solutions/mujina-bzm2-dev#124; where this file and the spec disagree, the spec wins until it is amended.

> **References to a private predecessor.** That specification, every bare `#NN` issue reference, and every link to `Blockscale-Solutions/mujina-bzm2-dev`, `Blockscale-Solutions/rdsmujina-env` or `Blockscale-Solutions/mujina-bzm2-device-ui` point at a private predecessor repository's trackers. They are not public, and a bare `#NN` is not an issue in this repository. The rules in this file stand on their own.

## Design philosophy

- **Engaging but not distracting.**
  - The dashboard should make the miner's state easy and pleasant to read at a glance.
  - Nothing moves, flashes or re-announces itself unless the state changed.
  - No animation on routine polls.
  - Colour carries meaning: status colours are reserved for status, and colour is never the only cue.
  - Detail lives in hover and focus (with a keyboard and screen-reader equivalent), not in extra chrome.
- **Measured only** (Ronald, 2026-09-25).
  - Every figure and every graph shows measured data.
  - No nameplate, nominal, assumed, apportioned or modelled value is ever shown or charted as if it were measured. When nothing measured is available, show "not measured" or "unknown".
  - Never show a plausible-looking number in that case, and never show 0.
  - When the operator changes frequency or voltage, there is no nameplate. They need to see the real impact of the change.
  - Use the API's provenance to decide. Don't compute derived figures (for example J/TH) in the browser.
- **Faults are always visible, in both the API and the UI, with parity.**
  - A fault is never hidden, dimmed away or outranked by a less severe message.
  - Everything the API reports as a fault has a UI element, and every fault the UI shows comes from an API field.
  - The parity test enforces this (#76; Blockscale-Solutions/mujina-bzm2-dev#173).

## Design imperatives

The rules below are Ronald's design imperatives (2026-09-25), kept word for word in each repository that carries them. Don't paraphrase them here; change every copy together.

## The five design imperatives

**1. Fail fast, fail cheap, fail often.** Prefer many small cheap failures to one large expensive
one. **Escalate cost deliberately: the narrowest thing that could fail runs first.** A 30-second
check that catches an arity error is worth more than the 60-minute suite that would have caught it
at minute 55. Put the cheapest disqualifying test in front of the expensive one — always.

**2. Build to the smallest atomic unit of failure.** One test, one log, one pass/fail with
confidence. **The unit of retention is the unit of failure.** A pass collapses to a summary; a
**failure keeps its evidence** until that evidence has been turned into a better test. Same for
data: a narrow query that fails loudly on one row beats a broad one that silently averages a
defect away.

**3. Build from first principles — then check how others solved it.** Reason from what the domain
requires, not from what is convenient to code: think like an accountant for books, an engineer for
hardware, an archivist for retention. **But do not reinvent.** A little research saves hours, and
published standards usually encode decades of hard-won edge cases. Double-entry was not invented
here either.

**4. Everything is a test; everything is signal.** There is no noise, and no data that fails to
demonstrate how some apparatus performed. An import's duplicate count measures whether two rails
agree; a parser's output measures the parser. **Read every output as evidence about the machinery
that produced it**, not merely as the answer to the question asked. A gap in a metric is a
measurement, not an embarrassment.

**5. Strive for perfect internal consistency.** A document, a database or a system must never be
able to contradict itself. **Every figure is COMPUTED from the rows it summarises** — especially
totals — never typed into prose, never restated in a second place, never carried forward by hand.

> **Two representations of one fact will diverge. The only question is when, and whether anyone
> notices before it matters.**

With a test attached:

- A total is the sum of the rows above it, in code. A total that cannot be derived is a total that
  should not print.
- **One fact, one home.** Every consumer reads the same row.
- Consistency is checked **between** artifacts, not only within one. Two internally-consistent
  documents can still contradict each other.
- **Make divergence a build failure, not a discovery.** If a class of drift has shipped once, the
  fix is a gate, not vigilance.

---

## How to apply them

- **Before building:** which imperative does this serve, and which does it strain? Imperatives 1
  and 5 most often conflict with convenience; say so out loud rather than resolving it silently.
- **When a second copy of a fact appears** — a cached total, a denormalised column, a path stored
  twice — that is imperative 5, and it *will* drift. Either derive it or delete it.
- **When something is retained:** ask whether it is a pass or a failure. Passes collapse to their
  recipe; failures keep their artifact, because a failure is the only copy of that evidence.
- **When a check is expensive:** ask what cheaper check could disqualify first.
- **When a metric looks bad:** ask what apparatus it is measuring before treating it as a defect
  to hide.
