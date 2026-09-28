# Publishing hygiene

This repository is public. Anything committed here is published, and stays in
the history even after a later commit removes it. Check before you commit.

## Do not commit

- NDA or vendor material: vendor documents or vendor source, or anything copied
  or quoted from them. Naming the vendor is fine; citing a vendor document or
  source file by name is not.
- Stock firmware UI content: screenshots, routes or labels.
- Real serial captures, host names, IP addresses, MAC addresses. Say "the lab
  controller", "the test unit" or "the build host" instead of a host name.
- Pool usernames, payout addresses, or stratum secrets.
- Production unit identifiers (serial numbers, PSIDs).
- Absolute paths from anyone's machine.
- A hash-rate or efficiency figure, unless its own line names the test or case
  it came from and nothing frames it as final.

## Fixtures

Fixtures under `dev/fixtures/` are **synthetic seeds only** (expanded at serve time):

- Board: one object `bzm2-ttyMOCK00-ttyMOCK10-ttyMOCK20` (buses `/dev/ttyMOCK00`, `/dev/ttyMOCK10`, `/dev/ttyMOCK20`)
- Pool: `stratum+tcp://pool.invalid:3333`
- Default density: 3 buses × 100 ASICs (`nominal-3b`); sparse `nominal-3b-sparse` for fast tests
- A synthetic figure never sits beside a real case id: tests and fixtures use a
  fictional one, such as `MJ-TEST-00`.

Replay of real captures: `node dev/mock-api.mjs --replay DIR`. Those directories
stay **outside** git (README, Replaying a capture).

## Private notes and the public seed

Some lab notes are kept only in the private predecessor repository.
`.publish-exclude` lists them (one path or glob per line), and
`node dev/publish-files.mjs` prints the files a public seed carries: every
tracked file less the excluded ones.

## The gate

`node --test dev/test/*.test.mjs` includes `dev/test/publish-tree.test.mjs`. On
the files that ship, it fails on a private-network address, an ssh target or a
home path; on a hash-rate or efficiency figure whose line names no test or case,
or calls it final; on a pointer to a note that does not ship; on a real case id
in `dev/`; on a private gap code or issue ref in a UI string; on a missing
copyright line or `NOTICE` entry; and on a README Layout that does not match the
tree. The home host names it checks for are kept in a private deny list that
never ships, so in the public tree that one check reports itself as skipped
(unmeasured). The gate checks patterns, not meaning: it does not replace
reading the diff.
