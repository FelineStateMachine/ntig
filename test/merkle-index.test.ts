import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory-store.ts";
import { ConflictError, IntegrityError, LimitError } from "../src/contracts.ts";
import { MerkleIndex } from "../src/merkle-index.ts";

const h = (n: number) => n.toString(16).padStart(64, "0");

test("inserts and reads an immutable radix index", async () => {
  const store = new MemoryStore();
  const index = new MerkleIndex(store, "index");
  let root: string | null = null;
  for (let n = 0; n < 80; n++)
    root = await index.insert(root, h(n), h(1000 + n));
  assert.ok(root);
  for (let n = 0; n < 80; n++)
    assert.equal(await index.get(root, h(n)), h(1000 + n));
  assert.equal(await index.get(root, h(999)), null);
  assert.equal(await index.insert(root, h(3), h(1003)), root);
  await assert.rejects(() => index.insert(root, h(3), h(1004)), ConflictError);
});

test("copy-on-write roots preserve concurrent branches", async () => {
  const store = new MemoryStore();
  const index = new MerkleIndex(store, "i");
  const base = await index.insert(null, h(1), h(2));
  const left = await index.insert(base, h(3), h(4));
  const right = await index.insert(base, h(5), h(6));
  assert.notEqual(left, right);
  assert.equal(await index.get(base, h(3)), null);
  assert.equal(await index.get(left, h(3)), h(4));
  assert.equal(await index.get(right, h(5)), h(6));
});

test("detects missing, corrupt, oversized, and wrongly routed nodes", async () => {
  const store = new MemoryStore();
  const index = new MerkleIndex(store, "i");
  await assert.rejects(() => index.get(h(99), h(1)), IntegrityError);
  const root = await index.insert(null, h(1), h(2));
  const object = await store.get(`i/${root}`);
  assert.ok(object);
  await store.put(`i/${root}`, new Uint8Array([123]), object.version);
  await assert.rejects(() => index.get(root, h(1)), IntegrityError);

  const other = new MemoryStore();
  const malformed = new TextEncoder().encode(
    JSON.stringify({ v: 1, t: "l", e: [["2" + "0".repeat(63), h(3)]] }),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    malformed.slice().buffer,
  );
  const malformedRoot = Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  await other.put(`i/${malformedRoot}`, malformed, null);
  const branch: (string | null)[] = Array(16).fill(null);
  branch[0] = malformedRoot;
  const branchBytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, t: "b", c: branch }),
  );
  const branchDigest = await crypto.subtle.digest(
    "SHA-256",
    branchBytes.slice().buffer,
  );
  const branchRoot = Array.from(new Uint8Array(branchDigest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  await other.put(`i/${branchRoot}`, branchBytes, null);
  const malformedIndex = new MerkleIndex(other, "i");
  await assert.rejects(
    () => malformedIndex.get(branchRoot, h(1)),
    IntegrityError,
  );

  const huge = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      t: "l",
      e: [
        [h(1), "f".repeat(64)],
        [h(2), "f".repeat(64)],
      ],
    }) + " ".repeat(70_000),
  );
  const hugeDigest = await crypto.subtle.digest("SHA-256", huge.slice().buffer);
  const hugeRoot = Array.from(new Uint8Array(hugeDigest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  await other.put(`i/${hugeRoot}`, huge, null);
  await assert.rejects(() => malformedIndex.get(hugeRoot, h(1)), LimitError);
});

test("visit is bounded and reports nodes and leaf values", async () => {
  const index = new MerkleIndex(new MemoryStore(), "i");
  let root: string | null = null;
  for (let n = 0; n < 20; n++) root = await index.insert(root, h(n), h(n + 1));
  const seen: string[] = [];
  await index.visit(root, (node, key) => {
    seen.push(key ? `${key}:${node}` : node);
  });
  assert.equal(seen.filter((x) => x.includes(":")).length, 20);
  await assert.rejects(() => index.visit(root, () => undefined, 1), LimitError);
});

test("validates key, value, prefix and null roots", async () => {
  const index = new MerkleIndex(new MemoryStore(), "i");
  assert.equal(await index.get(null, h(1)), null);
  await assert.rejects(() => index.insert(null, "A", h(1)), IntegrityError);
  await assert.rejects(() => index.insert(null, h(1), "A"), IntegrityError);
  assert.throws(
    () => new MerkleIndex(new MemoryStore(), "../bad"),
    IntegrityError,
  );
});
