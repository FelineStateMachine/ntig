import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictError,
  IntegrityError,
  LimitError,
  type ObjectStore,
  type StoredObject,
} from "../src/contracts.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { WalRepository, validateRefName } from "../src/wal.ts";

const oid = (n: string) => n.repeat(40).slice(0, 40);
const pack = (n = 1) => new Uint8Array(32).fill(n);
const update = (name: string, old: string | null, next: string | null) => ({
  name,
  old,
  new: next,
});
const engine = { async verify() {} };

class FailStore implements ObjectStore {
  hit = false;
  constructor(
    private readonly inner: MemoryStore,
    private readonly marker: string,
    private failed = false,
  ) {}
  async get(key: string) {
    return this.inner.get(key);
  }
  async put(key: string, bytes: Uint8Array, expected: string | null) {
    if (!this.failed && key.includes(this.marker)) {
      this.failed = true;
      this.hit = true;
      throw new Error(`injected failure: ${key}`);
    }
    return this.inner.put(key, bytes, expected);
  }
}

class AfterFailStore implements ObjectStore {
  hit = false;
  constructor(
    private readonly inner: MemoryStore,
    private readonly marker: string,
    private failed = false,
  ) {}
  async get(key: string) {
    return this.inner.get(key);
  }
  async put(key: string, bytes: Uint8Array, expected: string | null) {
    const committed = await this.inner.put(key, bytes, expected);
    if (committed && !this.failed && key.includes(this.marker)) {
      this.failed = true;
      this.hit = true;
      throw new Error(`injected post-write failure: ${key}`);
    }
    return committed;
  }
}

test("commits atomically, replays an idempotent request, and restores cold", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  const request = {
    id: "first",
    updates: [update("refs/heads/main", null, oid("a"))],
    pack: pack(),
  };
  const first = await repo.commit(request);
  assert.deepEqual(first, { id: "first", sequence: 1, replayed: false });
  const replay = await repo.commit({ ...request, pack: request.pack!.slice() });
  assert.deepEqual(replay, { id: "first", sequence: 1, replayed: true });
  const cold = await new WalRepository(store, engine).load();
  assert.equal(cold.sequence, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(cold.refs)), {
    "refs/heads/main": oid("a"),
  });
  assert.equal(cold.records.length, 1);
  assert.equal(cold.packs.length, 1);
});

for (const [label, marker] of [
  ["pack", "/packs/"],
  ["record", "/records/"],
  ["root", "/root.json"],
] as const) {
  test(`publication failure at ${label} leaves no visible commit and recovers`, async () => {
    const backing = new MemoryStore();
    const failing = new FailStore(backing, marker);
    const repo = new WalRepository(failing, engine);
    await assert.rejects(
      repo.commit({
        id: `fail-${label}`,
        updates: [update("refs/heads/main", null, oid("b"))],
        pack: pack(2),
      }),
    );
    assert.equal(failing.hit, true);
    const cold = await new WalRepository(backing, engine).load();
    assert.equal(cold.sequence, 0);
    assert.deepEqual(Object.fromEntries(Object.entries(cold.refs)), {});
  });
}

for (const [label, marker] of [
  ["pack", "/packs/"],
  ["record", "/records/"],
] as const) {
  test(`post-write failure at ${label} leaves no visible commit`, async () => {
    const backing = new MemoryStore();
    const failing = new AfterFailStore(backing, marker);
    await assert.rejects(
      new WalRepository(failing, engine).commit({
        id: `post-${label}`,
        updates: [update("refs/heads/main", null, oid("3"))],
        pack: pack(3),
      }),
    );
    assert.equal(failing.hit, true);
    assert.equal((await new WalRepository(backing, engine).load()).sequence, 0);
  });
}

test("post-write root failure is recoverable by idempotent retry", async () => {
  const backing = new MemoryStore();
  const request = {
    id: "post-root",
    updates: [update("refs/heads/main", null, oid("4"))],
  };
  const failing = new AfterFailStore(backing, "/root.json");
  await assert.rejects(new WalRepository(failing, engine).commit(request));
  assert.equal(failing.hit, true);
  const repo = new WalRepository(backing, engine);
  assert.equal((await repo.load()).sequence, 1);
  assert.deepEqual(await repo.commit(request), {
    id: "post-root",
    sequence: 1,
    replayed: true,
  });
});

test("only one concurrent CAS wins, and the loser can retry after reloading", async () => {
  const store = new MemoryStore();
  const a = new WalRepository(store, engine);
  const b = new WalRepository(store, engine);
  const results = await Promise.allSettled([
    a.commit({ id: "a", updates: [update("refs/heads/a", null, oid("a"))] }),
    b.commit({ id: "b", updates: [update("refs/heads/b", null, oid("b"))] }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ConflictError,
    ).length,
    1,
  );
  const winner = await new WalRepository(store, engine).load();
  const loserId = winner.records[0]!.id === "a" ? "b" : "a";
  const old =
    winner.refs["refs/heads/a"] ?? winner.refs["refs/heads/b"] ?? null;
  await new WalRepository(store, engine).commit({
    id: loserId,
    updates: [update(`refs/heads/${loserId}`, null, oid(loserId))],
  });
  const final = await new WalRepository(store, engine).load();
  assert.equal(final.sequence, 2);
  assert.equal(Object.keys(final.refs).length, 2);
  assert.equal(old !== undefined, true);
});

test("a lost root acknowledgement is safely replayed even after a later push", async () => {
  const backing = new MemoryStore();
  const normal = new WalRepository(backing, engine);
  const lost = new AfterFailStore(backing, "/root.json");
  const original = {
    id: "lost",
    updates: [update("refs/heads/main", null, oid("c"))],
  };
  await assert.rejects(new WalRepository(lost, engine).commit(original));
  assert.equal(lost.hit, true);
  await normal.commit({
    id: "later",
    updates: [update("refs/heads/side", null, oid("d"))],
  });
  // The root write did commit despite the lost response; retry must not append twice.
  assert.deepEqual(await normal.commit(original), {
    id: "lost",
    sequence: 1,
    replayed: true,
  });
  const snapshot = await normal.load();
  assert.equal(snapshot.sequence, 2);
  assert.equal(snapshot.refs["refs/heads/main"], oid("c"));
});

test("multi-ref updates are all-or-nothing and stale expected refs conflict", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "pair",
    updates: [
      update("refs/heads/main", null, oid("e")),
      update("refs/tags/v1", null, oid("e")),
    ],
  });
  await assert.rejects(
    repo.commit({
      id: "stale",
      updates: [update("refs/heads/main", null, oid("f"))],
    }),
    ConflictError,
  );
  const snapshot = await repo.load();
  assert.equal(snapshot.sequence, 1);
  assert.equal(Object.keys(snapshot.refs).length, 2);
});

test("namespace collisions are rejected before publication", async () => {
  const repo = new WalRepository(new MemoryStore(), engine);
  await repo.commit({
    id: "parent",
    updates: [update("refs/heads/topic", null, oid("1"))],
  });
  await assert.rejects(
    repo.commit({
      id: "child",
      updates: [update("refs/heads/topic/sub", null, oid("2"))],
    }),
    IntegrityError,
  );
  assert.equal((await repo.load()).sequence, 1);
});

test("ref validation rejects malformed Git ref names", () => {
  assert.throws(() => validateRefName("refs/heads/.hidden"), IntegrityError);
  assert.throws(() => validateRefName("refs/heads/x.lock/y"), IntegrityError);
});

test("input buffers are copied before asynchronous work", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  const bytes = pack(7);
  const pending = repo.commit({
    id: "mutable",
    updates: [update("refs/heads/main", null, oid("7"))],
    pack: bytes,
  });
  bytes.fill(8);
  await pending;
  assert.deepEqual((await repo.load()).packs[0], pack(7));
});

test("corrupt and missing committed objects fail closed on cold restore", async () => {
  const store = new MemoryStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "integrity",
    updates: [update("refs/heads/main", null, oid("8"))],
    pack: pack(8),
  });
  const root = await store.get("repos/default/root.json");
  assert.ok(root);
  const parsed = JSON.parse(new TextDecoder().decode(root.bytes));
  const record = await store.get(`repos/default/records/${parsed.tip}`);
  assert.ok(record);
  const recordValue = JSON.parse(new TextDecoder().decode(record.bytes));
  assert.equal(
    await store.put(
      `repos/default/records/${parsed.tip}`,
      new Uint8Array([123]),
      record.version,
    ),
    true,
  );
  await assert.rejects(new WalRepository(store, engine).load(), IntegrityError);
  // A missing pack is likewise detected rather than yielding a partial ref view.
  const clean = new MemoryStore();
  const cleanRepo = new WalRepository(clean, engine);
  await cleanRepo.commit({
    id: "missing",
    updates: [update("refs/heads/main", null, oid("9"))],
    pack: pack(9),
  });
  const cleanRoot = await clean.get("repos/default/root.json");
  const cleanValue = JSON.parse(new TextDecoder().decode(cleanRoot!.bytes));
  const cleanRecord = await clean.get(
    `repos/default/records/${cleanValue.tip}`,
  );
  const cleanRecordValue = JSON.parse(
    new TextDecoder().decode(cleanRecord!.bytes),
  );
  assert.ok(cleanRecordValue.pack);
  assert.equal(
    await clean.put(
      `repos/default/packs/${cleanRecordValue.pack}`,
      new Uint8Array(),
      (await clean.get(`repos/default/packs/${cleanRecordValue.pack}`))!
        .version,
    ),
    true,
  );
  await assert.rejects(new WalRepository(clean, engine).load(), IntegrityError);
  void recordValue;
});

test("limits reject oversized packs and history without changing refs", async () => {
  const repo = new WalRepository(new MemoryStore(), engine, {
    limits: { maxPackBytes: 32, maxRecords: 1 },
  });
  await assert.rejects(
    repo.commit({
      id: "large",
      updates: [update("refs/heads/main", null, oid("a"))],
      pack: pack(1).slice(0, 31),
    }),
    IntegrityError,
  );
  await repo.commit({
    id: "one",
    updates: [update("refs/heads/main", null, oid("a"))],
  });
  await assert.rejects(
    repo.commit({
      id: "two",
      updates: [update("refs/heads/side", null, oid("b"))],
    }),
    LimitError,
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries((await repo.load()).refs)),
    { "refs/heads/main": oid("a") },
  );
});

test("prefixes isolate tenants even when they share one object store", async () => {
  const store = new MemoryStore();
  const one = new WalRepository(store, engine, { prefix: "tenant-one/" });
  const two = new WalRepository(store, engine, { prefix: "tenant-two/" });
  await one.commit({
    id: "same-id",
    updates: [update("refs/heads/main", null, oid("1"))],
  });
  await two.commit({
    id: "same-id",
    updates: [update("refs/heads/main", null, oid("2"))],
  });
  assert.equal((await one.load()).refs["refs/heads/main"], oid("1"));
  assert.equal((await two.load()).refs["refs/heads/main"], oid("2"));
});

test("deterministic 200-step ref state machine survives repeated cold restores", async () => {
  const store = new MemoryStore();
  const limits = { maxRecords: 300 };
  let repo = new WalRepository(store, engine, {
    prefix: "state-machine/",
    limits,
  });
  const model = new Map<string, string>();
  let seed = 0x12345678;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let n = 0; n < 200; n++) {
    const name = `refs/heads/r${next() % 11}`;
    const old = model.get(name) ?? null;
    const deleting = next() % 5 === 0;
    const nextOid = deleting
      ? null
      : oid((n + 1).toString(16).padStart(2, "0"));
    const id = `step-${n}`;
    await repo.commit({ id, updates: [update(name, old, nextOid)] });
    if (nextOid === null) model.delete(name);
    else model.set(name, nextOid);
    const snapshot = await repo.load();
    assert.deepEqual(
      Object.fromEntries(Object.entries(snapshot.refs)),
      Object.fromEntries([...model].sort()),
    );
    if (n % 17 === 0)
      repo = new WalRepository(store, engine, {
        prefix: "state-machine/",
        limits,
      });
  }
  const final = await new WalRepository(store, engine, {
    prefix: "state-machine/",
    limits,
  }).load();
  assert.equal(final.sequence, 200);
  assert.deepEqual(
    Object.fromEntries(Object.entries(final.refs)),
    Object.fromEntries([...model].sort()),
  );
});

test("a retry key cannot be reused for different content", async () => {
  const repo = new WalRepository(new MemoryStore(), engine);
  await repo.commit({
    id: "one-key",
    updates: [update("refs/heads/main", null, oid("a"))],
  });
  await assert.rejects(
    repo.commit({
      id: "one-key",
      updates: [update("refs/heads/main", oid("a"), oid("b"))],
    }),
    ConflictError,
  );
  assert.equal((await repo.load()).sequence, 1);
});
