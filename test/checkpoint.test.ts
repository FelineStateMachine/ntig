import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictError,
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
  type GitEngine,
  type ObjectStore,
  type StoredObject,
} from "../src/contracts.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { WalRepository, sha256 } from "../src/wal.ts";
import { requestHash } from "../src/wal-format.ts";

const encoder = new TextEncoder();
const oid = (n: number) => n.toString(16).padStart(40, "0");
const update = (name: string, old: string | null, next: string | null) => ({
  name,
  old,
  new: next,
});
const engine: GitEngine = { async verify() {} };

class CountingStore implements ObjectStore {
  gets = 0;
  puts = 0;
  readonly putKeys: string[] = [];
  constructor(readonly inner = new MemoryStore()) {}
  async get(key: string): Promise<StoredObject | null> {
    this.gets++;
    return this.inner.get(key);
  }
  async put(key: string, bytes: Uint8Array, expected: string | null) {
    this.puts++;
    this.putKeys.push(key);
    return this.inner.put(key, bytes, expected);
  }
}

class FailingStore implements ObjectStore {
  hit = false;
  private failed = false;
  constructor(
    readonly inner: MemoryStore,
    private readonly marker: string,
    private readonly after = false,
  ) {}
  async get(key: string) {
    return this.inner.get(key);
  }
  async put(key: string, bytes: Uint8Array, expected: string | null) {
    if (!this.after && !this.failed && key.includes(this.marker)) {
      this.failed = this.hit = true;
      throw new Error(`injected failure at ${key}`);
    }
    const committed = await this.inner.put(key, bytes, expected);
    if (this.after && committed && !this.failed && key.includes(this.marker)) {
      this.failed = this.hit = true;
      throw new Error(`injected post-write failure at ${key}`);
    }
    return committed;
  }
}

async function migrate(repo: WalRepository) {
  const result = await repo.checkpoint();
  assert.equal(result.changed, true);
  return result.sequence;
}

test("explicitly migrates empty and non-empty repositories", async () => {
  const emptyStore = new MemoryStore();
  const empty = new WalRepository(emptyStore, engine);
  assert.deepEqual(await empty.checkpoint(), { sequence: 0, changed: true });
  const emptySnapshot = await new WalRepository(emptyStore, engine).load();
  assert.equal(emptySnapshot.checkpoint?.manifestHash.length, 64);
  assert.equal(emptySnapshot.checkpoint?.receiptRoot, null);
  assert.equal(emptySnapshot.records.length, 0);

  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "before-checkpoint",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(repo);
  const snapshot = await new WalRepository(store, engine).load();
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.tip !== null, true);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.checkpoint?.packIds.length, 0);
  assert.deepEqual(await repo.checkpoint(), { sequence: 1, changed: false });
});

test("migration preserves legacy record bytes and does not republish them", async () => {
  const counted = new CountingStore();
  const repo = new WalRepository(counted, engine);
  await repo.commit({
    id: "byte-preserving",
    updates: [update("refs/heads/main", null, oid(7))],
  });
  const writesBeforeMigration = counted.puts;
  await migrate(repo);
  const migrationWrites = counted.puts - writesBeforeMigration;
  assert.equal(migrationWrites > 0, true);
  // A legacy record is already content-addressed; migration may publish its
  // receipt index and manifest, but must never rewrite records/<hash> bytes.
  assert.equal(
    counted.putKeys
      .slice(-migrationWrites)
      .some((key) => key.includes("/records/")),
    false,
  );
});

test("migration accepts a legacy record with reordered properties and whitespace", async () => {
  const store = new MemoryStore();
  const updates = [update("refs/heads/main", null, oid(8))];
  const requestDigest = await requestHash("manual-legacy", updates, null);
  const legacyRecord = {
    updates,
    requestHash: requestDigest,
    id: "manual-legacy",
    pack: null,
    parent: null,
    sequence: 1,
    format: 1,
  };
  const recordBytes = encoder.encode(
    ` {\n  ${JSON.stringify(legacyRecord).slice(1, -1)}\n } `,
  );
  const recordHash = await sha256(recordBytes);
  await store.put("repos/default/records/" + recordHash, recordBytes, null);
  await store.put(
    "repos/default/root.json",
    encoder.encode(JSON.stringify({ tip: recordHash, format: 1, sequence: 1 })),
    null,
  );
  const repo = new WalRepository(store, engine);
  assert.equal((await repo.load()).records[0]?.id, "manual-legacy");
  await migrate(repo);
  assert.equal((await repo.lookupRecord("manual-legacy"))?.sequence, 1);
  assert.deepEqual(await repo.commit({ id: "manual-legacy", updates }), {
    id: "manual-legacy",
    sequence: 1,
    replayed: true,
  });
});

test("checkpointed repositories continue past 128 ref-only commits", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "seed",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(repo);
  for (let n = 2; n <= 150; n++)
    await repo.commit({
      id: `ref-${n}`,
      updates: [update(`refs/heads/ref-${n}`, null, oid(n))],
    });
  const cold = await new WalRepository(store, engine).load();
  assert.equal(cold.sequence, 150);
  assert.equal(cold.records.length, 1);
  assert.equal(cold.records[0]?.sequence, 150);
  assert.equal(Object.keys(cold.refs).length, 150);
});

test("old receipts replay after a cold restore without replaying history", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  const original = {
    id: "old-receipt",
    updates: [update("refs/heads/main", null, oid(1))],
  };
  await repo.commit(original);
  await migrate(repo);
  for (let n = 2; n <= 140; n++)
    await repo.commit({
      id: `later-${n}`,
      updates: [update(`refs/heads/r${n}`, null, oid(n))],
    });
  const cold = new WalRepository(store, engine);
  const record = await cold.lookupRecord("old-receipt");
  assert.equal(record?.id, "old-receipt");
  assert.equal(record?.sequence, 1);
  assert.deepEqual(await cold.commit(original), {
    id: "old-receipt",
    sequence: 1,
    replayed: true,
  });
});

test("corruption in an older receipt-index node is not treated as a miss", async () => {
  const backing = new MemoryStore();
  const repo = new WalRepository(backing, engine);
  const original = {
    id: "indexed-old",
    updates: [update("refs/heads/main", null, oid(1))],
  };
  await repo.commit(original);
  await migrate(repo);
  for (let n = 2; n <= 90; n++)
    await repo.commit({
      id: `index-fill-${n}`,
      updates: [update(`refs/heads/r${n}`, null, oid(n))],
    });
  const reads: string[] = [];
  const tracing: ObjectStore = {
    get: async (key) => {
      reads.push(key);
      return backing.get(key);
    },
    put: (key, bytes, expected) => backing.put(key, bytes, expected),
  };
  const observed = new WalRepository(tracing, engine);
  await observed.load();
  const tipPath = new Set(reads);
  reads.length = 0;
  await observed.lookupRecord(original.id);
  const olderNode = reads.find(
    (key) => key.includes("/receipt-index/") && !tipPath.has(key),
  );
  assert.ok(
    olderNode,
    "old receipt has a distinct index path from current tip",
  );
  for (const missing of [true, false]) {
    const corrupted = new WalRepository(
      {
        get: async (key) =>
          key === olderNode
            ? missing
              ? null
              : { bytes: encoder.encode("bad"), version: "corrupt" }
            : backing.get(key),
        put: (key, bytes, expected) => backing.put(key, bytes, expected),
      },
      engine,
    );
    assert.equal(
      (await corrupted.load()).sequence,
      90,
      "unrelated receipt branches are lazy",
    );
    await assert.rejects(
      () => corrupted.lookupRecord(original.id),
      IntegrityError,
    );
    await assert.rejects(
      () => corrupted.commit(original),
      RepositoryUnavailableError,
    );
    assert.equal((await repo.load()).sequence, 90);
  }
});

test("a checkpoint receipt ID cannot be reused for different content", async () => {
  const repo = new WalRepository(new MemoryStore(), engine);
  await repo.commit({
    id: "same-id",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(repo);
  await assert.rejects(
    repo.commit({
      id: "same-id",
      updates: [update("refs/heads/main", oid(1), oid(2))],
    }),
    ConflictError,
  );
});

for (const marker of ["/records/", "/manifests/", "/root.json"]) {
  test(`checkpoint publication failure at ${marker} never exposes a partial commit`, async () => {
    const backing = new MemoryStore();
    const normal = new WalRepository(backing, engine);
    await normal.commit({
      id: `seed-${marker.replaceAll("/", "")}`,
      updates: [update("refs/heads/main", null, oid(1))],
    });
    await migrate(normal);
    const failing = new FailingStore(backing, marker);
    const repo = new WalRepository(failing, engine);
    await assert.rejects(
      repo.commit({
        id: `failed-${marker.replaceAll("/", "")}`,
        updates: [update("refs/heads/side", null, oid(2))],
      }),
    );
    assert.equal(failing.hit, true);
    const cold = await new WalRepository(backing, engine).load();
    assert.equal(cold.sequence, 1);
    assert.equal(cold.refs["refs/heads/side"], undefined);
  });
}

for (const after of [false, true]) {
  for (const marker of ["/receipt-index/", "/manifests/", "/root.json"]) {
    test(`migration ${after ? "post" : "pre"}-write failure at ${marker} recovers the legacy root`, async () => {
      const backing = new MemoryStore();
      const seed = new WalRepository(backing, engine);
      await seed.commit({
        id: `migration-failure-${after ? "post" : "pre"}-${marker.replaceAll("/", "")}`,
        updates: [update("refs/heads/main", null, oid(3))],
        pack: new Uint8Array(32).fill(3),
      });
      const failing = new FailingStore(backing, marker, after);
      const repo = new WalRepository(failing, engine);
      await assert.rejects(repo.checkpoint());
      assert.equal(failing.hit, true);
      const restored = new WalRepository(backing, engine);
      const snapshot = await restored.load();
      assert.equal(snapshot.refs["refs/heads/main"], oid(3));
      if (marker === "/root.json" && after) {
        assert.equal(snapshot.sequence, 1);
        assert.equal(snapshot.checkpoint !== undefined, true);
        assert.deepEqual(await restored.checkpoint(), {
          sequence: 1,
          changed: false,
        });
      } else {
        assert.equal(snapshot.sequence, 1);
        assert.equal(snapshot.checkpoint, undefined);
      }
    });
  }
}

for (const after of [false, true]) {
  for (const marker of ["/packs/", "/receipt-index/"]) {
    test(`checkpoint commit ${after ? "post" : "pre"}-write failure at ${marker} leaves the prior root valid`, async () => {
      const backing = new MemoryStore();
      const seed = new WalRepository(backing, engine);
      const suffix = marker.replaceAll("/", "");
      await seed.commit({
        id: `pack-failure-seed-${after}-${suffix}`,
        updates: [update("refs/heads/main", null, oid(5))],
      });
      await migrate(seed);
      const failing = new FailingStore(backing, marker, after);
      const request = {
        id: `pack-failure-${after}-${suffix}`,
        updates: [update("refs/heads/side", null, oid(6))],
        pack: new Uint8Array(32).fill(6),
      };
      await assert.rejects(new WalRepository(failing, engine).commit(request));
      assert.equal(failing.hit, true);
      const snapshot = await new WalRepository(backing, engine).load();
      assert.equal(snapshot.sequence, 1);
      assert.equal(snapshot.refs["refs/heads/side"], undefined);
    });
  }
}

for (const marker of ["/records/", "/manifests/"]) {
  test(`post-write checkpoint failure at ${marker} keeps the old root authoritative`, async () => {
    const backing = new MemoryStore();
    const normal = new WalRepository(backing, engine);
    await normal.commit({
      id: `post-seed-${marker.replaceAll("/", "")}`,
      updates: [update("refs/heads/main", null, oid(1))],
    });
    await migrate(normal);
    const failing = new FailingStore(backing, marker, true);
    await assert.rejects(
      new WalRepository(failing, engine).commit({
        id: `post-failed-${marker.replaceAll("/", "")}`,
        updates: [update("refs/heads/side", null, oid(2))],
      }),
    );
    assert.equal(failing.hit, true);
    const cold = await new WalRepository(backing, engine).load();
    assert.equal(cold.sequence, 1);
    assert.equal(cold.refs["refs/heads/side"], undefined);
  });
}

test("post-write root failure is recoverable through indexed checkpoint replay", async () => {
  const backing = new MemoryStore();
  const normal = new WalRepository(backing, engine);
  await normal.commit({
    id: "post-root-seed",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(normal);
  const request = {
    id: "post-root-checkpoint",
    updates: [update("refs/heads/side", null, oid(2))],
  };
  const failing = new FailingStore(backing, "/root.json", true);
  await assert.rejects(new WalRepository(failing, engine).commit(request));
  assert.equal(failing.hit, true);
  const repo = new WalRepository(backing, engine);
  assert.equal((await repo.load()).sequence, 2);
  assert.deepEqual(await repo.commit(request), {
    id: request.id,
    sequence: 2,
    replayed: true,
  });
});

test("concurrent migration and a legacy commit leave one valid authoritative root", async () => {
  const store = new MemoryStore();
  const first = new WalRepository(store, engine);
  await first.commit({
    id: "seed-concurrent",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  const migration = new WalRepository(store, engine).checkpoint();
  const legacyCommit = new WalRepository(store, engine).commit({
    id: "racing-legacy",
    updates: [update("refs/heads/side", null, oid(2))],
  });
  const results = await Promise.allSettled([migration, legacyCommit]);
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length >= 1,
    true,
  );
  const cold = await new WalRepository(store, engine).load();
  assert.equal(cold.sequence === 1 || cold.sequence === 2, true);
  assert.equal(cold.refs["refs/heads/main"], oid(1));
  if (cold.sequence === 2) assert.equal(cold.refs["refs/heads/side"], oid(2));
});

test("concurrent checkpointed commits with one ID return one original and one replay", async () => {
  const store = new MemoryStore();
  const setup = new WalRepository(store, engine);
  await setup.commit({
    id: "seed-same-id",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(setup);
  const request = {
    id: "concurrent-id",
    updates: [update("refs/heads/side", null, oid(2))],
  };
  const results = await Promise.all([
    new WalRepository(store, engine).commit(request),
    new WalRepository(store, engine).commit(request),
  ]);
  assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]);
  assert.equal((await new WalRepository(store, engine).load()).sequence, 2);
});

test("aggregate packed-byte limits are enforced before checkpoint publication", async () => {
  const store = new MemoryStore();
  const verifying: GitEngine = {
    async verify(packs) {
      assert.equal(
        packs.reduce((sum, item) => sum + item.length, 0) <= 63,
        true,
      );
    },
  };
  const repo = new WalRepository(store, verifying, {
    limits: { maxPackBytes: 40, maxTotalPackBytes: 63 },
  });
  const pack = (n: number) => new Uint8Array(32).fill(n);
  await repo.commit({
    id: "pack-one",
    updates: [update("refs/heads/main", null, oid(1))],
    pack: pack(1),
  });
  await migrate(repo);
  await assert.rejects(
    repo.commit({
      id: "pack-two",
      updates: [update("refs/heads/side", null, oid(2))],
      pack: pack(2),
    }),
    LimitError,
  );
  assert.equal((await new WalRepository(store, verifying).load()).sequence, 1);
});

test("missing or corrupt checkpoint manifests and receipt nodes fail closed", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "corruption",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(repo);
  const root = await store.get("repos/default/root.json");
  assert.ok(root);
  const rootValue = JSON.parse(new TextDecoder().decode(root.bytes)) as {
    manifest: string;
  };
  const manifest = await store.get(
    `repos/default/manifests/${rootValue.manifest}`,
  );
  assert.ok(manifest);
  const manifestValue = JSON.parse(
    new TextDecoder().decode(manifest.bytes),
  ) as {
    receipts: string;
  };
  await store.put(
    `repos/default/manifests/${rootValue.manifest}`,
    encoder.encode("{}"),
    manifest.version,
  );
  await assert.rejects(
    () => new WalRepository(store, engine).load(),
    IntegrityError,
  );

  const fresh = new MemoryStore();
  const healthy = new WalRepository(fresh, engine);
  await healthy.commit({
    id: "missing-index",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(healthy);
  const goodRoot = await fresh.get("repos/default/root.json");
  assert.ok(goodRoot);
  const goodValue = JSON.parse(new TextDecoder().decode(goodRoot.bytes)) as {
    manifest: string;
  };
  const goodManifest = await fresh.get(
    `repos/default/manifests/${goodValue.manifest}`,
  );
  assert.ok(goodManifest);
  const goodManifestValue = JSON.parse(
    new TextDecoder().decode(goodManifest.bytes),
  ) as { receipts: string };
  assert.equal(typeof goodManifestValue.receipts, "string");
  const indexNode = await fresh.get(
    `repos/default/receipt-index/${goodManifestValue.receipts}`,
  );
  assert.ok(indexNode);
  await fresh.put(
    `repos/default/receipt-index/${goodManifestValue.receipts}`,
    encoder.encode("bad"),
    indexNode.version,
  );
  await assert.rejects(
    () => new WalRepository(fresh, engine).lookupRecord("missing-index"),
    IntegrityError,
  );
});

test("checkpoint cold-load reads stay bounded as receipt history grows", async () => {
  const counted = new CountingStore();
  const repo = new WalRepository(counted, engine);
  await repo.commit({
    id: "bounded-seed",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(repo);
  for (let n = 2; n <= 180; n++)
    await repo.commit({
      id: `bounded-${n}`,
      updates: [update(`refs/heads/bounded-${n}`, null, oid(n))],
    });
  counted.gets = 0;
  const cold = await new WalRepository(counted, engine).load();
  assert.equal(cold.sequence, 180);
  assert.equal(counted.gets <= 5, true);
});

test("metadata-only loadRefs reads exactly root and manifest, never packs", async () => {
  const counted = new CountingStore();
  const repo = new WalRepository(counted, engine);
  await repo.commit({
    id: "refs-only-view",
    updates: [update("refs/heads/main", null, oid(1))],
    pack: new Uint8Array(32).fill(4),
  });
  await migrate(repo);
  counted.gets = 0;
  const refs = await new WalRepository(counted, engine).loadRefs();
  assert.equal(refs.sequence, 1);
  assert.equal(refs.refs["refs/heads/main"], oid(1));
  assert.equal(counted.gets, 2);
});

test("checkpointed receipt IDs remain isolated by repository prefix", async () => {
  const store = new MemoryStore();
  const a = new WalRepository(store, engine, { prefix: "repos/a/" });
  const b = new WalRepository(store, engine, { prefix: "repos/b/" });
  await a.commit({
    id: "same",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await b.commit({
    id: "same",
    updates: [update("refs/heads/main", null, oid(2))],
  });
  await migrate(a);
  await migrate(b);
  assert.equal((await a.lookupRecord("same"))?.updates[0]?.new, oid(1));
  assert.equal((await b.lookupRecord("same"))?.updates[0]?.new, oid(2));
});

test("checkpoint metadata hashes are stable and use canonical JSON", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "hash",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  await migrate(repo);
  const root = await store.get("repos/default/root.json");
  assert.ok(root);
  const value = JSON.parse(new TextDecoder().decode(root.bytes)) as {
    manifest: string;
  };
  const manifest = await store.get(`repos/default/manifests/${value.manifest}`);
  assert.ok(manifest);
  assert.equal(await sha256(manifest.bytes), value.manifest);
});
