# Validation record

Run `npm ci && npm run check` from the repository root. Run `npm audit` separately when evaluating current dependency advisories. All fixtures and R2 data are local; no Cloudflare deployment or account is used.

Verified 2026-09-04 for 0.3.0: **184 tests passed**, typecheck and self-contained Worker/library builds passed, and `npm audit` reported zero vulnerabilities. The library package additionally passes fresh Node/TypeScript consumer checks (including scoped retry, use-after-close rejection, v1/v2 inventory exports and cancellation) and same-toolchain byte-for-byte reproducibility checks. Release validation used Node 22.22.3 / npm 10.9.8. These counts describe this iteration, not an assurance about future dependency advisories or untested workloads. The prior immutable 0.2.1 release passed 152 tests.

## What is exercised

- Native Git-generated OFS/REF packs compared by exact object IDs.
- Handcrafted OFS and forward REF deltas accepted by native `git index-pack --strict` and decoded to identical data.
- Actual thin packs reconstructed from an earlier pack, also checked with native `--fix-thin`.
- Independent Node zlib fixtures, Adler forgery with recomputed outer SHA-1, declared-size mismatch, decompression bombs, truncated/damaged delta commands, invalid offsets and depth/byte limits.
- Full Git object dependencies, type mismatches, annotated tags, gitlinks, non-UTF8 messages, safe tree names/order and iterative deep history. A valid graph is checked by `git fsck`.
- Before/after failure injection at each publication write, with assertions that the injection actually occurred.
- Explicit empty/nonempty checkpoint migration, legacy byte preservation, interrupted index/manifest/root publication, concurrent migration and commit, more than 128 checkpointed transactions, retained historical receipt replay, same-ID competing writers, and missing/corrupt older receipt paths failing closed.
- Exactly two GETs for checkpointed metadata-only reads, bounded current-state loads, safe HTTP errors, and accepted-state filtering under the same fence. Hidden-PR correction retries still work after their record leaves the normal snapshot.
- Request-scoped read reuse with unchanged Git-validation counts, fresh authority/root reads, caller-buffer isolation, LRU payload/entry bounds, misses/errors uncached, conditional/lost-acknowledgement writes, in-flight read invalidation and callback cleanup. Test-only workerd HTTP pushes and reads use sessions; independent post-restart advertisements each assert exactly two underlying R2 GETs.
- Canonical bulk receipt construction matching incremental index roots, pre-write rejection of invalid/duplicate/over-budget inputs, fixed-ref versus growing-tag physical metadata inventories, and serialized host-style metadata byte/key reservations across quota failures, orphan publication and uncertain writes. Indexed identical retries remain write-free at full capacity. These fixtures do not add a runtime quota ledger or garbage collector.
- Cold restore, losing CAS writers, atomic ref changes, reused retry IDs, tenant isolation, corrupted storage, and a deterministic 200-transaction model test.
- Real local R2 conditional writes and concurrent CAS, byte/key limits and buffer ownership.
- Read-only inventory across both storage formats and custom repository limits, exact metadata key/byte partitions, malformed pagination/cursor cycles, every operation/data budget, root-body/version races and provider failures. Adversarial rehashed v2 fixtures cover receipt parent chains, expected-old history, final manifest refs and historical pack membership. Cooperative cancellation starts no post-abort I/O and awaits pending calls before returning.
- Actual workerd/R2 inventory before migration, after migration and after restart, with zero PUT attempts, identical root bytes/ETag, retained historical receipts and unchanged two-GET advertisements. Deterministic old-reader and pending-publisher counterexamples show why a stable inventory is not collection authorization.
- HTTP framing, fail-closed pre-body auth, exact routing, capability advertisements, rejected stale transactions, exact reachable fetch object sets, inaccessible dangling objects and filtered pack contents.
- Accepted-state and PR authority, pending-state old-OID and signed HEAD preservation through actual WAL commits, anonymous PR deletion denial, request capture, and mixed unauthorized transactions with no publication.
- Stock Git corrections of hidden pre-event PR tips, including observed zero-old commands; physical CAS race rejection, lost-acknowledgement recovery and receipt replay after later commits.
- HTTP and object-store byte/operation observations, safe error classification, backend-error redaction, and response-budget checks before committing a successful push.
- A bundled Worker runs inside workerd with persisted R2. Real Git pushes, clones, changes/fetches, creates annotated tags, deletes/force-updates branches, and creates multiple refs atomically. A fresh clone after workerd restart passes `git fsck`. Blobless and treeless clones perform lazy checkout successfully.
- A separate test-only Worker migrates a nonempty native-Git pack at 128 transactions, creates further refs, restarts against persisted R2, replays the original receipt, and serves a fresh stock Git clone that passes `git fsck --full`. A subsequent stock Git push publishes another pack in format 2; a second fresh clone verifies the new content and passes fsck.

## What this does not prove

This is not a full Git conformance suite, security certification, production CPU/peak-memory benchmark, or GRASP audit. Tests intentionally use small repositories. Git fsck differential tests cover their fixtures, not every malformed object native Git knows how to reject. In particular, SHA-1 collision detection and platform-specific checkout protections still need deeper review.

The result supports continuing the container-free approach within the documented bounds. It does not yet justify removing an unrestricted production Git container. Selective pack reads, safe compaction/GC, operational limits and the integrated GRASP relay audit remain explicit gates in [ROADMAP.md](ROADMAP.md). The opt-in checkpoint format changes history handling, not pack/object capacity or production-readiness.
