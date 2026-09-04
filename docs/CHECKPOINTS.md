# Checkpoint format and upgrade

ntig 0.2 adds an **explicit, one-way storage-format upgrade**, not automatic compaction. New repositories still start in format 1. `await wal.checkpoint()` upgrades one repository to format 2; subsequent commits publish a fresh bounded manifest rather than replaying every historical transaction. Calling it on a healthy format-2 repository is a no-op.

## Upgrade procedure

1. Upgrade every reader and writer for the repository to a checkpoint-aware version. Versions 0.1.x reject format 2. Keep a recoverable backup of the repository prefix before migration.
2. Invoke `checkpoint()` through trusted administration, not a public Git endpoint. The example Worker deliberately exposes no migration endpoint. Prefer a quiet maintenance window to avoid wasted work from competing writes.
3. Verify `load()`, an old `lookupRecord(id)`/identical retry, and a Git fetch/clone. Migration returns `{ sequence, changed }`.
4. If a competing commit wins, migration reports a conflict and can be retried. A storage exception may follow a successful root write: reload/retry to discover the result. Never restore an old root over subsequent writes or downgrade readers after migration.

Migration verifies the legacy snapshot and preserves the original record content addresses. It publishes the receipt index and manifest before conditionally replacing the **same** `root.json`. It neither deletes legacy objects nor creates a second mutable authority. A migration loser cannot revert another writer's root. Before the root write, interruptions leave only harmless unpublished metadata; after it, a cold reader can recover without listing the bucket.

## Format 2

```text
root.json                    mutable { format: 2, sequence, manifest }
manifests/<sha256>            immutable refs, ordered pack IDs, tip, receipt root
receipt-index/<sha256>        immutable copy-on-write radix nodes
records/<sha256>              immutable format-1 transaction/receipt records
packs/<sha256>                immutable Git packs (unchanged)
```

The manifest contains the complete current refs and pack list. The receipt index maps SHA-256(request ID) to the committed record's content address. Index nodes are canonical, bounded JSON: up to 16 entries per leaf, 16 children per branch, 4 KiB per node, and at most 64 branch levels. Lookups verify hashes, routing, record ID and request digest. Failed or incomplete lookups are errors, not permission to reuse an ID. Index nodes written by a losing commit are not part of the authoritative tree.

`Snapshot.records` now means the replayed legacy history **or only the current tip record in format 2** (empty at sequence zero). Use `lookupRecord(id)` for a committed historical receipt. The accepted-state adapter does this when reconstructing a hidden-PR correction retry. Identical content returns the original receipt after later commits; different content with the same ID conflicts. Receipts are retained without expiration, so retained metadata and orphan storage can continue to grow.

Format 2 removes the legacy `maxRecords` transaction ceiling, not the other workload limits. Global sequence is bounded by JavaScript's safe integer range. Current manifests are at most 2 MiB with at most 128 unique packs; default pack/ref/decode limits still apply. A repository can therefore perform more than 128 ref-only updates, but cannot accumulate unlimited Git data. A custom `maxRecords` remains a legacy replay limit, not a tenant quota for format 2.

## Read guarantees and cost

- `loadRefs()` uses exactly two object GETs for format 2: root and manifest. HTTP advertisements and the accepted-state adapter use this optional API. It validates metadata but does **not** establish that packs or older receipts are readable. Legacy repositories fall back to full replay.
- `load()` verifies all manifest packs and their object graph, plus the current tip record and its receipt-index path. For a nonempty repository with `p` packs and `d` nodes on that path, it uses `3 + p + d` GETs, not one GET per historical transaction.
- `lookupRecord(id)` reads root, manifest, the requested index path, and the matching record if present. It does not download Git packs. Older receipt branches are validated lazily; `load()` is not a complete historical integrity scrub.
- Pushes still load/verify all packs and publish immutable metadata before the root CAS. Fetches still download all stored packs and decode the loaded snapshot again. Cheap advertisements are **not yet selective object/pack fetching**.

Content hashes detect missing/corrupt immutable data; they do not authenticate a maliciously replaced root. Restrict bucket write access. Application authority remains the host's responsibility and must still be fenced across Nostr state changes and Git publication.

## Next safety gate

No compaction, object deletion, bucket lifecycle policy, or retry expiration is enabled by this upgrade. Safe reclamation needs a bounded complete reachability/scrub pass and a repository-wide reader/writer fence or leases covering all participating runtimes. Root CAS alone cannot protect a reader that already captured an older root; an age threshold alone cannot protect an in-flight publisher. R2 deletion has no etag precondition in the Workers binding. Until those conditions are implemented and fault-tested, retain both committed and unpublished objects.

Next: indexed/selective object reads and reachable-object repacking, followed by coordinated reclamation and recovery drills. Metering remains observational; bindws pricing and durable quota policy are separate from storage correctness.
