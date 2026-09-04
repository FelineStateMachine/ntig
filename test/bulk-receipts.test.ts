import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory-store.ts";
import { ConflictError, IntegrityError, LimitError } from "../src/contracts.ts";
import { MerkleIndex } from "../src/merkle-index.ts";

const hash = (n: number) => n.toString(16).padStart(64, "0");

class CountingStore extends MemoryStore {
  puts: string[] = [];
  putBytes = 0;

  override async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    this.puts.push(key);
    this.putBytes += bytes.byteLength;
    return super.put(key, bytes, expectedVersion);
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
  );
  return Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

test("bulk receipt construction is canonical and has no intermediate roots", async () => {
  const entries = Array.from(
    { length: 80 },
    (_, n) => [hash(n), hash(n + 1000)] as const,
  );
  const bulkStore = new CountingStore();
  const bulk = new MerkleIndex(bulkStore, "i");
  const root = await bulk.buildFromEntries(entries.slice().reverse());
  assert.ok(root);

  const sequentialStore = new MemoryStore();
  const sequential = new MerkleIndex(sequentialStore, "i");
  let expected: string | null = null;
  for (const [key, value] of entries)
    expected = await sequential.insert(expected, key, value);
  assert.equal(root, expected);

  for (const [key, value] of entries)
    assert.equal(await bulk.get(root, key), value);
  const written = bulkStore.puts.filter((key) => key.startsWith("i/"));
  const visited = new Set<string>();
  await bulk.visit(root, (node) => {
    visited.add(node);
  });
  assert.equal(visited.size, written.length);
  // Every write is reachable from the published root; no sequential
  // insertion roots are materialized as migration artifacts.
  assert.ok(written.length > 0);
});

test("bulk construction validates limits and duplicates before writing", async () => {
  const store = new CountingStore();
  const index = new MerkleIndex(store, "i");
  await assert.rejects(
    () =>
      index.buildFromEntries([
        [hash(1), hash(2)],
        [hash(1), hash(2)],
      ]),
    ConflictError,
  );
  await assert.rejects(
    () => index.buildFromEntries([[hash(1), hash(2)]], 0),
    LimitError,
  );
  await assert.rejects(
    () => index.buildFromEntries([[hash(1), "bad"]]),
    IntegrityError,
  );
  await assert.rejects(
    () =>
      index.buildFromEntries(
        [
          [hash(1), hash(2)],
          [hash(3), hash(4)],
        ],
        1,
      ),
    LimitError,
  );
  assert.deepEqual(store.puts, []);
  assert.equal(await index.buildFromEntries([]), null);
});

test("bulk construction reduces writes for realistic hashed request IDs", async () => {
  const entries: [string, string][] = [];
  for (let n = 0; n < 128; n++)
    entries.push([
      await digest(`request-id-${n.toString().padStart(4, "0")}`),
      await digest(`record-hash-${n.toString().padStart(4, "0")}`),
    ]);

  const sequentialStore = new CountingStore();
  const sequential = new MerkleIndex(sequentialStore, "i");
  let sequentialRoot: string | null = null;
  for (const [key, value] of entries)
    sequentialRoot = await sequential.insert(sequentialRoot, key, value);

  const bulkStore = new CountingStore();
  const bulk = new MerkleIndex(bulkStore, "i");
  const bulkRoot = await bulk.buildFromEntries(entries.slice().reverse());

  assert.equal(bulkRoot, sequentialRoot);
  assert.ok(bulkRoot);
  assert.equal(new Set(bulkStore.puts).size, bulkStore.puts.length);
  console.log(
    `realistic receipt index: sequential=${sequentialStore.puts.length} puts/${sequentialStore.putBytes} bytes, bulk=${bulkStore.puts.length} puts/${bulkStore.putBytes} bytes`,
  );
  assert.ok(bulkStore.puts.length < sequentialStore.puts.length);
  assert.ok(bulkStore.putBytes < sequentialStore.putBytes);
});
