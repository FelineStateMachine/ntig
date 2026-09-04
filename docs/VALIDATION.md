# Validation record

Run `npm ci && npm run check` from the repository root. Run `npm audit` separately when evaluating current dependency advisories. All fixtures and R2 data are local; no Cloudflare deployment or account is used.

Verified 2026-09-04: **90 tests passed**, typecheck and self-contained Worker build passed, and `npm audit` reported zero vulnerabilities. The library package additionally passes fresh Node/TypeScript consumer checks and byte-for-byte reproducibility checks. These counts describe this iteration, not an assurance about future dependency advisories or untested workloads.

## What is exercised

- Native Git-generated OFS/REF packs compared by exact object IDs.
- Handcrafted OFS and forward REF deltas accepted by native `git index-pack --strict` and decoded to identical data.
- Actual thin packs reconstructed from an earlier pack, also checked with native `--fix-thin`.
- Independent Node zlib fixtures, Adler forgery with recomputed outer SHA-1, declared-size mismatch, decompression bombs, truncated/damaged delta commands, invalid offsets and depth/byte limits.
- Full Git object dependencies, type mismatches, annotated tags, gitlinks, non-UTF8 messages, safe tree names/order and iterative deep history. A valid graph is checked by `git fsck`.
- Before/after failure injection at each publication write, with assertions that the injection actually occurred.
- Cold restore, losing CAS writers, atomic ref changes, reused retry IDs, tenant isolation, corrupted storage, and a deterministic 200-transaction model test.
- Real local R2 conditional writes and concurrent CAS, byte/key limits and buffer ownership.
- HTTP framing, fail-closed pre-body auth, exact routing, capability advertisements, rejected stale transactions, exact reachable fetch object sets, inaccessible dangling objects and filtered pack contents.
- Accepted-state and PR authority, pending-state old-OID and signed HEAD preservation through actual WAL commits, anonymous PR deletion denial, request capture, and mixed unauthorized transactions with no publication.
- Stock Git corrections of hidden pre-event PR tips, including observed zero-old commands; physical CAS race rejection, lost-acknowledgement recovery and receipt replay after later commits.
- HTTP and object-store byte/operation observations, safe error classification, backend-error redaction, and response-budget checks before committing a successful push.
- A bundled Worker runs inside workerd with persisted R2. Real Git pushes, clones, changes/fetches, creates annotated tags, deletes/force-updates branches, and creates multiple refs atomically. A fresh clone after workerd restart passes `git fsck`. Blobless and treeless clones perform lazy checkout successfully.

## What this does not prove

This is not a full Git conformance suite, security certification, production CPU/peak-memory benchmark, or GRASP audit. Tests intentionally use small repositories. Git fsck differential tests cover their fixtures, not every malformed object native Git knows how to reject. In particular, SHA-1 collision detection and platform-specific checkout protections still need deeper review.

The result supports continuing the container-free approach within the documented bounds. It does not yet justify removing an unrestricted production Git container. Checkpointing, indexed reads, operational limits and the integrated GRASP relay audit remain explicit gates in [ROADMAP.md](ROADMAP.md).
