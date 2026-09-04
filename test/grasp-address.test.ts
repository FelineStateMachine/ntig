import assert from "node:assert/strict";
import { test } from "node:test";
import { bech32 } from "@scure/base";
import {
  parseRepositoryPath,
  repositoryAddress,
  repositoryPath,
  repositoryStoragePrefix,
} from "../src/grasp/address.ts";

const npub = bech32.encodeFromBytes("npub", new Uint8Array(32).fill(7));

test("validates and canonicalizes NIP-19 npub addresses", () => {
  const address = repositoryAddress(
    npub.toUpperCase().toLowerCase(),
    "project",
  );
  assert.equal(address.npub, npub);
  assert.equal(address.pubkey, "07".repeat(32));
  assert.throws(() => repositoryAddress(npub.slice(0, -1) + "x", "project"));
  assert.throws(() =>
    repositoryAddress(
      bech32.encodeFromBytes("nsec", new Uint8Array(32).fill(7)),
      "project",
    ),
  );
  assert.throws(() =>
    repositoryAddress(
      bech32.encodeFromBytes("npub", new Uint8Array(31)),
      "project",
    ),
  );
});

test("encodes one identifier path segment and parses smart HTTP endpoints", () => {
  const address = repositoryAddress(npub, "a/b café");
  const root = repositoryPath(address);
  assert.equal(root, `/${npub}/a%2Fb%20caf%C3%A9.git`);
  for (const [suffix, endpoint] of [
    ["", "root"],
    ["/info/refs", "info/refs"],
    ["/git-upload-pack", "git-upload-pack"],
    ["/git-receive-pack", "git-receive-pack"] as const,
  ])
    assert.equal(parseRepositoryPath(root + suffix)?.endpoint, endpoint);
  assert.equal(parseRepositoryPath(`/prs${root}`)?.alternativePRs, true);
  assert.equal(parseRepositoryPath(root.replace("%2F", "%2f")), null);
  assert.equal(
    parseRepositoryPath(root.replace("%2F", "%252F"))?.address.identifier,
    "a%2Fb café",
  );
  assert.equal(parseRepositoryPath(`/${npub}/%2E.git`), null);
  assert.equal(
    parseRepositoryPath(repositoryPath(repositoryAddress(npub, ".")))?.address
      .identifier,
    ".",
  );
  assert.equal(parseRepositoryPath(`${root}/info/refs/extra`), null);
});

test("enforces UTF-8 local quota and isolates PR storage namespace", async () => {
  assert.throws(() => repositoryAddress(npub, "x".repeat(257)));
  assert.throws(() => repositoryAddress(npub, "é".repeat(129)));
  assert.equal(repositoryAddress(npub, "é".repeat(128)).identifier.length, 128);
  assert.throws(() => repositoryAddress(npub, "\u0000"));
  assert.throws(() => repositoryAddress(npub, "\ud800"));
  const address = repositoryAddress(npub, "project");
  const normal = await repositoryStoragePrefix(address);
  const prs = await repositoryStoragePrefix(address, true);
  assert.match(normal, /^repos\/[0-9a-f]{64}\/$/);
  assert.notEqual(normal, prs);
});
