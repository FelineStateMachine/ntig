import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryStore,
  NativeGitEngine,
  WalRepository,
  LimitError,
  type ObjectStore,
} from "../src/index.ts";

/** Test-only model of a host's serialized, per-key reservation ledger; not production billing. */
class ReservedStore implements ObjectStore {
  readonly inner = new MemoryStore();
  readonly reserved = new Map<string, number>();
  readonly physical = new Map<string, number>();
  maxBytes = Number.MAX_SAFE_INTEGER;
  maxObjects = Number.MAX_SAFE_INTEGER;
  attempts = 0;
  fault: "none" | "before-manifest" | "after-manifest" = "none";
  get bytes() {
    return [...this.reserved.values()].reduce((sum, n) => sum + n, 0);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async put(key: string, bytes: Uint8Array, expected: string | null) {
    this.attempts++;
    const old = this.reserved.get(key) ?? 0;
    const increase = Math.max(0, bytes.length - old);
    if (
      this.bytes + increase > this.maxBytes ||
      this.reserved.size + Number(!this.reserved.has(key)) > this.maxObjects
    )
      throw new LimitError("Host retained metadata budget exceeded");
    this.reserved.set(key, Math.max(old, bytes.length));
    if (this.fault === "before-manifest" && key.includes("/manifests/"))
      throw new Error("unknown manifest result");
    const stored = await this.inner.put(key, bytes, expected);
    if (stored) this.physical.set(key, bytes.length);
    if (this.fault === "after-manifest" && key.includes("/manifests/"))
      throw new Error("unknown manifest result");
    if (stored) this.reserved.set(key, bytes.length);
    else {
      const actual = await this.inner.get(key);
      if (actual) this.reserved.set(key, actual.bytes.length);
      else this.reserved.delete(key);
    }
    return stored;
  }
}
const request = (id: string) => ({
  id,
  updates: [{ name: "refs/heads/absent", old: null, new: null }],
});

async function fixture() {
  const store = new ReservedStore();
  const wal = new WalRepository(store, new NativeGitEngine());
  await wal.commit(request("first"));
  await wal.checkpoint();
  return { store, wal };
}

test("metadata consumes host capacity even with no packs; indexed retries still work at quota", async () => {
  const { store, wal } = await fixture();
  await wal.commit(request("second"));
  assert.equal(
    [...store.reserved.keys()].some((key) => key.includes("/packs/")),
    false,
  );
  assert.ok(
    [...store.reserved.keys()].some((key) => key.includes("/manifests/")),
  );
  assert.ok(
    [...store.reserved.keys()].some((key) => key.includes("/receipt-index/")),
  );
  store.maxBytes = store.bytes;
  store.maxObjects = store.reserved.size;
  const attempts = store.attempts;
  assert.deepEqual(
    await wal.withReadSession((scoped) => scoped.commit(request("first"))),
    { id: "first", sequence: 1, replayed: true },
  );
  assert.equal(
    store.attempts,
    attempts,
    "committed replay needs no new reservation or PUT",
  );
  await assert.rejects(
    wal.withReadSession((scoped) => scoped.commit(request("third"))),
    LimitError,
  );
  assert.equal((await wal.load()).sequence, 2);
  assert.equal(await wal.lookupRecord("third"), null);
  assert.equal(store.bytes, store.maxBytes);
});

test("mid-publication quota failure keeps the root unchanged and counts orphan records", async () => {
  const { store, wal } = await fixture();
  const before = store.reserved.size;
  store.maxObjects = before + 1; // One new record fits, its new index node does not.
  await assert.rejects(
    wal.withReadSession((scoped) => scoped.commit(request("limited"))),
    LimitError,
  );
  assert.equal(store.reserved.size, before + 1);
  assert.equal(store.physical.size, before + 1);
  assert.equal((await wal.load()).sequence, 1);
  assert.equal(await wal.lookupRecord("limited"), null);
  store.maxObjects = Number.MAX_SAFE_INTEGER;
  assert.equal((await wal.commit(request("limited"))).sequence, 2);
  assert.equal(
    [...store.physical.keys()].filter((key) => key.includes("/records/"))
      .length,
    2,
    "retry reuses the immutable orphan record",
  );
});

for (const fault of ["before-manifest", "after-manifest"] as const) {
  test(`ambiguous ${fault} writes retain conservative reservations through a read session`, async () => {
    const { store, wal } = await fixture();
    store.fault = fault;
    await assert.rejects(
      wal.withReadSession((scoped) => scoped.commit(request("uncertain"))),
      /unknown manifest result/,
    );
    assert.equal((await wal.load()).sequence, 1);
    assert.equal(await wal.lookupRecord("uncertain"), null);
    const physicalBytes = [...store.physical.values()].reduce(
      (sum, n) => sum + n,
      0,
    );
    assert.ok(store.bytes >= physicalBytes);
    if (fault === "before-manifest")
      assert.ok(
        store.bytes > physicalBytes,
        "phantom reservation is not silently released",
      );
    else
      assert.equal(
        store.bytes,
        physicalBytes,
        "persisted orphan metadata is accounted",
      );
    store.fault = "none";
    assert.equal((await wal.commit(request("uncertain"))).sequence, 2);
    assert.equal(
      store.bytes,
      [...store.physical.values()].reduce((sum, n) => sum + n, 0),
    );
  });
}
