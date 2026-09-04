# GRASP stretch scope

Reference: [GRASP specifications](https://ngit.dev/grasp/), inspected at source commit `f35b4f9a4ed2f0aaaf46926e4b1733c79e21b377` on 2026-09-04. The implementation is deliberately a set of useful building blocks, **not a claim of complete GRASP conformance**.

## Included and tested

| Standard component          | Implementation                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GRASP-01 repository URL     | Checksum-validated NIP-19 npub plus one percent-encoded identifier segment; Unicode and encoded slashes supported.                                     |
| Repository isolation        | Domain-separated SHA-256 keys include the public key and full identifier. PR and ordinary repository storage prefixes differ.                          |
| GRASP-01 fetch capabilities | Reachable/tip SHA-1 wants, `filter`, `blob:none`, `tree:0`, real filtered Git clone and lazy checkout.                                                 |
| GRASP-01 HEAD               | Explicit `headRef` hook and optional Worker `HEAD_REF`, used when advertising Git HEAD. This does not yet consume signed state events.                 |
| GRASP-01 CORS               | Origin `*`, GET/POST, Content-Type and credential headers; all Worker responses including errors/discovery, OPTIONS 204.                               |
| Discovery                   | Root `Accept: application/nostr+json` returns NIP-11-shaped metadata with acceptance criteria. Complete supported GRASP/NIP lists remain empty.        |
| Repository landing page     | Hosted path serves safe HTML linking to a Nostr Git client; unhosted repository paths return 404.                                                      |
| GRASP-06 Git policy helper  | `createPrRepository` only permits `refs/nostr/<64-hex-event-id>`; mixed transactions are rejected atomically and known accepted event tips must match. |
| GRASP-06 path helper        | Parses/generates `/prs/<npub>/<identifier>.git` and isolates its storage. Not mounted as a public service.                                             |

## Configuration

The independently packaged library now includes `createAcceptedStateRepository`: host-verified state controls ordinary ref writes and HEAD, with known PR tips enforced and unknown-event uploads explicitly opt-in. See [embedding instructions](INTEGRATION.md) for its serialization contract, metering and the cleanup-at-cap limitation. The example Worker remains separate and does not mount this Nostr authority adapter.

The default Worker remains a single repository at `/repo.git`. Set `REPOSITORY_NPUB` and `REPOSITORY_IDENTIFIER` in `wrangler.jsonc` to use the canonical GRASP path, then regenerate types with `npm run cf-typegen`. Canonical identity changes select a **different R2 namespace**, not an implicit rename or migration of the default repository. The old namespace is not deleted.

Identifiers have a local 256-byte UTF-8 quota. Helpers require canonical uppercase percent escapes and encode reserved characters; they decode exactly once. This avoids identifier aliasing and path-injection bugs. The quota/canonicalization policy is local, not an additional GRASP rule.

`HEAD_REF`, when set, must name `refs/heads/...`. Without it the example Worker prefers main, master, then the first branch. Integrated callers should use the accepted-state wrapper, whose HEAD overrides those heuristics.

The PR policy helper requires an injected lookup that returns a tip **only from a signature-verified, accepted PR/PR-update event**. It does not fetch or verify events itself. The caller must coordinate event acceptance with Git publication to avoid races, and enforce quotas. No anonymous PR hosting route is enabled by the example Worker.

## Intentionally deferred

- **GRASP-01 completion:** NIP-01 relay, NIP-34 event acceptance, recursive maintainer resolution, signed latest-state authorization, purgatory and PR-ref cleanup. The example still uses bearer-token writes.
- **GRASP-02:** historic/live relay synchronization and scheduled Git/PR fetches. This needs durable jobs, relay state and retry/backoff policy.
- **GRASP-03:** discussion-history/outbox synchronization; depends on GRASP-02.
- **GRASP-05:** archive acceptance is a small policy change, but the standard requires GRASP-02. Advertising it without sync would be misleading.
- **GRASP-06 completion:** event acceptance without a repository announcement, public empty PR repositories, expiry/cleanup and abuse controls.
- **GRASP-08:** repository-scoped NIP-98 credentials, NIP-42 relay authentication, recursive service-owner whitelist and private metadata handling. A bearer token or generic NIP-98 check would not satisfy its specific rules.

Run the upstream GRASP audit against an integrated relay/service before adding any entry to `supported_grasps`.
