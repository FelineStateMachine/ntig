# ntig

Bounded Git hosting for Nostr applications, running directly on Cloudflare Workers with an R2-backed write-ahead log. Think of it as the Git-storage side of ngit in the cloud: Smart HTTP, pack validation, atomic ref updates and GRASP-facing policy hooks, without a Git container.

[bindws](https://github.com/FelineStateMachine/bindws) is the primary consumer. It supplies the Nostr relay, accepted-event authority and application policy; ntig supplies the independent Git/storage backend. There are no bindws imports or runtime dependencies here. Narwal/gitwal is an architectural reference, not an upstream dependency; this implementation is original TypeScript.

This public repository is currently a source mirror for our integration work, not a separately operated hosting service. There is no CI; tests and package checks run locally before integration snapshots are pinned. Incoming consumer fixes take priority over repository polish. The project was initially named **nostrwal**; old snapshots and stable storage identifiers retain that name.

The question this project answers is: can a bounded, useful Git service run directly in Workers, and which requirements still need a native Git process or a different storage design?

The initial answer is **yes for the tested, bounded workload**: the suite covers real Git interoperability in workerd/R2, failure recovery and malformed input. [Validation details](docs/VALIDATION.md) distinguish that evidence from production-readiness. [GRASP components](docs/GRASP.md) document protocol building blocks without claiming complete conformance. [Embedding and cost](docs/INTEGRATION.md) documents the pinned package, accepted-state authority boundary, metering, errors and remaining blockers.

## Development

Requires Node.js 22.22+ and Git on the development machine. Git is a test oracle, not a Worker runtime dependency.

```sh
npm ci
npm run check
```

For a local server, create an ignored `.dev.vars` file using `.dev.vars.example` as a template and choose a local-only `PUSH_TOKEN`, then run `npm run dev`. Reads are public; pushes require `Authorization: Bearer <PUSH_TOKEN>`. Git can send that header through `http.extraHeader`. Do not paste production tokens into shell history. The repository URL is `http://localhost:8787/repo.git`. `npm run build` creates a self-contained Worker bundle in `dist/` and rejects external runtime imports.

Tests use local memory/R2 emulation and temporary Git repositories. No Cloudflare account or deployed infrastructure is needed. Tests may listen on loopback for real Git HTTP clients; they do not start a public service. Dependency versions and the lockfile are pinned. The Miniflare version follows the dependency used by the pinned stable Wrangler release.

## Storage contract

Each repository owns an opaque, validated key prefix:

```text
repos/<id>/root.json          one conditional-write commit point
repos/<id>/records/<sha256>   immutable linked transactions
repos/<id>/packs/<sha256>     immutable Git packs
```

1. Load a consistent root and replay its immutable record chain.
2. Check expected old refs, the entire resulting ref namespace, pack integrity and object connectivity.
3. Create the pack and transaction record without overwriting existing content.
4. Compare-and-swap the root. Only success here makes the transaction visible.

A concurrent loser receives a conflict. A storage exception can mean an unknown outcome: retry the same request ID and identical content. The library returns the original receipt even after subsequent transactions. Reusing an ID with different content is an error. Unpublished objects are harmless orphans, not committed state.

The root is the only authoritative state. There is no second SQLite/DO ref database to reconcile. Future Durable Objects may coordinate/cache work, but must not silently become a competing authority. Cold recovery does not depend on object listing, local disk, or an in-memory cache.

## Scope and safety

This is experimental software, not yet a replacement for an unrestricted Git hosting service. See [the implementation gates](docs/ROADMAP.md) before deployment. The initial implementation deliberately rejects repositories beyond explicit byte/object/history limits rather than claiming unlimited R2 storage makes Git execution unlimited.

The WAL defaults to 4 MiB per pack, 16 MiB cumulative unique packed data, 128 transactions, 1,024 refs, and 256 KiB transaction metadata. There is **no compaction or garbage collection yet**. Reaching a limit fails closed; do not attach a bucket lifecycle rule that deletes committed objects. Increasing a limit is not evidence the Worker can safely handle the resulting workload.

The native decoder additionally caps individual decoded objects at 4 MiB, decoding work/retained object data at 16 MiB, object entries at 4,096, delta depth within a pack at 64, and graph edges at 65,536. These budgets are conservative: duplicate objects and delta intermediates can consume the decoding budget even when the final unique object set would be smaller. SHA-1 Git pack versions 2/3 are supported. Smart HTTP uses the original protocol, including fallback when modern clients request v2; it does not implement protocol v2, shallow clones, LFS, or SSH.

Supported fetch filters are `blob:none` and `tree:0`. OID fetches must be reachable from current public refs; dangling and deleted-only objects are not fetchable. The example Worker uses `HEAD_REF` if configured, otherwise `main`, then `master`, then the first branch. The library's accepted-state wrapper instead derives HEAD from host-verified Nostr authority and enforces desired ref targets. It does not persist or verify Nostr events itself. Pushes are atomic. The example token grants full write authority to this single repository, not branch-level policy.

The HTTP layer generates a new retry ID unless `X-Git-Request-Id` is provided. Ordinary Git clients do not supply that header, so the library's exactly-once receipt replay must not be confused with exactly-once HTTP retries. After an ambiguous ordinary Git push, fetch/inspect refs before retrying.

Push authorization belongs outside the storage engine. The HTTP layer must deny pushes without an explicit authorizer. A standalone shared-token example is not Nostr/GRASP authorization. Authorization must validate a full intended ref transaction before it can be used for GRASP.

## Why this is separate

- Container removal and Git correctness can be tested without changing bindws.
- A stock Git client and `git fsck` provide an external compatibility oracle.
- The `ObjectStore` and `GitEngine` interfaces keep storage and execution replaceable.
- Marmot, nsite/NIP-5A, and ngit/GRASP integration are downstream consumers, not prerequisites for this experiment.

References: [Narwal](https://gitwal.io/architecture), [Git pack format](https://git-scm.com/docs/gitformat-pack), [Git pack protocol](https://git-scm.com/docs/gitprotocol-pack), [R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [GRASP specifications](https://ngit.dev/grasp/).
