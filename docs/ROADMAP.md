# Completion gates and known boundaries

The project is intentionally independent of bindws. “Container-free” means the runtime must execute in workerd with no subprocess, filesystem repository, Docker image, or external Git service. Node-based tests alone do not establish that property.

## Gate 1 — durable publication

- Atomic multi-ref transactions and expected-old-OID checks.
- One successful compare-and-swap under concurrent writers.
- Failure before and after each pack/record/root write.
- Idempotent recovery after a lost acknowledgement and intervening transactions.
- Cold restore with cryptographic integrity checks, bounded replay, and no listing dependency.
- Missing or corrupt committed data fails closed; corrupt immutable objects are never overwritten.

## Gate 2 — container-free Git interoperability

- Git-generated full, OFS-delta, REF-delta, and thin packs.
- Bounded decompression before allocation, aggregate memory budgets, bounded delta depth.
- Full reachable graph validation, branch targets, tags, tree entries, and gitlinks.
- Stock Git push, clone, fetch, force update, delete, and multi-ref transactions.
- Invalid/stale transactions must never become visible through the WAL.
- Run the actual Worker against local R2 and recover after terminating/restarting its runtime.

Passing this gate establishes a bounded prototype, not broad Git feature parity or production capacity.

## Gate 3 — GRASP-facing protocol

Separate protocol conformance from storage correctness. Before claiming ngit/GRASP compatibility, add a dedicated adapter and run the upstream audit suite:

- Nostr repository announcement/state events and recursive maintainer authorization.
- Correct npub/repository URL mapping, NIP-11 discovery, acceptance policy, and browser CORS.
- Signed desired state governs pushes; ordinary bearer credentials are not a substitute.
- Announcement/state ordering, purgatory until objects arrive, and idempotent reconciliation.
- Required reachable/tip SHA wants, partial clone filters, and protocol capability tests.
- `refs/nostr/` policy and cleanup where applicable.

Marmot relay behavior and nsite publication remain separate work. A repository source link does not alone establish an exact deployed commit or build provenance.

## Gate 4 — sustained operation

Not implemented or established by the first iteration:

- Checkpoints/compaction, retention of retry receipts, safe reader leases, and orphan GC.
- Indexed object lookup and selective pack reads instead of replaying the whole bounded repository.
- Streaming large packs, multipart writes, large-repository and long-history performance.
- Production Workers CPU/peak-memory measurements under concurrency; Miniflare wall time is not a production CPU benchmark.
- Rate limits, tenant quotas, private-read authorization, operational alerting and incident recovery.
- Comprehensive adversarial corpus/fuzzing, third-party security review, and SHA-1 collision-detection parity with hardened native Git.
- SHA-256 Git repositories, Git LFS, SSH, shallow history and arbitrary Git extensions unless explicitly implemented and tested.

The initial root has constant size, but replay is linear in transaction history and stored pack volume. At the history cap, writes stop. This is an explicit checkpoint-design milestone, not a problem to work around by raising the cap indefinitely.

## Design policy

Use Narwal as a reference for invariants and behavior, not as a dependency that must dictate the implementation. Keep original code and test provenance clear. A failure to support a required workload natively should become a documented reproducible blocker. It should not silently route through an undeclared container or weaken validation.
