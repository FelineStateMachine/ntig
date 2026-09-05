# Git capacity profiles

The native Git implementation uses one `PackLimits` profile for pack decoding,
repository verification, and server-side fetch pack generation. Applications
can pass a partial profile to `createGitHandler` with `gitLimits`, or directly
to `encodePack`, `decodePack`, and `readObjects`.

The defaults are intentionally suitable for ordinary repositories while still
bounding one Worker request:

| Limit                              | Default |
| ---------------------------------- | ------: |
| Compressed pack                    |  32 MiB |
| One decoded object                 |  16 MiB |
| Decoded objects in a verification  |  64 MiB |
| Objects in a verification          | 131,072 |
| Packs in a verification            |     256 |
| Compressed packs in a verification |  64 MiB |

These are transfer and verification bounds, not repository quotas. A host can
raise them when its storage policy and runtime memory budget support it. The
HTTP `maxBodyBytes` and `maxResponseBytes` options remain available for a
separate transport policy; when omitted they are derived from
`gitLimits.maxPackBytes`.

The indexed Smart HTTP upload-pack path streams pack output one object at a
time, so a repository's total size need not fit in Worker memory. The legacy
pack path still materializes its retained packs and remains bounded by the
configured limits. Storage-side repository quotas belong to the host (for
example, bindws), not this protocol library.

`createGitHandler` also accepts `streamUploadPack` for host-specific indexed
backends. The hook receives the request and resolved `gitLimits` before ntig
reads the request body; it may return a streaming Git response, or `null` to
use the built-in path. Any custom hook must enforce `maxResponseBytes` while
producing the response and cancel its indexed read session when the response
stream is cancelled.
