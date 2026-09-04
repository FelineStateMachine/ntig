# Read-only inventory and coordination evidence

Scope: tests and documentation only. No runtime exports, storage format,
package version, immutable archive, production configuration, migration,
collection, or billing changes. The inventory is a source-only diagnostic
harness, not an administrator endpoint or a collector.

Validation for this analysis checkout: `npm run typecheck` and `npm test`
pass, with 172 tests and no failures or skips. The paired bindws follow-up
is [PR #19](https://github.com/FelineStateMachine/bindws/pull/19), based on
the separately approved and merged earlier stack; its agent reports 200
local tests passing. This pass does not merge or deploy that follow-up.

## What a completed inventory means

A successful inventory describes recognized objects and metadata references
observed within a finite operation. It must finish its complete listing and
mark before returning any unreferenced-object report. Exceeding a budget,
encountering invalid input or a storage error, or observing a root change
invalidates the result; no partial list becomes a deletion plan.

These are separate claims:

1. **Inventory completeness:** the listing terminated and the bounded
   metadata traversal validated the references it reports.
2. **Root stability:** the captured root bytes and version match at the end.
3. **Coordination:** no reader or publisher can require any proposed deletion
   target during collection, including work across asynchronous calls.
4. **Recovery:** an interrupted collector or publisher can recover without
   losing committed data, retry receipts or accurate storage accounting.

The first two do not establish the last two. A read-only diagnostic must
never return a deletion authorization merely because its root stayed stable.

## Source-only bounded harness

`test/helpers/bounded-inventory.ts` exposes only this test import:

```ts
const report = await boundedInventory(
  { get: (key) => store.get(key) },
  { list: (prefix, cursor) => listPage(prefix, cursor) },
  limits,
  "repos/example/",
);
```

The listing adapter returns `{ keys: [{ key, size }], cursor }`, with `null`
signaling the last page. The input has no write/delete capability. Internally,
any accidental write through a validator throws instead of reaching storage.
Successful reports set `authority: false`, `gcCandidate: false`, and
`validation: "metadata-and-pack-hashes"`. They give observed key/byte counts
for the current-format retention set, recognized unreferenced objects and
unknown keys separately. They do not return an executable deletion list.

Default limits (all explicitly overridable nonnegative safe integers):

| Bound                          |     Default |
| ------------------------------ | ----------: |
| Object GETs                    |      10,000 |
| Cumulative returned bytes read |      64 MiB |
| One returned object            |       4 MiB |
| Listed keys                    |      10,000 |
| Listing pages                  |         100 |
| Current receipt-index nodes    |      10,000 |
| Historical receipts            |      10,000 |
| Key/cursor encoded length      | 1,024 bytes |

The initial root is captured **before pagination**. The helper rejects
duplicate keys, cursor cycles, invalid sizes, out-of-prefix keys, unsafe
integer totals, and exceeded budgets. Exact relative key shapes distinguish
recognized metadata from nested or unknown names. It validates the current
manifest, pack content hashes, bounded receipt trie, every indexed record's
hash/request digest/ID, complete unique receipt sequences, and the tip's
relationship to current refs/packs. Listed sizes must match the bytes read
for every retained object. Final root bytes/version are checked after the
last metadata read; an initially absent root must still be absent at the end.
Untouched empty storage reports `format: null`, not an invented format-2 root.

The report is **not a full Git graph scrub**. It verifies pack content hashes
without decoding Git objects; manifest-listed packs need not all be reachable
from current Git refs. Unreferenced object payloads are not downloaded or
validated; their sizes come from listing. Unknown keys are never treated as
recognized unreferenced metadata. Completeness also depends on a correct
listing adapter: no generic client can detect a provider silently omitting
an unreferenced key without an independent inventory.

Limits bound work the helper initiates and data it processes, not provider
latency, cancellation, total process memory or a hard CPU deadline. The
`get()` contract returns an already allocated object, so byte checks cannot
prevent that provider-side allocation; similarly, a listing page already
exists before it is checked. No cache or persistent checkpoint is installed.
Matching opaque root tokens also do not promise a monotonic generation or
exclude an intervening change-and-restore by an out-of-band writer.

`test/bounded-inventory.test.ts` covers every budget, provider call bounds,
pagination anomalies, exact classification, corrupt historical records,
missing/corrupt index data, backend failures, mutations during listing, and
root-body/token races. All failures throw without returning a partial report.

## Executable counterexamples

`test/inventory-coordination.test.ts` uses the real WAL and read-session
implementation with deterministic latches around object-store operations.
It performs no deletion.

| Test              | Interleaving                                                                                                                                | What the stable latest-root view misses                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Old reader        | Reader captures root A and pauses before fetching its manifest; writer publishes B; inventory starts and finishes on B                      | The reader still requires A's manifest                                                            |
| Pending publisher | Writer stores its new record/index/manifest and pauses before root CAS; inventory starts and finishes on A; writer subsequently publishes B | B's manifest is unreferenced during the inventory but belongs to a pending successful publication |

Both inventories can observe identical root bytes/version before and after.
Both pending operations subsequently succeed because all objects were kept.
Deleting based only on those observations could instead break a reader or
publish an incomplete repository. Request-scoped immutable read reuse does
not prevent either interleaving and is not a reader lease.

## Host proof obligations

The bindws audit and workerd tests must identify the owning Durable Object
and cover all paths that access or mutate a repository: Git advertisements,
fetches, pushes, policy/event changes, promotion, administrative operations,
expiry/alarms, and any migration or maintenance paths. A new diagnostic must
not quietly bypass that ownership even though it is read-only.

For any later collector, coordination must cover the **whole** relevant
operation, from root capture through the last required object read, and from
the first immutable publication through resolution of root CAS. Early
returns, errors, response streams and background promises must not release
the protection while storage work continues. The existing buffered-response
path and scoped callback need to be tested as used by the actual host, not
inferred from a helper's name.

Durable Object storage input gates are not a blanket lock around external
R2 I/O. Cloudflare documents explicit concurrency controls for operations
that yield the event loop; process-local protection also does not by itself
establish safe recovery across replacement of an instance. See the official
[Durable Object state documentation](https://developers.cloudflare.com/durable-objects/api/state/).
R2's [consistency guarantees](https://developers.cloudflare.com/r2/reference/consistency/)
do not turn a series of listing, marking and deleting operations into one
repository transaction.

Even passing live-instance interleaving tests leaves these collection gates:

- Prove a single ownership/fencing scheme covers every participating runtime,
  including maintenance tools, deployment overlap and any direct bucket users.
- Protect active old-root readers and pre-root publishers, not just the
  current root. A root CAS is not a multi-object deletion fence.
- Define crash/restart handling, ambiguous writes/deletes, resumable bounded
  work, and reservation reconciliation before introducing deletion.
- Revalidate a persisted report before use; a prior inventory is diagnostic
  evidence, never a reusable deletion capability.
- Retain indefinite retry receipts and their current index unless a separate
  explicit protocol/policy change is approved.

No runtime fix is included if the audit finds a gap. Such a gap is a blocker
to metadata collection, not permission to broaden this test/docs-only pass.

## Host results from the paired audit

The bindws agent's actual workerd/R2 tests exercise both successful and failed
HTTP and alarm operations. While the HTTP path owns `graspBusy`, competing
Git, signed-event and admin work is rejected; the alarm defers without R2
work. Consuming the completed HTTP response makes no further R2 reads.
Flags unwind after success and injected failures.

The alarm's `graspControls` protection is narrower: it rejects Git, but a
signed repository-state event can change SQL while the alarm is awaiting
R2. That tested event does **not** perform an R2 operation or hold a Git
root. This is a negative proof of a general shared lock, not a demonstrated
existing Git-publication or data-loss bug. Direct internal helpers and
teardown depend on caller protection; instance replacement/deployment and
outstanding external work are not covered by these live-instance tests.

Accordingly, this pass strengthens inventory and coordination evidence but
does **not** clear the metadata-collection gate. A follow-up runtime design
must establish protection across those paths and lifecycle boundaries before
any collector can be enabled.
