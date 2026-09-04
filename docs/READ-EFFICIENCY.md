# Read efficiency

ntig has a scoped read-session callback for operations that inspect the same
immutable repository objects more than once:

```ts
// Inside the host's existing repository authority fence:
await wal.withReadSession(async (scoped) => {
  const authorized = createAcceptedStateRepository(scoped, authority);
  const response = await createGitHandler(authorized, options)(request);
  // Run the host's existing promotion/recovery policy with scoped here, too.
  return response;
});
```

`withReadSession` is implemented by `ObjectReadSession`. Its default cache is
bounded to **2 MiB of payload bytes and 512 entries**. Callers may provide
smaller limits when the host has less memory:

```ts
await wal.withReadSession(operation, {
  maxBytes: 512 * 1024,
  maxEntries: 128,
});
```

Only exact immutable keys below the repository prefix are eligible: packs,
records, manifests, and receipt-index nodes. The mutable `root.json` is never
cached, so each operation observes the current authority commit point. Every
conditional write is forwarded to the underlying store and invalidates the
affected cached key; in-flight reads cannot repopulate stale data afterward.
Misses and backend errors are not cached, returned bytes are cloned, and a
closed session rejects subsequent operations. The callback lifetime is the
whole intended operation. Do not retain or use the scoped repository for
streaming, background work, or a later request.

The payload budget excludes caller buffers, concurrent in-flight reads and
JavaScript object overhead. Concurrent misses are not coalesced. An already
started read can finish after closing but cannot refill the cache. The parent
repository remains usable; this API never installs a global cache. Use a new
session for an independent integrity check rather than relying on warm bytes
to detect an out-of-band change to supposedly immutable storage.

This is a bounded read optimization, not a consistency or authorization
mechanism. The host must still hold its authority fence across Nostr state
lookups, Git policy, storage awaits, and publication. Sessions do not skip
pack, manifest, record, receipt-index, or Git graph verification, and do not
skip promotion or hidden-PR recovery. They only reuse the exact bytes that
those checks would otherwise read again. The root remains uncached and all
writes remain visible to host accounting and admission.

## Measurements

The metadata-growth fixture uses one deterministic blob/tree/commit pack and
260 transactions: 128 legacy transactions, an explicit checkpoint, then 132
format-2 transactions. The inventory records successful stored objects and
bytes, rather than summing PUT attempts. The current format-2 root makes one
manifest and one receipt trie authoritative; all committed records remain
reachable for historical retry lookup.

| scenario                                | objects: root / pack / records / manifests / index | bytes: root / pack / records / manifests / index | live index | obsolete index |
| --------------------------------------- | -------------------------------------------------: | -----------------------------------------------: | ---------: | -------------: |
| fixed ref (same ref and OID)            |                            1 / 1 / 260 / 133 / 395 |            105 / 229 / 91,006 / 43,225 / 376,073 |        116 |            279 |
| growing tags (new tag each transaction) |                            1 / 1 / 260 / 133 / 395 |         105 / 229 / 80,799 / 1,569,267 / 376,073 |        116 |            279 |

The growing-tag case shows that ref cardinality, not Git pack data, can become
the dominant metadata cost: the 133 retained manifests together occupy
1,569,267 bytes (not one 1.5 MiB manifest), while the fixed-ref manifests total
43,225 bytes. Only one manifest is current; 132 are superseded. The index counts are implementation
measurements, not a promised shape; bulk index construction may change the
number of nodes. No deletion is performed. There is no safe GC yet: reclaiming
obsolete manifests, trie nodes, or other orphans requires complete bounded
reachability verification plus a repository-wide reader/writer fence or
leases, including crash and ambiguous-write recovery.

Additional local write measurements for a realistic 128-receipt bulk fixture
were **249 PUTs / 225,477 bytes**, reduced to **17 PUTs / 18,837 bytes** by
bulk construction, with an identical receipt-index root hash and unchanged
repository publication semantics. These are local
backend observations, not a provider invoice or a tenant quota.

A local backend historical-retry measurement went from **21 GETs / 43,811
bytes** to **10 GETs / 12,834 bytes** with a read session. Both paths performed
the same two Git validations and zero writes. A separate bindws integration
measurement matched its own **30 GETs to 23 GETs** result. The figures are
workload-specific; they do not claim production CPU, memory, or provider
pricing.

The new metadata-admission tests model a serialized host reservation wrapper
around the actual WAL, including manifests, records, receipt-index nodes,
packs and the root. They verify byte/key-cap failures do not publish a new
root, successfully written orphans remain counted, ambiguous outcomes stay
conservatively reserved, and an already committed identical retry succeeds
without writes at a full budget. These are conformance fixtures, not a new
ntig runtime quota ledger. bindws already performs metadata-inclusive
per-key reservations; reconciliation of phantom reservations and safe
reclamation remain host/integration work. ntig's
observational metering hooks remain available for the host to apply its own
budget policy.
