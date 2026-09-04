import assert from "node:assert/strict";
import test from "node:test";
import {
  IntegrityError,
  LimitError,
  type ObjectStore,
  type StoredObject,
} from "../src/contracts.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { NativeGitEngine } from "../src/git/engine.ts";
import { WalRepository } from "../src/wal.ts";
import {
  boundedInventory as inspect,
  type InventoryLimits,
  type InventoryListing,
  type ListedObject,
} from "../src/inventory.ts";

// Preserve the original proof-fixture calls while exercising the public options API.
const boundedInventory = (
  source: Pick<ObjectStore, "get">,
  pages: InventoryListing,
  limits: Partial<InventoryLimits> = {},
) => inspect(source, pages, { limits });

class InventoryStore implements ObjectStore {
  readonly inner = new MemoryStore();
  readonly objects = new Map<string, Uint8Array>();
  writes = 0;
  async get(key: string): Promise<StoredObject | null> {
    return this.inner.get(key);
  }
  async put(
    key: string,
    bytes: Uint8Array,
    expected: string | null,
  ): Promise<boolean> {
    this.writes++;
    const ok = await this.inner.put(key, bytes, expected);
    if (ok) this.objects.set(key, bytes.slice());
    return ok;
  }
}

function listing(
  store: InventoryStore,
  mode: "good" | "duplicate" | "outside" | "cursor" = "good",
): InventoryListing {
  return {
    async list(prefix, cursor) {
      if (mode === "cursor") return { keys: [], cursor: cursor ?? "same" };
      const all: ListedObject[] = [...store.objects].map(([key, bytes]) => ({
        key,
        size: bytes.length,
      }));
      if (mode === "outside") all.push({ key: "other/root.json", size: 1 });
      if (mode === "duplicate" && all[0]) all.push(all[0]);
      if (cursor !== null) return { keys: [], cursor: null };
      return { keys: all, cursor: null };
    },
  };
}

async function fixture() {
  const store = new InventoryStore();
  const wal = new WalRepository(store, new NativeGitEngine());
  await wal.commit({
    id: "seed",
    updates: [{ name: "refs/heads/main", old: null, new: null }],
  });
  await wal.checkpoint();
  return { store, wal };
}

test("bounded inventory is read-only and reports an empty v2 repository", async () => {
  const store = new InventoryStore();
  const wal = new WalRepository(store, new NativeGitEngine());
  await wal.checkpoint();
  const report = await boundedInventory(store, listing(store));
  assert.equal(report.format, 2);
  assert.equal(report.sequence, 0);
  assert.equal(report.unreferenced.keys, 0);
  assert.equal(report.authority, false);
  assert.equal(report.gcCandidate, false);
  assert.equal(store.writes, 2);
});

test("every inventory budget is enforced and no excess provider call starts", async (t) => {
  const { store } = await fixture();
  for (const name of [
    "maxGets",
    "maxReadBytes",
    "maxObjectBytes",
    "maxListedKeys",
    "maxPages",
    "maxIndexNodes",
    "maxReceipts",
    "maxKeyBytes",
  ] as const) {
    await t.test(name, async () => {
      let gets = 0;
      let pages = 0;
      const before = store.writes;
      const source = {
        get: (key: string) => {
          gets++;
          return store.get(key);
        },
      };
      const entries = listing(store);
      const pagesSource: InventoryListing = {
        list: (prefix, cursor) => {
          pages++;
          return entries.list(prefix, cursor);
        },
      };
      await assert.rejects(
        boundedInventory(source, pagesSource, { [name]: 0 }),
        LimitError,
      );
      if (name === "maxGets" || name === "maxKeyBytes") assert.equal(gets, 0);
      if (name === "maxPages") assert.equal(pages, 0);
      if (name === "maxReadBytes" || name === "maxObjectBytes")
        assert.equal(gets, 1);
      assert.equal(store.writes, before);
    });
  }
  for (const value of [-1, NaN, Infinity, 0.5])
    await assert.rejects(
      boundedInventory(store, listing(store), { maxGets: value }),
      IntegrityError,
    );
  let gets = 0;
  await assert.rejects(
    boundedInventory(
      {
        get: (key) => {
          gets++;
          return store.get(key);
        },
      },
      listing(store),
      { maxGets: 2 },
    ),
    LimitError,
  );
  assert.equal(gets, 2);
  let cursorPages = 0;
  await assert.rejects(
    boundedInventory(
      store,
      {
        list: async () => {
          cursorPages++;
          return { keys: [], cursor: "next" };
        },
      },
      { maxCursorBytes: 0 },
    ),
    LimitError,
  );
  assert.equal(cursorPages, 1);
});

test("successful pagination separates exact known keys from nested and unknown names", async () => {
  const { store, wal } = await fixture();
  await wal.commit({
    id: "second",
    updates: [{ name: "refs/heads/main", old: null, new: null }],
  });
  await store.put(
    `repos/default/nested/records/${"a".repeat(64)}`,
    new Uint8Array([1, 2]),
    null,
  );
  const keys = [...store.objects].map(([key, bytes]) => ({
    key,
    size: bytes.length,
  }));
  const before = store.writes;
  const report = await boundedInventory(
    { get: (key) => store.get(key) },
    {
      list: async (_prefix, cursor) => {
        const offset = cursor === null ? 0 : Number(cursor);
        return {
          keys: keys.slice(offset, offset + 2),
          cursor: offset + 2 < keys.length ? String(offset + 2) : null,
        };
      },
    },
  );
  assert.equal(report.sequence, 2);
  assert.equal(report.listed.pages, Math.ceil(keys.length / 2));
  assert.equal(report.unreferenced.keys, 2); // Previous manifest and previous index root.
  assert.equal(report.unknown.keys, 1);
  assert.equal(report.unknown.bytes, 2);
  assert.equal(
    report.listed.bytes,
    report.live.bytes + report.unreferenced.bytes + report.unknown.bytes,
  );
  assert.equal(report.validation, "metadata-and-pack-hashes");
  assert.equal(store.writes, before);
});

test("pagination cycles, oversized cursors and unsafe byte totals abort", async () => {
  const { store } = await fixture();
  let pages = 0;
  await assert.rejects(
    boundedInventory(store, {
      list: async () => ({ keys: [], cursor: ["a", "b", "a"][pages++]! }),
    }),
    /Repeated inventory cursor/,
  );
  assert.equal(pages, 3);
  await assert.rejects(
    boundedInventory(store, {
      list: async () => ({ keys: [], cursor: "x".repeat(8193) }),
    }),
    /cursor/,
  );
  await assert.rejects(
    boundedInventory(store, {
      list: async () => ({
        keys: [
          { key: "repos/default/a", size: Number.MAX_SAFE_INTEGER },
          { key: "repos/default/b", size: 1 },
        ],
        cursor: null,
      }),
    }),
    /safe integer/,
  );
  for (const size of [-1, Infinity, 0.5])
    await assert.rejects(
      boundedInventory(store, {
        list: async () => ({
          keys: [{ key: "repos/default/a", size }],
          cursor: null,
        }),
      }),
      /Malformed inventory entry/,
    );
});

test("root stability covers pagination, final metadata reads and initially absent roots", async () => {
  const { store, wal } = await fixture();
  const oldListing = await listing(store).list("repos/default/", null);
  await assert.rejects(
    boundedInventory(store, {
      list: async () => {
        await wal.commit({
          id: "during-list",
          updates: [{ name: "refs/heads/main", old: null, new: null }],
        });
        return oldListing;
      },
    }),
    /Root changed/,
  );
  const empty = new InventoryStore();
  const emptyWal = new WalRepository(empty, new NativeGitEngine());
  await assert.rejects(
    boundedInventory(empty, {
      list: async () => {
        await emptyWal.checkpoint();
        return { keys: [], cursor: null };
      },
    }),
    /Root changed/,
  );
  const untouched = new InventoryStore();
  const report = await boundedInventory(untouched, listing(untouched));
  assert.equal(report.format, null);
  assert.equal(report.root, null);
  assert.equal(report.observed.gets, 2);
  for (const change of ["bytes", "version"] as const) {
    const fresh = await fixture();
    let rootReads = 0;
    await assert.rejects(
      boundedInventory(
        {
          get: async (key) => {
            const value = await fresh.store.get(key);
            if (key.endsWith("/root.json") && ++rootReads === 2 && value)
              return change === "bytes"
                ? { ...value, bytes: new Uint8Array(value.bytes.length) }
                : { ...value, version: "different" };
            return value;
          },
        },
        listing(fresh.store),
      ),
      /Root changed/,
    );
  }
});

test("corrupt historical receipts, missing index nodes and backend failures return no report", async () => {
  const { store, wal } = await fixture();
  const old = [...store.objects.keys()].find((key) =>
    key.includes("/records/"),
  )!;
  await wal.commit({
    id: "later",
    updates: [{ name: "refs/heads/main", old: null, new: null }],
  });
  for (const failure of ["old-record", "missing-index", "backend"] as const) {
    let result;
    const before = store.writes;
    await assert.rejects(async () => {
      result = await boundedInventory(
        {
          get: async (key) => {
            if (failure === "backend") throw new Error("read failed");
            if (failure === "missing-index" && key.includes("/receipt-index/"))
              return null;
            const value = await store.get(key);
            if (failure === "old-record" && key === old && value)
              return { ...value, bytes: new Uint8Array(value.bytes.length) };
            return value;
          },
        },
        listing(store),
      );
    });
    assert.equal(result, undefined);
    assert.equal(store.writes, before);
  }
});

test("bounded inventory marks the current trie and indexed records", async () => {
  const { store } = await fixture();
  const report = await boundedInventory(store, listing(store));
  assert.equal(report.sequence, 1);
  assert.equal(report.live.byKind.records.keys, 1);
  assert.ok(report.live.byKind["receipt-index"].keys >= 1);
  assert.equal(report.unreferenced.keys, 0);
  assert.equal(store.writes, 5); // legacy record/root, checkpoint index/manifest/root
});

test("budgets and malformed listings fail closed", async () => {
  const { store } = await fixture();
  await assert.rejects(
    () => boundedInventory(store, listing(store), { maxGets: 1 }),
    LimitError,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store, "duplicate")),
    IntegrityError,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store, "outside")),
    IntegrityError,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store, "cursor"), { maxPages: 2 }),
    IntegrityError,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store), { maxReadBytes: 1 }),
    LimitError,
  );
});

test("missing or corrupt indexed data and a root race abort inventory", async () => {
  const { store } = await fixture();
  const recordKey = [...store.objects.keys()].find((key) =>
    key.includes("/records/"),
  );
  assert.ok(recordKey);
  store.objects.delete(recordKey);
  await assert.rejects(
    () => boundedInventory(store, listing(store)),
    IntegrityError,
  );

  const corrupt = await fixture();
  const base = corrupt.store.get.bind(corrupt.store);
  const corruptSource: ObjectStore = {
    get: async (key) => {
      const value = await base(key);
      if (key.includes("/receipt-index/") && value)
        return { bytes: new Uint8Array([0]), version: value.version };
      return value;
    },
    put: async () => {
      throw new Error("must not write");
    },
  };
  await assert.rejects(
    () => boundedInventory(corruptSource, listing(corrupt.store)),
    IntegrityError,
  );

  const raced = await fixture();
  const original = raced.store.get.bind(raced.store);
  let rootReads = 0;
  const source: ObjectStore = {
    get: async (key) => {
      const value = await original(key);
      if (key.endsWith("/root.json") && ++rootReads === 2 && value)
        return { bytes: value.bytes, version: "raced" };
      return value;
    },
    put: async () => {
      throw new Error("must not write");
    },
  };
  await assert.rejects(
    () => boundedInventory(source, listing(raced.store)),
    IntegrityError,
  );
});
