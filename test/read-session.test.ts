import assert from "node:assert/strict";
import test from "node:test";
import {
  ObjectReadSession,
  MemoryStore,
  WalRepository,
  NativeGitEngine,
  MeteredObjectStore,
  createAcceptedStateRepository,
  encodePack,
  decodePack,
  ConflictError,
  IntegrityError,
  RepositoryUnavailableError,
  type ObjectStore,
} from "../src/index.ts";

const prefix = "repos/default/";
const key = (n: number) =>
  `${prefix}records/${n.toString(16).padStart(64, "0")}`;
const enc = new TextEncoder();
class CountedStore implements ObjectStore {
  readonly inner = new MemoryStore();
  gets: string[] = [];
  putKeys: string[] = [];
  readBytes = 0;
  async get(key: string) {
    this.gets.push(key);
    const result = await this.inner.get(key);
    this.readBytes += result?.bytes.length ?? 0;
    return result;
  }
  put(key: string, bytes: Uint8Array, expected: string | null) {
    this.putKeys.push(key);
    return this.inner.put(key, bytes, expected);
  }
  reset() {
    this.gets = [];
    this.putKeys = [];
    this.readBytes = 0;
  }
}

test("read sessions reuse only exact immutable keys, never roots or other prefixes", async () => {
  const store = new CountedStore();
  const keys = [
    key(1),
    `${prefix}root.json`,
    "repos/other/records/" + "a".repeat(64),
    key(2) + "/suffix",
    `${prefix}other/` + "b".repeat(64),
  ];
  for (const path of keys) await store.put(path, enc.encode("data"), null);
  const session = new ObjectReadSession(store, { prefix });
  for (const path of keys) {
    await session.get(path);
    await session.get(path);
  }
  assert.equal(store.gets.length, 9);
  assert.deepEqual(session.stats, {
    hits: 1,
    misses: 9,
    entries: 1,
    retainedBytes: 4,
  });
  const first = await session.get(key(1));
  first!.bytes.fill(0);
  first!.version = "changed";
  assert.equal(
    new TextDecoder().decode((await session.get(key(1)))!.bytes),
    "data",
  );
  assert.notEqual((await session.get(key(1)))!.version, "changed");
});

test("read sessions use bounded LRU eviction and bypass oversized payloads", async () => {
  const store = new CountedStore();
  for (let n = 1; n <= 3; n++) await store.put(key(n), new Uint8Array(3), null);
  await store.put(key(4), new Uint8Array(7), null);
  const session = new ObjectReadSession(store, {
    prefix,
    maxBytes: 6,
    maxEntries: 2,
  });
  await session.get(key(1));
  await session.get(key(2));
  await session.get(key(1));
  await session.get(key(3)); // Evicts key 2, preserves recently read key 1.
  const count = store.gets.length;
  await session.get(key(1));
  assert.equal(store.gets.length, count);
  await session.get(key(2));
  assert.equal(store.gets.length, count + 1);
  await session.get(key(4));
  await session.get(key(4));
  assert.equal(session.stats.retainedBytes, 6);
  assert.equal(session.stats.entries, 2);
  assert.equal(store.gets.length, count + 3);
});

test("misses and backend errors never become cache hits", async () => {
  const store = new CountedStore();
  let fail = true;
  const session = new ObjectReadSession(
    {
      get: async (path) => {
        if (fail) throw new Error("backend");
        return store.get(path);
      },
      put: (path, bytes, expected) => store.put(path, bytes, expected),
    },
    { prefix },
  );
  await assert.rejects(session.get(key(1)), /backend/);
  fail = false;
  assert.equal(await session.get(key(1)), null);
  await store.put(key(1), new Uint8Array([7]), null);
  assert.equal((await session.get(key(1)))?.bytes[0], 7);
  assert.equal(session.stats.hits, 0);
});

test("all conditional writes reach inner accounting and invalidate cached reads", async () => {
  const store = new CountedStore();
  await store.put(key(1), new Uint8Array([1]), null);
  const events: string[] = [];
  const session = new ObjectReadSession(
    new MeteredObjectStore(store, (event) => {
      events.push(`${event.operation}:${event.outcome}`);
    }),
    { prefix },
  );
  const original = await session.get(key(1));
  assert.equal(await session.put(key(1), new Uint8Array([2]), null), false);
  const afterFalse = store.gets.length;
  await session.get(key(1));
  assert.equal(store.gets.length, afterFalse + 1);
  assert.equal(
    await session.put(key(1), new Uint8Array([3]), original!.version),
    true,
  );
  assert.equal((await session.get(key(1)))?.bytes[0], 3);
  assert.deepEqual(events, [
    "get:hit",
    "put:condition-failed",
    "get:hit",
    "put:committed",
    "get:hit",
  ]);
});

test("a lost write acknowledgement cannot leave an old cached object", async () => {
  const store = new CountedStore();
  await store.put(key(1), new Uint8Array([1]), null);
  const session = new ObjectReadSession(
    {
      get: (path) => store.get(path),
      put: async (path, bytes, expected) => {
        await store.put(path, bytes, expected);
        throw new Error("lost ack");
      },
    },
    { prefix },
  );
  const original = await session.get(key(1));
  await assert.rejects(
    session.put(key(1), new Uint8Array([9]), original!.version),
    /lost ack/,
  );
  assert.equal((await session.get(key(1)))?.bytes[0], 9);
});

test("in-flight old reads do not repopulate the cache after a write", async () => {
  const inner = new MemoryStore();
  await inner.put(key(1), new Uint8Array([1]), null);
  const old = (await inner.get(key(1)))!;
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const session = new ObjectReadSession(
    {
      get: async (path) => {
        const value = await inner.get(path);
        if (++reads === 1) {
          entered();
          await gate;
        }
        return value;
      },
      put: (path, bytes, expected) => inner.put(path, bytes, expected),
    },
    { prefix },
  );
  const inFlight = session.get(key(1));
  await started;
  await session.put(key(1), new Uint8Array([2]), old.version);
  unblock();
  assert.equal((await inFlight)?.bytes[0], 1); // Captured before the write, not a cache entry.
  assert.equal((await session.get(key(1)))?.bytes[0], 2);
  assert.equal(reads, 2);
});

test("closing during an in-flight read cannot repopulate retained payloads", async () => {
  const store = new CountedStore();
  await store.put(key(1), new Uint8Array([8]), null);
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const session = new ObjectReadSession(
    {
      get: async (path) => {
        const value = await store.get(path);
        entered();
        await gate;
        return value;
      },
      put: (path, bytes, expected) => store.put(path, bytes, expected),
    },
    { prefix },
  );
  const pending = session.get(key(1));
  await started;
  session.close();
  unblock();
  assert.equal((await pending)?.bytes[0], 8);
  assert.equal(session.stats.entries, 0);
  assert.equal(session.stats.retainedBytes, 0);
  await assert.rejects(session.get(key(1)), RepositoryUnavailableError);
});

test("nested session writes invalidate both child and parent caches", async () => {
  const store = new CountedStore();
  await store.put(key(1), new Uint8Array([1]), null);
  const parent = new ObjectReadSession(store, { prefix });
  const child = new ObjectReadSession(parent, { prefix });
  const original = (await child.get(key(1)))!;
  assert.equal(store.gets.length, 1);
  await child.put(key(1), new Uint8Array([2]), original.version);
  assert.equal((await child.get(key(1)))?.bytes[0], 2);
  assert.equal((await parent.get(key(1)))?.bytes[0], 2);
  assert.equal(store.gets.length, 2);
  child.close();
  assert.equal((await parent.get(key(1)))?.bytes[0], 2);
  parent.close();
});

test("closing a session releases memory and rejects subsequent operations", async () => {
  const store = new CountedStore();
  await store.put(key(1), new Uint8Array(8), null);
  const session = new ObjectReadSession(store, { prefix });
  await session.get(key(1));
  session.close();
  session.close();
  assert.equal(session.stats.entries, 0);
  assert.equal(session.stats.retainedBytes, 0);
  await assert.rejects(session.get(key(1)), RepositoryUnavailableError);
  await assert.rejects(
    session.put(key(1), new Uint8Array(), null),
    RepositoryUnavailableError,
  );
  for (const options of [
    { maxBytes: -1 },
    { maxEntries: NaN },
    { maxBytes: 1.5 },
  ])
    assert.throws(
      () => new ObjectReadSession(store, { prefix, ...options }),
      IntegrityError,
    );
  assert.throws(
    () => new ObjectReadSession(store, { prefix: "../unsafe/" }),
    IntegrityError,
  );
  const disabled = new ObjectReadSession(store, { prefix, maxBytes: 0 });
  await disabled.get(key(1));
  await disabled.get(key(1));
  assert.equal(disabled.stats.hits, 0);
});

test("WAL read-session lifetime, fresh roots and caller mutation remain safe", async () => {
  const store = new CountedStore();
  const wal = new WalRepository(store, new NativeGitEngine());
  await wal.checkpoint();
  let escaped!: WalRepository;
  await wal.withReadSession(async (scoped) => {
    escaped = scoped;
    assert.equal((await scoped.load()).sequence, 0);
    await wal.commit({
      id: "external",
      updates: [{ name: "refs/heads/absent", old: null, new: null }],
    });
    assert.equal((await scoped.load()).sequence, 1);
    const snapshot = await scoped.load();
    snapshot.refs["refs/heads/invented"] = "a".repeat(40);
    assert.equal(
      (await scoped.loadRefs()).refs["refs/heads/invented"],
      undefined,
    );
  });
  await assert.rejects(escaped.load(), RepositoryUnavailableError);
  await assert.rejects(
    wal.withReadSession(async (scoped) => {
      escaped = scoped;
      throw new Error("caller failed");
    }),
    /caller failed/,
  );
  await assert.rejects(escaped.loadRefs(), RepositoryUnavailableError);
  assert.equal((await wal.load()).sequence, 1);
});

test("cached reads do not weaken immutable integrity checks or poison the next session", async () => {
  const store = new CountedStore();
  const wal = new WalRepository(store, new NativeGitEngine());
  await wal.checkpoint();
  const snapshot = await wal.load();
  const path = `${prefix}manifests/${snapshot.checkpoint!.manifestHash}`;
  const stored = (await store.inner.get(path))!;
  await store.inner.put(path, enc.encode("corrupt"), stored.version);
  await assert.rejects(
    wal.withReadSession((scoped) => scoped.loadRefs()),
    IntegrityError,
  );
  const corrupt = (await store.inner.get(path))!;
  await store.inner.put(path, stored.bytes, corrupt.version);
  assert.equal(
    (await wal.withReadSession((scoped) => scoped.loadRefs())).sequence,
    0,
  );
});

test("scoped hidden-PR retry reduces backend reads without dropping validation or authority", async () => {
  const store = new CountedStore();
  let validations = 0;
  const native = new NativeGitEngine();
  const wal = new WalRepository(store, {
    verify: async (packs, refs) => {
      validations++;
      await native.verify(packs, refs);
    },
  });
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const pack = await encodePack([
    { type: "tree", data: new Uint8Array() },
    ...[1, 2].map((n) => ({
      type: "commit" as const,
      data: enc.encode(
        `tree ${tree}\nauthor A <a@b> ${n} +0000\ncommitter A <a@b> ${n} +0000\n\n${n}\n`,
      ),
    })),
  ]);
  const commits = (await decodePack(pack)).filter((o) => o.type === "commit");
  const first = commits[0]!.oid,
    second = commits[1]!.oid;
  const pr = "refs/nostr/" + "a".repeat(64);
  await wal.commit({
    id: "seed",
    pack,
    updates: [
      { name: "refs/heads/main", old: null, new: first },
      { name: pr, old: null, new: first },
    ],
  });
  let authority = second;
  let lookups = 0;
  const authorized = (repo: WalRepository) =>
    createAcceptedStateRepository(repo, {
      lookupState: async () => {
        lookups++;
        return null;
      },
      lookupPrTip: async () => authority,
    });
  const correction = {
    id: "correction",
    updates: [{ name: pr, old: null, new: second }],
  };
  const receipt = await authorized(wal).commit(correction);
  await wal.checkpoint();
  for (let n = 0; n < 130; n++)
    await wal.commit({
      id: `later-${n}`,
      updates: [{ name: `refs/tags/t${n}`, old: null, new: first }],
    });
  store.reset();
  validations = 0;
  assert.deepEqual(await authorized(wal).commit(correction), {
    ...receipt,
    replayed: true,
  });
  const baseline = {
    gets: store.gets.length,
    bytes: store.readBytes,
    validations,
  };
  store.reset();
  validations = 0;
  await wal.withReadSession(async (scoped) => {
    assert.deepEqual(await authorized(scoped).commit(correction), {
      ...receipt,
      replayed: true,
    });
    assert.equal(store.putKeys.length, 0);
    assert.equal(
      validations,
      baseline.validations,
      "cached bytes still pass all Git verification",
    );
    assert.ok(store.gets.length < baseline.gets);
    const measured = {
      gets: store.gets.length,
      bytes: store.readBytes,
      validations,
    };
    console.log(
      JSON.stringify({ readSessionRetry: { baseline, cached: measured } }),
    );
    const before = lookups;
    authority = first;
    await assert.rejects(authorized(scoped).commit(correction), /authorized/);
    assert.equal(lookups, before + 1, "authority is never cached");
    authority = second;
    await assert.rejects(
      authorized(scoped).commit({ ...correction, pack: new Uint8Array(32) }),
      ConflictError,
    );
  });
  store.reset();
  await wal.withReadSession(async (scoped) => {
    await scoped.loadRefs();
  });
  assert.equal(
    store.gets.length,
    2,
    "fresh metadata advertisements still use two GETs",
  );
  assert.equal((await wal.load()).sequence, 132);
});
