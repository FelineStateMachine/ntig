# Receive-pack sideband compatibility

Version 0.6.1 advertises and accepts `side-band-64k` on receive-pack. A
libgit2 1.9.7 push sends that capability in its command pkt-line, even when
the pack is small. Older ntig rejected the command as an unsupported
capability, which made the push fail before the repository state was reached.

The receive status is a pkt-line report carried on sideband channel 1. Each
status pkt-line is nested inside the channel-1 pkt-line, followed by a
channel-1 pkt-line containing the report flush and the outer stream flush.
This preserves the `unpack` and per-ref status records for Git clients while
also terminating the sideband demultiplexer cleanly. A request without the
sideband capability continues to receive the ordinary report-status stream.

The local compatibility capture used for the regression was libgit2 1.9.7
against a disposable HTTP fixture. Its first receive command negotiated:

```text
report-status side-band-64k
```

The captured request also contained the normal `0000` command flush followed
by a `PACK` stream. The fixture test replays this command framing through the
actual handler and checks both successful and rejected status reports.

Upload-pack negotiation requests may also arrive with `Content-Encoding:
gzip`, as produced by native Git for larger mirrors. ntig bounds both the
compressed request and the streamed decompressed negotiation body to the
fetch request limit before parsing it; receive-pack compression remains
rejected.
