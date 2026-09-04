# Bounded runtime inventory

Package 0.3.0 adds a read-only diagnostic for legacy and checkpointed repositories.
It performs no migration, write, deletion, reservation adjustment or scheduling.
Ordinary Git operations and two-GET format-2 advertisements are unchanged.

## Embedding

```ts
import {
  R2ObjectStore,
  R2InventoryListing,
  WalRepository,
  NativeGitEngine,
} from "ntig";

// Resolve identity and namespace from authenticated host authority, never a
// caller-supplied bucket prefix. Run this inside the host's shared ownership.
const namespace = "tenant/repository";
const store = new R2ObjectStore(bucket, { prefix: namespace });
const wal = new WalRepository(store, new NativeGitEngine(), {
  prefix: "data/",
  limits: configuredWalLimits,
});
const listing = new R2InventoryListing(bucket, {
  prefix: namespace,
  pageSize: 64,
});
const report = await wal.inventory(listing, {
  limits: { maxReadBytes: 16 * 1024 * 1024 },
  signal,
});
```

`wal.inventory(listing, { limits?, signal? })` preserves the repository's prefix
and WAL limits. The lower-level export is
`boundedInventory({ get }, listing, { prefix?, walLimits?, limits?, signal? })`.
Use it with a readonly, metered GET wrapper when needed; pass the same prefix
and WAL limits as the actual repository. Neither API needs a Git engine for
inventory. Avoid wrapping it in a read cache: this diagnostic should observe
the actual backend under ownership, rather than reuse request snapshots.

The independent `InventoryListing.list(prefix, cursor)` contract returns
`{ keys: [{ key, size }], cursor: string | null }`; null means complete.
`R2InventoryListing` accepts only the R2 `list` capability. It prepends its
outer namespace and returns relative keys, matching `R2ObjectStore`. Its
page size is 1–1,000 (default 1,000), full R2 key limit defaults to 1,024
UTF-8 bytes, and opaque cursor limit defaults to 8,192 UTF-8 bytes. It rejects
malformed/truncated pages without a cursor, surplus terminal cursors,
duplicate page entries, unsafe sizes and out-of-namespace keys. Inventory
also detects duplicate keys and cursor cycles across pages.

## What is checked

Inventory captures the root **before listing**, completes a bounded listing,
then validates the retention set rooted there. The final storage read compares
the root's bytes and opaque version again. It returns no partial report on a
limit, integrity error, changed root, cancellation or provider error.

- Empty storage reports `format: null`, sequence zero and a null root; a
  missing root with listed objects fails closed.
- Format 1 validates the complete bounded record chain, sequence, IDs,
  request digests, expected-old ref updates and referenced pack hashes.
  Its configured legacy history cap still applies; inventory does not migrate.
- Format 2 validates the current manifest and pack hashes, every reachable
  receipt-index node, every indexed record's hash/request digest/ID, complete
  unique sequences and parent chain. Replaying all retained updates must
  respect expected-old refs and reproduce the manifest's refs. Every retained
  record's pack must belong to the manifest. All indexed retry receipts remain
  in the live retention set, including receipts for deleted refs.
- Listed sizes must match the bytes read for every retained object. Recognized
  object names are exact `root.json` or `<kind>/<64 lowercase hex>` paths;
  nested or other names are classified as unknown, not reclaimable metadata.

The report has `validation: "metadata-and-pack-hashes"`, `authority: false`
and `gcCandidate: false`. `root` contains `{ version, bytes, sha256 }` or null.
`listed`, `live`, `unreferenced`, and `unknown` each contain `{ keys, bytes,
byKind }`, where every kind (`root`, `packs`, `records`, `manifests`,
`receipt-index`, `unknown`) has key and byte totals, including zeroes.
`listed.pages` counts list calls. `observed` contains GET count and cumulative
returned payload bytes, including repeated root/manifest reads. Totals partition:
`listed = live + unreferenced + unknown`, in both keys and bytes.

“Live” means the current **storage-format retention set**, not current Git
ref reachability. Pack hashes are checked without Git decoding or graph
validation. Unreferenced payloads are not downloaded; their sizes come from
listing. Provider omissions of an unreferenced object cannot be detected
without independent evidence. This is not a full Git integrity scrub.

## Bounds and cancellation

Inventory limits are copied before I/O; each override must be a nonnegative
safe integer. Invalid configuration raises `IntegrityError`; exhausted work
budgets raise `LimitError`. Malformed provider data fails closed. R2 adapter
constructor settings have separate positive bounds and are also captured.

| Inventory limit  |                            Default |
| ---------------- | ---------------------------------: |
| `maxGets`        |                             10,000 |
| `maxReadBytes`   | 64 MiB cumulative returned payload |
| `maxObjectBytes` |                              4 MiB |
| `maxListedKeys`  |                             10,000 |
| `maxPages`       |                                100 |
| `maxIndexNodes`  |                             10,000 |
| `maxReceipts`    |                             10,000 |
| `maxKeyBytes`    |                  1,024 UTF-8 bytes |
| `maxCursorBytes` |                  8,192 UTF-8 bytes |

Existing WAL metadata/ref/pack limits still apply in addition to these bounds.
For example, increasing the inventory receipt budget alone does not increase
a legacy repository's configured history cap. The host may select stricter
budgets; bindws is starting with a 16 MiB cumulative read cap. A diagnostic
may legitimately refuse a repository that normal bounded Git operations can
serve. Do not automatically increase limits or retry failed scans indefinitely.

`AbortSignal` is cooperative: checked before and after awaited GET/list calls
and during traversal. An already-aborted signal causes no provider call.
Cancellation **waits for pending provider I/O** to settle before rejecting;
it does not cancel that provider operation or promise a hard deadline.
Never release host ownership through an outer timeout race while underlying
reads continue. Meter actual calls (including failures/aborts) at the host
boundary; no successful report is returned on failure.

GET and page limits are checked before initiating the next provider call.
Payload/page checks happen after the provider has allocated and returned
them. Cumulative returned bytes are **not** a peak-memory bound: copies,
parsed historical records, maps, strings, hashing and the embedding runtime
also use memory. There is no production CPU or heap guarantee from these tests.

## Ownership and the collection gate

The host authenticates, resolves one repository, admits bounded work and
holds the same owner across Git readers/writers, Nostr authority changes,
promotion, management, alarms and teardown. Reentrancy must track an active
lease and all nested holders; an async context token alone is not authority.
Prevent detached work from outliving ownership. Manual authenticated inventory
is useful now; automatic maintenance scheduling and awake-hour billing policy
remain host decisions, not new ntig defaults.

A stable root is not proof that an old reader or pending publisher has stopped
using unreferenced objects. Matching opaque versions also cannot exclude an
out-of-band change-and-restore. The executable [coordination counterexamples](INVENTORY-COORDINATION.md)
remain applicable even with a successful report. Live-instance host admission
does not establish cross-instance/deployment/restart safety or resolve
ambiguous writes and storage reservations.

There is no collector or deletion list. Before collection: prove every
reader/publisher and external maintenance path participates in ownership,
define recoverable crash/ambiguous-outcome handling and accounting, and
preserve indefinite retry retention. Age-based pruning and process-local
locks from other Git systems are references, not that proof.

## Validation

Tests cover v1/v2, custom limits/prefixes, exact byte/key partitions, malformed
pagination, all budgets, root changes, corrupt receipts/indexes and cooperative
cancellation. The real workerd/R2 harness inventories format 1, migrated
format 2 and restarted format 2, asserting unchanged root bytes/ETag and zero
PUT attempts. Native Git interoperability and two-GET advertisements continue
in that same fixture. Fresh installed-package checks exercise exports,
declarations, both formats and cancellation; see [release validation](VALIDATION.md).
