# Metadata retention inventory

This is a follow-up measurement of the unchanged 0.2.1 storage implementation,
not a new package release or a garbage collector. The 0.2.1 source pin and
immutable archive remain unchanged. Run `node --import tsx --test
test/metadata-growth.test.ts` from this analysis checkout to reproduce it.

## Is the remaining storage a floor?

Mostly not in the growing-tag fixture. A quiescent current-format retention
set is 142,618 bytes out of 2,026,473 stored bytes. The other 1,883,855 bytes
(about 93%) are superseded manifests and receipt-index nodes. This is genuine
stored metadata in the backend fixture, not a reservation estimate.

The retention set is a floor **for retaining the existing object encoding and
all historical retry receipts**, not an information-theoretic minimum, a
universal per-repository charge, or permission to delete the complement.
Older readers and in-flight publishers can still need objects not referenced
by the latest root. Safe reclamation remains unimplemented.

## Exact backend fixture bytes

Both scenarios have 260 transactions, migrate after transaction 128, and use
one 229-byte Git pack. A graph walk verifies that its three objects (commit,
tree and blob) are all reachable from current refs. No failed publications
are injected into these two growth scenarios.

| Component                          | Fixed ref: stored | Fixed ref: current-format required | Growing tags: stored | Growing tags: current-format required |
| ---------------------------------- | ----------------: | ---------------------------------: | -------------------: | ------------------------------------: |
| Root                               |               105 |                                105 |                  105 |                                   105 |
| Git pack                           |               229 |                                229 |                  229 |                                   229 |
| All 260 historical receipt records |            91,006 |                             91,006 |               80,799 |                                80,799 |
| Manifests                          |            43,225 |                                325 |            1,569,267 |                                15,759 |
| Receipt-index nodes                |           376,073 |                             45,726 |              376,073 |                                45,726 |
| **Total**                          |       **510,638** |                        **137,391** |        **2,026,473** |                           **142,618** |

Each scenario stores 790 keys. The latest-root retention set contains 379:
one root, one pack, 260 records, one manifest and 116 index nodes. The other
411 keys are 132 superseded manifests and 279 superseded index nodes.
Unreferenced bytes are 373,247 for fixed refs and 1,883,855 for growing tags.
Growing-tag records are smaller because each update has a null old OID;
fixed-ref updates retain a 40-character old OID. IDs and ref names also affect
encoded size. These fixtures differ from the bindws benchmark and their
totals must not be substituted for its physical or reserved totals.

The current growing-tag manifest is **15,759 bytes**, not 1.57 MB. The larger
number sums all 133 retained manifest versions. Current refs require space,
but rewriting their complete map on each commit accumulates substantially
more storage when superseded manifests are never reclaimed.

### Retention trend

| Transactions                     | Fixed ref: required / stored bytes | Growing tags: required / stored bytes |
| -------------------------------- | ---------------------------------: | ------------------------------------: |
| 128, immediately after migration |                    64,170 / 64,170 |                       66,625 / 66,625 |
| 192                              |                   98,317 / 273,402 |                     102,116 / 879,057 |
| 260                              |                  137,391 / 510,638 |                   142,618 / 2,026,473 |

Across transactions 129–260, the current-format retention set grows by about
555 bytes per transaction for fixed refs and 576 for growing tags. Actual
retained storage grows by about 3,382 and 14,847 bytes per transaction,
respectively. These are interval averages, not a promised marginal rate:
receipt-trie splits and ID/ref lengths change costs. In this interval the
growing current manifest adds 60 bytes per tag, while every commit also
retains another complete manifest. Ref count is still bounded by configured
limits; historical receipts and superseded metadata continue accumulating
even when ref count is fixed.

## Small-repository baselines

| Scenario                                      | Keys | Stored/current-format bytes |
| --------------------------------------------- | ---: | --------------------------: |
| Untouched empty repository (format 1 default) |    0 |                           0 |
| Explicitly checkpointed empty repository      |    2 |                         176 |
| One Git commit, format 1                      |    3 |                         636 |
| The same commit, explicitly checkpointed      |    5 |                       1,121 |

The empty checkpoint is a 103-byte root and 73-byte manifest. The one-commit
checkpoint contains root 103, pack 229, record 309, manifest 323 and index
157 bytes. There is no unreferenced metadata in those baselines. These are
object payload bytes only: not SQL overhead, R2 operation costs, compute,
replication, or a platform billing minimum.

## How the inventory is checked

The source-only fixture captures the root and calls `WalRepository.load()`
to verify the current manifest, packs, object graph, tip and tip-index path.
`Snapshot.checkpoint` supplies `manifestHash`, `receiptRoot` and `packIds`.
The internal `MerkleIndex.visit()` walks all nodes from that receipt root:

- `visitor(nodeHash)` identifies a hash-verified, canonical, routed node.
- `visitor(nodeHash, requestIdHash, recordHash)` identifies an indexed record.
- Nodes have byte/depth bounds; traversal has a node budget and rejects cycles.

The fixture marks records only from those leaf entries, checks each record's
content hash and SHA-256(request ID), and validates every entry with
`lookupRecord(id)`. It also checks unique, complete transaction sequences and
unchanged root bytes/version. Merely listing `/records/` would incorrectly
classify orphan records as necessary. A separate injected 20-byte unindexed
object under `/records/` is correctly classified as unreferenced.

For each scenario, the test creates a **separate copy** containing only the
retention set. Cold full loads and ref reads succeed; every historical
receipt lookup and all 260 identical transaction retries succeed without a
single write. Original fixture objects are never deleted. This demonstrates
sufficiency for these quiet fixtures, not online-GC safety or arbitrary
repository conformance. `MerkleIndex` remains an internal source import;
no new public library API is introduced.

## Retention semantics and next boundary

All indexed records are required by the current indefinite receipt policy.
Their embedded parent and pack hashes must remain unchanged for integrity,
but `lookupRecord()` does not follow parent links or download historical
packs. A pack-bearing retry supplies the original bytes again. Nevertheless,
the current manifest's pack list is historical: `load()` requires and verifies
every listed pack, and requires the tip record's pack to belong to that list.
Manifest membership is therefore not a general proof of current Git-ref
reachability. Repacking needs a separate graph/format design; the one-pack
fixtures do not settle that question.

Preserving only current-format referenced objects would still leave receipt
records and their current index growing with transactions, even with one
unchanged ref. That retained history is a policy/encoding cost; obsolete
copy-on-write nodes and manifests are accumulated bookkeeping. Compressing
or redesigning the retained representation would need separate compatibility
and recovery validation, while dropping receipts would change retry semantics.

Next, reconcile the host's actual object inventory against its per-key
reservations. Treat reservation slack, current-format required bytes, and
unreferenced objects as separate quantities. Any future deletion needs a
complete bounded mark plus coordination covering readers, writers and crash
recovery. A quiet fixture, an unchanged root, or an age threshold alone is
not that coordination. No deletion, migration, quota/rate change, extra wake,
or deployment is part of this measurement.

For this ref-heavy workload, the next storage-saving target should be
**coordinated obsolete-metadata collection before changing the retained
representation**: the removable-at-quiescence complement is much larger than
the retained receipt set. First build/validate a bounded read-only inventory
and prove the host fence covers every reader, publisher and maintenance path.
Then fault-test a metadata-only collector under explicit maintenance budgets
and recovery rules. This does not recommend a receipt-expiration window or
removing any pack. Representation changes remain worth evaluating if the
required history itself eventually becomes the limiting cost; selective
pack reads and repeated validation CPU are separate performance concerns.
