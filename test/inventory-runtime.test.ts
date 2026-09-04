import assert from "node:assert/strict";
import test from "node:test";
import {
  IntegrityError,
  LimitError,
  type ObjectStore,
} from "../src/contracts.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { MerkleIndex } from "../src/merkle-index.ts";
import {
  boundedInventory,
  type InventoryListing,
  type ListedObject,
} from "../src/inventory.ts";
import { WalRepository, sha256 } from "../src/wal.ts";
import { requestHash } from "../src/wal-format.ts";

const enc = new TextEncoder();
const oid = (n: number) => n.toString(16).padStart(40, "0");
const update = (name: string, old: string | null, next: string | null) => ({
  name,
  old,
  new: next,
});
const engine = { async verify() {} };

class TrackingStore implements ObjectStore {
  readonly keys = new Set<string>();
  gets = 0;
  putAttempts = 0;
  constructor(readonly inner = new MemoryStore()) {}
  async get(key: string) {
    this.gets++;
    return this.inner.get(key);
  }
  async put(key: string, bytes: Uint8Array, expected: string | null) {
    this.putAttempts++;
    const result = await this.inner.put(key, bytes, expected);
    if (result) this.keys.add(key);
    return result;
  }
}

function listing(store: TrackingStore, pageSize = 1000): InventoryListing {
  return {
    async list(prefix: string, cursor: string | null) {
      const keys = [...store.keys]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = cursor === null ? 0 : Number(cursor);
      const page = keys.slice(start, start + pageSize);
      const objects: ListedObject[] = [];
      for (const key of page)
        objects.push({
          key,
          size: (await store.inner.get(key))?.bytes.length ?? 0,
        });
      return {
        keys: objects,
        cursor:
          start + page.length < keys.length
            ? String(start + page.length)
            : null,
      };
    },
  };
}

test("v1 inventory is read-only and does not migrate or write", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "inventory-v1",
    updates: [update("refs/heads/main", null, oid(1))],
  });
  const before = [...store.keys];
  const putsBefore = store.putAttempts;
  const report = await boundedInventory(store, listing(store), {
    prefix: "repos/default/",
  });
  assert.equal(report.format, 1);
  assert.equal(report.sequence, 1);
  assert.deepEqual([...store.keys], before);
  assert.equal(store.putAttempts, putsBefore);
  assert.equal(
    await store.inner
      .get("repos/default/root.json")
      .then((v) => JSON.parse(new TextDecoder().decode(v!.bytes)).format),
    1,
  );
});

test("v2 inventory reports per-kind live and unreferenced key/byte totals", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "inventory-v2",
    updates: [update("refs/heads/main", null, oid(2))],
  });
  await repo.checkpoint();
  const staleKey = "repos/default/unknown/stale";
  await store.put(staleKey, enc.encode("stale"), null);
  const staleRecord = `repos/default/records/${"e".repeat(64)}`;
  await store.put(staleRecord, enc.encode("stale"), null);
  const report = await boundedInventory(store, listing(store), {
    prefix: "repos/default/",
  });
  assert.equal(report.format, 2);
  assert.equal(report.live.byKind.manifests.keys, 1);
  assert.equal(report.live.byKind.records.keys, 1);
  assert.equal(report.unknown.byKind.unknown.keys, 1);
  assert.equal(report.unknown.byKind.unknown.bytes, 5);
  assert.equal(report.unreferenced.byKind.records.keys, 1);
  assert.equal(report.unreferenced.byKind.records.bytes, 5);
  assert.equal(report.listed.byKind.root.keys, 1);
  const totals = (kind: "keys" | "bytes") =>
    report.live[kind] + report.unreferenced[kind] + report.unknown[kind];
  assert.equal(totals("keys"), report.listed.keys);
  assert.equal(totals("bytes"), report.listed.bytes);
});

test("custom prefixes and WAL limits are honored", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine, {
    prefix: "repos/custom/",
    limits: { maxRecords: 140 },
  });
  for (let n = 1; n <= 140; n++) {
    await repo.commit({
      id: `custom-${n}`,
      updates: [update(`refs/heads/r${n}`, null, oid(n))],
    });
  }
  const report = await repo.inventory(listing(store), {
    limits: { maxReceipts: 140 },
  });
  assert.equal(report.sequence, 140);
  assert.equal(report.format, 1);
  await assert.rejects(
    () =>
      boundedInventory(store, listing(store), {
        prefix: "repos/custom/",
        walLimits: { maxRecords: 1 },
      }),
    LimitError,
  );
});

test("pre-aborted and mid-I/O cancellation are cooperative and perform no later calls", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "abort",
    updates: [update("refs/heads/main", null, oid(4))],
  });
  const pre = new AbortController();
  pre.abort();
  const preGets = store.gets;
  let listingCalls = 0;
  await assert.rejects(
    () =>
      boundedInventory(
        store,
        {
          list: async () => {
            listingCalls++;
            return { keys: [], cursor: null };
          },
        },
        { signal: pre.signal },
      ),
    { name: "AbortError" },
  );
  assert.equal(listingCalls, 0);
  assert.equal(store.gets, preGets);

  let releaseGet!: () => void;
  const getGate = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });
  let settled = false;
  let midGetCalls = 0;
  let afterGetLists = 0;
  const midGet = new AbortController();
  const pendingGet = boundedInventory(
    {
      get: async (key: string) => {
        midGetCalls++;
        await getGate;
        return store.get(key);
      },
    },
    {
      list: async () => {
        afterGetLists++;
        return { keys: [], cursor: null };
      },
    },
    { signal: midGet.signal },
  ).finally(() => {
    settled = true;
  });
  midGet.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  releaseGet();
  await assert.rejects(pendingGet, { name: "AbortError" });
  assert.equal(midGetCalls, 1);
  assert.equal(afterGetLists, 0);

  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let calls = 0;
  let markListStarted!: () => void;
  const listStarted = new Promise<void>((resolve) => {
    markListStarted = resolve;
  });
  const midList = new AbortController();
  let listSettled = false;
  const beforeListGets = store.gets;
  const pendingList = boundedInventory(
    store,
    {
      list: async () => {
        calls++;
        markListStarted();
        await listGate;
        return { keys: [], cursor: null };
      },
    },
    { signal: midList.signal },
  ).finally(() => {
    listSettled = true;
  });
  await listStarted;
  midList.abort();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(listSettled, false);
  releaseList();
  await assert.rejects(pendingList, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(store.gets - beforeListGets, 1);
});

test("v2 inventory validates the full receipt parent chain", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "chain-1",
    updates: [update("refs/heads/main", null, oid(5))],
  });
  await repo.checkpoint();
  await repo.commit({
    id: "chain-2",
    updates: [update("refs/heads/side", null, oid(6))],
  });
  const rootObject = await store.inner.get("repos/default/root.json");
  assert.ok(rootObject);
  const root = JSON.parse(new TextDecoder().decode(rootObject.bytes)) as {
    manifest: string;
  };
  const manifestObject = await store.inner.get(
    `repos/default/manifests/${root.manifest}`,
  );
  assert.ok(manifestObject);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestObject.bytes),
  ) as {
    receipts: string;
    tip: string;
    sequence: number;
    refs: Record<string, string>;
    packs: string[];
    format: 2;
  };
  const tipObject = await store.inner.get(
    `repos/default/records/${manifest.tip}`,
  );
  assert.ok(tipObject);
  const tip = JSON.parse(new TextDecoder().decode(tipObject.bytes)) as Record<
    string,
    unknown
  >;
  tip.parent = "f".repeat(64);
  const replacementBytes = enc.encode(JSON.stringify(tip));
  const replacementHash = await sha256(replacementBytes);
  await store.put(
    `repos/default/records/${replacementHash}`,
    replacementBytes,
    null,
  );
  const index = new MerkleIndex(store, "repos/default/receipt-index/");
  const entries: Array<[string, string]> = [];
  await index.visit(manifest.receipts, (_hash, key, value) => {
    if (key !== undefined && value !== undefined) entries.push([key, value]);
  });
  const chain2Key = await sha256(enc.encode("chain-2"));
  let replacementRoot: string | null = null;
  for (const [key, value] of entries)
    replacementRoot = await index.insert(
      replacementRoot,
      key,
      key === chain2Key ? replacementHash : value,
    );
  const replacementManifest = {
    ...manifest,
    tip: replacementHash,
    receipts: replacementRoot,
  };
  const replacementManifestBytes = enc.encode(
    JSON.stringify(replacementManifest),
  );
  const replacementManifestHash = await sha256(replacementManifestBytes);
  await store.put(
    `repos/default/manifests/${replacementManifestHash}`,
    replacementManifestBytes,
    null,
  );
  await store.put(
    "repos/default/root.json",
    enc.encode(
      JSON.stringify({
        format: 2,
        sequence: 2,
        manifest: replacementManifestHash,
      }),
    ),
    rootObject.version,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store), { prefix: "repos/default/" }),
    (error: unknown) =>
      error instanceof IntegrityError &&
      /parent chain mismatch/.test(error.message),
  );
});

test("v2 inventory replays ref history and rejects a forged old value", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "semantic-old",
    updates: [update("refs/heads/main", null, oid(10))],
  });
  await repo.checkpoint();
  const rootObject = await store.inner.get("repos/default/root.json");
  assert.ok(rootObject);
  const root = JSON.parse(new TextDecoder().decode(rootObject.bytes)) as {
    manifest: string;
  };
  const manifestObject = await store.inner.get(
    `repos/default/manifests/${root.manifest}`,
  );
  assert.ok(manifestObject);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestObject.bytes),
  ) as {
    receipts: string;
    tip: string;
    sequence: number;
    refs: Record<string, string>;
    packs: string[];
    format: 2;
  };
  const recordObject = await store.inner.get(
    `repos/default/records/${manifest.tip}`,
  );
  assert.ok(recordObject);
  const record = JSON.parse(
    new TextDecoder().decode(recordObject.bytes),
  ) as Record<string, any>;
  record.updates = [update("refs/heads/main", oid(11), oid(10))];
  record.requestHash = await requestHash(
    record.id,
    record.updates,
    record.pack,
  );
  const recordBytes = enc.encode(JSON.stringify(record));
  const forgedHash = await sha256(recordBytes);
  await store.put(`repos/default/records/${forgedHash}`, recordBytes, null);
  const index = new MerkleIndex(store, "repos/default/receipt-index/");
  const key = await sha256(enc.encode(record.id));
  const forgedReceipts = await index.insert(null, key, forgedHash);
  const forgedManifest = {
    ...manifest,
    tip: forgedHash,
    receipts: forgedReceipts,
  };
  const forgedManifestBytes = enc.encode(JSON.stringify(forgedManifest));
  const forgedManifestHash = await sha256(forgedManifestBytes);
  await store.put(
    `repos/default/manifests/${forgedManifestHash}`,
    forgedManifestBytes,
    null,
  );
  await store.put(
    "repos/default/root.json",
    enc.encode(
      JSON.stringify({ format: 2, sequence: 1, manifest: forgedManifestHash }),
    ),
    rootObject.version,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store), { prefix: "repos/default/" }),
    (error: unknown) =>
      error instanceof IntegrityError &&
      /ref history|old ref|inconsistent/i.test(error.message),
  );
});

test("v2 inventory rejects manifests whose refs disagree with the replayed tip", async () => {
  for (const mutate of [
    (refs: Record<string, string>) => {
      refs["refs/heads/extra"] = oid(13);
    },
    (refs: Record<string, string>) => {
      delete refs["refs/heads/side"];
    },
    (refs: Record<string, string>) => {
      refs["refs/heads/main"] = oid(14);
    },
  ]) {
    const store = new TrackingStore();
    const repo = new WalRepository(store, engine);
    await repo.commit({
      id: "semantic-refs-a",
      updates: [update("refs/heads/main", null, oid(12))],
    });
    await repo.commit({
      id: "semantic-refs-b",
      updates: [update("refs/heads/side", null, oid(13))],
    });
    await repo.checkpoint();
    const rootObject = await store.inner.get("repos/default/root.json");
    assert.ok(rootObject);
    const root = JSON.parse(new TextDecoder().decode(rootObject.bytes)) as {
      manifest: string;
    };
    const manifestObject = await store.inner.get(
      `repos/default/manifests/${root.manifest}`,
    );
    assert.ok(manifestObject);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestObject.bytes),
    ) as { refs: Record<string, string>; [key: string]: unknown };
    mutate(manifest.refs);
    const bytes = enc.encode(JSON.stringify(manifest));
    const hash = await sha256(bytes);
    await store.put(`repos/default/manifests/${hash}`, bytes, null);
    await store.put(
      "repos/default/root.json",
      enc.encode(JSON.stringify({ format: 2, sequence: 2, manifest: hash })),
      rootObject.version,
    );
    await assert.rejects(
      () =>
        boundedInventory(store, listing(store), { prefix: "repos/default/" }),
      (error: unknown) =>
        error instanceof IntegrityError && /ref|manifest/i.test(error.message),
    );
  }
});

test("v2 inventory rejects historical records whose packs are absent from the manifest", async () => {
  const store = new TrackingStore();
  const repo = new WalRepository(store, engine);
  await repo.commit({
    id: "pack-history-a",
    updates: [update("refs/heads/main", null, oid(15))],
    pack: new Uint8Array(32).fill(15),
  });
  await repo.checkpoint();
  await repo.commit({
    id: "pack-history-b",
    updates: [update("refs/heads/side", null, oid(16))],
    pack: new Uint8Array(32).fill(16),
  });
  const rootObject = await store.inner.get("repos/default/root.json");
  assert.ok(rootObject);
  const root = JSON.parse(new TextDecoder().decode(rootObject.bytes)) as {
    manifest: string;
  };
  const manifestObject = await store.inner.get(
    `repos/default/manifests/${root.manifest}`,
  );
  assert.ok(manifestObject);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestObject.bytes),
  ) as { packs: string[]; [key: string]: unknown };
  manifest.packs = [manifest.packs.at(-1)!];
  const bytes = enc.encode(JSON.stringify(manifest));
  const hash = await sha256(bytes);
  await store.put(`repos/default/manifests/${hash}`, bytes, null);
  await store.put(
    "repos/default/root.json",
    enc.encode(JSON.stringify({ format: 2, sequence: 2, manifest: hash })),
    rootObject.version,
  );
  await assert.rejects(
    () => boundedInventory(store, listing(store), { prefix: "repos/default/" }),
    (error: unknown) =>
      error instanceof IntegrityError &&
      /pack.*manifest|manifest.*pack/i.test(error.message),
  );
});
