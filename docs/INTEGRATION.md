# Embedding ntig

The npm package is an ESM library with declarations, separate from the example Worker. It exports storage, WAL, Git, HTTP, GRASP policy and metering seams from `ntig`. No bindws imports or bearer-token dependency are included in the library entry point. [bindws](https://github.com/FelineStateMachine/bindws) is the primary consumer.

## Reproducible dependency

From a clean, committed ntig checkout, run `npm ci`, `npm run check`, `npm run pack:check`, then `npm pack --pack-destination <artifact-directory>`. The prepack hook rebuilds the library; the package smoke test compares two archives byte-for-byte and installs one into a fresh Node/TypeScript consumer. Keep the source commit, archive checksum and vendored archive together in the consuming project's provenance record. Install that archive and commit the consumer lockfile. Do not use a mutable sibling `file:../ntig` dependency.

Source is mirrored publicly at [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig). No CI or npm registry publication is configured; the package remains `private: true` to prevent accidental publishing. This is a locally tested, pinned vendoring workflow.

The rename from nostrwal does not migrate data: R2 hash domains, the example bucket/deployment names and the existing discovery extension key deliberately retain their legacy identifiers. Existing `nostrwal` tarballs remain usable. Consumers can switch imports to `ntig` with the new tarball, or temporarily install the tarball under their existing dependency key. The current integration checkout may still be named `nostrwal`; that path is not part of the package contract.

## Authority boundary

Compose these exported APIs:

```ts
import {
  R2ObjectStore,
  WalRepository,
  NativeGitEngine,
  createAcceptedStateRepository,
  createGitHandler,
  type AcceptedStateOptions,
  type ObjectStore,
} from "ntig";

function repositoryHandler(
  store: ObjectStore,
  storagePrefix: string,
  routePrefix: string,
  authority: AcceptedStateOptions,
  admitPush: (request: Request) => Promise<boolean>,
) {
  const wal = new WalRepository(store, new NativeGitEngine(), {
    prefix: storagePrefix,
  });
  const authorized = createAcceptedStateRepository(wal, authority);
  return createGitHandler(authorized, {
    prefix: routePrefix,
    authorizePush: admitPush,
  });
}
```

Use `R2ObjectStore` around the host's R2 binding. `repositoryStoragePrefix` derives isolated keys from a validated `repositoryAddress`; `parseRepositoryPath` recognizes canonical routes. Do not mount an unwrapped WAL on the same public receive-pack path.

`lookupState()` returns `{ eventId, refs, head }` or null. The host verifies Nostr signatures, repository identity, recursive maintainer authorization, event replacement order and pending/purgatory state. Validated pending state must be available here to authorize the Git upload that will promote it. Ordinary changed refs must equal that state's desired OIDs; deletion requires absence from desired refs. The wrapper does not silently reconcile other refs.

Materialized ordinary refs remain advertised even while a newer state is pending: stock Git needs the true old OID to send a valid compare-and-swap update. HEAD is selected exclusively from authority, not main/master heuristics. A missing branch is an unborn symbolic HEAD, including an empty accepted refs map. If that branch still contains an older OID, HEAD continues to expose that materialized tip so clone/checkout works while the pending state awaits its Git data. An authorized push naturally advances the HEAD OID. A null accepted HEAD explicitly disables the heuristic.

`lookupPrTip(eventId)` has three results:

| Result                     | Meaning                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| 40-character lowercase OID | Verified accepted or admissible pending PR/PR-update tip               |
| `null`                     | Genuinely unknown event                                                |
| `false`                    | Known but not an admissible PR, rejected event, or expired unknown ref |

Unknown-event pushes are denied unless `allowUnknownPrRefs: true`. That opt-in supports GRASP-01's pre-event upload workflow and requires host quotas and expiry bookkeeping. A known mismatched tip always fails. Invalid/expired PR refs are hidden from advertisements and the allowed fetch roots; their objects may still be fetched if independently reachable from another visible ref. Public PR deletion is denied. Trusted expiry cleanup must use the private underlying WAL under the same authority fence.

When a previously unknown PR ref becomes hidden because its stored tip disagrees with an accepted event, stock Git advertises its replacement as a creation (`old=0`). The wrapper translates that view-level creation to the exact stored old OID only for a known accepted PR tip matching the requested new OID. It does so after authorizing every update, under the same authority fence. WAL expected-old and root CAS checks remain intact; visible PRs, unknown PRs and ordinary refs never get this correction. Retained WAL records reconstruct a corrected physical transaction for retry receipt replay; altered packs or other transaction data still fail the WAL digest check.

**The host must serialize authority changes with Git publication.** Hold one repository/relay fence across state lookup and the entire commit, including R2 awaits and root CAS. Event acceptance, replacement, administrative mutations and alarms must honor that same fence. The optional generic `serialize(operation)` callback can apply it to wrapper reads and commits; alternatively the host may already hold it around the full HTTP operation. Do not acquire the same non-reentrant lock twice. Checking authority twice without a shared fence does not eliminate the race.

`authorizePush` is pre-body admission, not the ref authority. It can allow unauthenticated GRASP transport only after the host's admission/rate/cost checks. The accepted-state wrapper then validates every ref before delegating any write. Private read authorization, if needed, must wrap the handler externally; this is not GRASP-08 authentication.

## Metering, errors and retries

`GitHttpOptions.observe` receives `{ requestBytes, responseBytes, status, errorCode? }`. Request bytes count chunks actually consumed, including a chunk crossing the body limit. Rejected pre-body requests report zero. Response bytes count produced body bytes, not delivery acknowledgements or HTTP/TLS framing. Error responses have a fixed small body even when `maxResponseBytes` is smaller than that body. A successful push report must fit the response budget before publication begins. Git report-status rejections have HTTP 200 but include an error code in this observer.

`MeteredObjectStore` reports GET hit/miss/error and conditional PUT success/failure/error with bytes read, attempted PUT bytes and acknowledged successful PUT bytes. It omits keys and provider messages. Observer failures do not change storage outcomes. These are best-effort observability hooks, **not durable billing or quota enforcement**. Async storage observers are awaited; keep them bounded and fast. A lost storage acknowledgement can leave durable bytes despite an error event reporting zero acknowledged successful bytes.

Net retained storage requires per-key accounting/reconciliation, including overwritten roots and unpublished objects. Reserve tenant capacity before storage writes, retain reservations on ambiguous outcomes, and reconcile them safely. Summing successful PUT bytes is not net storage usage. Host budget admission belongs outside these observational hooks.

Exported errors carry stable codes: `CONFLICT`, `INVALID_DATA`, `LIMIT_EXCEEDED`, `NOT_AUTHORIZED`, `UNAVAILABLE`. `classifyError` produces safe client messages/statuses. HTTP never returns raw provider errors. Corrupt repository loads are unavailable rather than blamed on the client. A push storage error can be an unknown outcome: use the same `X-Git-Request-Id` and identical transaction for receipt replay. Stock Git does not supply this header; inspect refs before retrying an ambiguous ordinary push. Reauthorization still applies to a retry after authority changes.

## Bounded cost and support

For `n` WAL records referencing `p` distinct packs, a successful cold load performs `1 + n + p` object GETs. An uncontended new push adds up to three PUTs (pack, record, root); a ref-only push uses two. Existing immutable objects, CAS losses and retries add reads/attempts. Every load hashes/replays all metadata and validates the entire stored object graph. Fetch currently decodes the in-memory pack snapshot again; this is duplicate CPU/hash work, **not another R2 download**. Fetch traversal caches links and caps total distinct graph edges at 65,536. Haves are not used to minimize the outgoing pack.

Known-tip PR create/correction requests (`old=0`) perform one additional full load to reconcile the advertised view with physical refs and retained retry records. It is shared across all eligible updates in that transaction, not one load per ref. No extra writes or pre-commit deletion are used for correction.

The default limits remain 4 MiB per pack, 16 MiB unique packed history, 128 commits, 1,024 refs, 4,096 object entries and 16 MiB decode work/retained object budget. HTTP bodies default to 4 MiB + 256 KiB; produced responses to 17 MiB. These limits interact conservatively; they do not promise every combination fits a Workers CPU/memory budget. Production peak memory and CPU have not been benchmarked.

**At 128 commits all new writes, including deletion/expiry cleanup, stop.** No checkpoint or deletion-only escape hatch is shipped. Hosts may hide expired refs using `lookupPrTip=false`, but this is not physical cleanup and does not reclaim bytes. Failed/concurrent writes can leave orphans outside committed-history limits; rate limits, storage reservations and operational inspection remain necessary. Do not enable bucket expiry on committed packs/records. Indexed reads, checkpointing, retained retry receipts and safe garbage collection are the next storage milestones.

This library is a tested bounded building block, not complete GRASP-01 or unbounded Git hosting. The example Worker advertises no completed GRASPs. Relay/purgatory/sync/expiry behavior and the upstream GRASP audit belong to the integrated service.
