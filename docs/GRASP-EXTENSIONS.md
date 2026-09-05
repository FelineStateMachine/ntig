# GRASP extension building blocks

ntig 0.4.0 supplies the Git-side components for alternative PR hosting
(GRASP-06) and proactive synchronization (GRASP-02, with GRASP-03 discussion
sync and GRASP-05 archive behavior composed by the host). The library does
not accept Nostr events, schedule jobs, or advertise these profiles itself.

The normative source is GRASP commit
`f35b4f9a4ed2f0aaaf46926e4b1733c79e21b377`, recovered on 2026-09-05 from
[the repository's announced Git endpoint](https://relay.ngit.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/grasp.git).
Its identity and clone URLs were discovered through the repository
announcement linked by [the protocol site](https://gitgrasp.com/).
The former GitHub location now returns 404. This is the same source commit
used by the existing GRASP-01 integration notes.

## Alternative PR repositories

```ts
const repository = createPrRepository(wal, {
  lookupTip: async (eventId) => host.lookupAcceptedPrTip(address, eventId),
  allowUnknownPrRefs: true,
  serialize: (operation) => host.withRepositoryAuthority(operation),
});
const handler = createGitHandler(repository, {
  prefix: repositoryPath(address, true),
  authorizePush: (request) => host.admitUpload(request),
});
```

Use `repositoryStoragePrefix(address, true)` to separate the alternative
namespace from ordinary repository storage. The address belongs to the PR
**signer**, while its `a` tag can identify a different repository owner.
The host verifies signatures and requires the event's `clone` tag to name
this service's exact `/prs/<signer-npub>/<identifier>.git` endpoint with an
identifier matching a valid repository coordinate in its `a` tags.
An accepted target repository announcement is not required for this path.

`lookupTip` returns the verified matching SHA-1 tip, `null` for an unknown
event, or `false` for a known but inadmissible event. Expired, deleted,
banned, wrong-signer and wrong-repository events must not be treated as
unknown. The host holds the same authority fence around event acceptance
and Git publication. If the host already fences the entire request, it may
omit `serialize` rather than recursively acquiring that fence.

The wrapper:

- permits only `refs/nostr/<64-lowercase-hex-event-id>` writes;
- rejects mixed ordinary/PR transactions before any write;
- rejects public deletion, wrong accepted tips and false authority;
- permits unknown uploads only with `allowUnknownPrRefs: true`;
- hides ordinary refs, invalid PR refs and mismatched tips from both full
  reads and metadata-only advertisements;
- exposes no HEAD and preserves the accepted-state adapter's correction and
  retry handling when a previously unknown upload has the wrong tip.

The host mounts empty well-formed PR paths without requiring a repository
announcement. Reads do not create an R2 root. It also owns purgatory, bounded
anonymous admission, non-renewable upload deadlines and trusted cleanup
through the raw WAL. Use separate durable cleanup identities for ordinary
and alternative repositories, even when signer and identifier match.

### Migration from 0.3.0

`createPrRepository` now has the same authority protections as
`createAcceptedStateRepository`. Unknown uploads require explicit opt-in;
public deletion is rejected; tip mismatch raises `AuthorizationError`;
and reads filter the namespace and authority. `loadRefs()` is supported.
Code performing trusted cleanup must retain the private raw WAL rather
than issue deletions through the public PR wrapper. Existing R2 formats
and the ordinary accepted-state wrapper are unchanged.

## Bounded outbound Git fetch

```ts
const downloaded = await fetchGitPack(cloneURL, {
  wants: acceptedMissingTips,
  fetch: (request) => host.fetchApprovedGitSource(request),
  signal,
  observe: (event) => host.observeGitTransfer(event),
});
// Recheck the accepted state under the host's authority fence before this
// publication. Derive updates and expected-old OIDs from that state and WAL.
await authorizedRepository.commit({
  id: stableAttemptId,
  updates: acceptedUpdates,
  pack: downloaded.pack,
});
```

`fetchGitPack` performs Smart HTTP discovery and a single SHA-1 upload-pack
round. It requests only caller-selected object IDs, negotiates sideband and
OFS deltas when available, and verifies pack checksums, object structure,
complete dependencies and all requested targets before returning. Native
Git and ntig servers are exercised by tests. Returned advertisement refs
and HEAD are untrusted diagnostic metadata, never write authorization.

| Limit                                           | Default    | Maximum configurable value |
| ----------------------------------------------- | ---------- | -------------------------- |
| Pack bytes                                      | 4 MiB      | 4 MiB                      |
| Upload-pack response including progress/framing | 4.25 MiB   | 5 MiB                      |
| Advertisement bytes                             | 256 KiB    | 1 MiB                      |
| Advertised refs                                 | 1,024      | 1,024                      |
| Requested object IDs                            | 1 to 1,024 | 1,024                      |
| Network operation deadline                      | 30 seconds | 60 seconds                 |

Response bodies are read with fixed byte budgets and canceled on overflow
or abort. Sideband progress counts toward the response budget. The normal
native decoder's object, expansion and graph limits also apply. Cancellation
is checked before and after verification; it is not a preemptive CPU limit.

Only HTTPS URLs without embedded credentials, query strings or fragments
are accepted. Requests carry no credentials or cookies. Redirect mode is
`manual` because workerd does not support `error`; every non-200 or already
redirected response is rejected. The host must approve destinations, reject
self-fetches and internal network targets, and enforce DNS/egress policy
through its injected transport. HTTPS syntax alone is not destination
admission. An injected transport must honor abort and redirect settings.

There is no retry loop, ref publication, scheduling, shallow fetch, thin
pack, protocol v2, credential negotiation or incremental-have negotiation
in this function. It fetches a complete pack for the requested roots; the
host skips already-present targets and caps attempts across sources. A
complete pack can repeat existing objects, so the normal retained-pack
quota still applies. Empty desired state or deletion-only reconciliation
needs no network fetch.

The advisory observer reports attempted request count, request body bytes,
consumed response bytes, last HTTP status and a classified error on failed
attempts. It does not include transport headers or bytes discarded without
being consumed. Observer failures do not alter the fetch result. The host
admits and meters durable work separately.

## Host profile responsibilities

| Profile  | Required host behavior beyond the Git library                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GRASP-06 | Exact signer/clone/coordinate matching, pre-announcement PR acceptance, empty paths, purgatory, admission and expiry                                   |
| GRASP-02 | Historic **and live** accepted-event synchronization from announcement relays; missing latest-state and accepted PR/update Git fetches at least hourly |
| GRASP-03 | GRASP-02 plus outbox synchronization of events tagging accepted issues, patches or PRs; author metadata and relay-list discovery                       |
| GRASP-05 | GRASP-02 plus optional admission of announcements that omit this service from clone/relay tags                                                         |

Event history cursors, live subscriptions, durable scheduling, archive
admission, private-event handling, source policy and billing stay in bindws
or another embedding host. An hourly generic relay pull alone does not
satisfy GRASP-02's live synchronization requirement. Advertise a profile
only after its integrated requirements have been verified.

Neither removing expired refs nor archive mode reclaims stored objects.
Retained packs and metadata remain charged, including at the legacy
transaction cap; the collection boundaries in [Inventory](INVENTORY.md)
continue to apply.
