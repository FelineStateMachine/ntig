import assert from "node:assert/strict";
import test from "node:test";
import type {
  GitEngine,
  ObjectStore,
  Snapshot,
  StoredObject,
} from "../src/contracts.ts";
import { encodePack } from "../src/git/encode.ts";
import { NativeGitEngine, objectLinks } from "../src/git/engine.ts";
import { readObjects } from "../src/git/pack.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { MerkleIndex } from "../src/merkle-index.ts";
import { WalRepository } from "../src/wal.ts";
import { sha256 } from "../src/wal-format.ts";

const text = new TextEncoder();
const oid = (n: number) => n.toString(16).padStart(40, "0");

function update(name: string, old: string | null, next: string | null) {
  return { name, old, new: next };
}

async function objectID(type: string, data: Uint8Array): Promise<string> {
  const header = text.encode(`${type} ${data.length}\0`);
  const input = new Uint8Array(header.length + data.length);
  input.set(header);
  input.set(data, header.length);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", input)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

class InventoryStore implements ObjectStore {
  readonly inner = new MemoryStore();
  readonly objects = new Map<string, Uint8Array>();
  gets = 0;
  puts = 0;

  async get(key: string): Promise<StoredObject | null> {
    this.gets++;
    return this.inner.get(key);
  }

  async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    this.puts++;
    const committed = await this.inner.put(key, bytes, expectedVersion);
    if (committed) this.objects.set(key, bytes.slice());
    return committed;
  }
}

type Category = "root" | "packs" | "records" | "manifests" | "receipt-index";
type Measurement = {
  objects: Record<Category, number>;
  bytes: Record<Category, number>;
  liveBytes: Record<Category, number>;
  unreferencedBytes: Record<Category, number>;
  totals: {
    storedBytes: number;
    currentFormatBytes: number;
    unreferencedBytes: number;
  };
  live: {
    manifests: number;
    packs: number;
    records: number;
    "receipt-index": number;
  };
  obsolete: {
    manifests: number;
    packs: number;
    records: number;
    "receipt-index": number;
  };
};

function category(key: string): Category {
  if (key === "repos/default/root.json") return "root";
  if (key.includes("/packs/")) return "packs";
  if (key.includes("/records/")) return "records";
  if (key.includes("/manifests/")) return "manifests";
  if (key.includes("/receipt-index/")) return "receipt-index";
  throw new Error(`unexpected store key ${key}`);
}

function measure(store: InventoryStore, liveKeys: Set<string>): Measurement {
  const categories: Category[] = [
    "root",
    "packs",
    "records",
    "manifests",
    "receipt-index",
  ];
  const objects = Object.fromEntries(
    categories.map((name) => [name, 0]),
  ) as Record<Category, number>;
  const bytes = Object.fromEntries(
    categories.map((name) => [name, 0]),
  ) as Record<Category, number>;
  for (const [key, value] of store.objects) {
    const name = category(key);
    objects[name]++;
    bytes[name] += value.byteLength;
  }
  const live = { manifests: 0, packs: 0, records: 0, "receipt-index": 0 };
  const liveBytes = Object.fromEntries(
    categories.map((name) => [name, 0]),
  ) as Record<Category, number>;
  for (const key of liveKeys) {
    const name = category(key);
    assert.ok(store.objects.has(key), `missing live object: ${key}`);
    liveBytes[name] += store.objects.get(key)!.byteLength;
    if (name !== "root") live[name]++;
  }
  const unreferencedBytes = Object.fromEntries(
    categories.map((name) => [name, bytes[name] - liveBytes[name]]),
  ) as Record<Category, number>;
  const sum = (counts: Record<Category, number>) =>
    Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    objects,
    bytes,
    liveBytes,
    unreferencedBytes,
    totals: {
      storedBytes: sum(bytes),
      currentFormatBytes: sum(liveBytes),
      unreferencedBytes: sum(unreferencedBytes),
    },
    live,
    obsolete: {
      manifests: objects.manifests - live.manifests,
      packs: objects.packs - live.packs,
      records: objects.records - live.records,
      "receipt-index": objects["receipt-index"] - live["receipt-index"],
    },
  };
}

/** Quiescent test-fixture inventory, NOT a concurrent GC implementation. */
async function currentKeys(
  store: InventoryStore,
  repo: WalRepository,
): Promise<Set<string>> {
  const rootKey = "repos/default/root.json";
  const before = await store.get(rootKey);
  const snapshot = await repo.load();
  const keys = new Set<string>();
  if (!before) {
    assert.equal(snapshot.sequence, 0);
    return keys;
  }
  keys.add(rootKey);
  if (snapshot.checkpoint) {
    keys.add(`repos/default/manifests/${snapshot.checkpoint.manifestHash}`);
    for (const packID of snapshot.checkpoint.packIds)
      keys.add(`repos/default/packs/${packID}`);
    const index = new MerkleIndex(store, "repos/default/receipt-index/");
    const ids = new Set<string>();
    const sequences = new Set<number>();
    await index.visit(
      snapshot.checkpoint.receiptRoot,
      async (hash, idHash, recordHash) => {
        keys.add(`repos/default/receipt-index/${hash}`);
        if (idHash !== undefined) {
          assert.ok(recordHash);
          const path = `repos/default/records/${recordHash}`;
          const stored = await store.get(path);
          assert.ok(stored);
          assert.equal(await sha256(stored.bytes), recordHash);
          const record = JSON.parse(new TextDecoder().decode(stored.bytes));
          assert.equal(await sha256(text.encode(record.id)), idHash);
          assert.deepEqual(await repo.lookupRecord(record.id), record);
          assert.equal(ids.has(record.id), false);
          assert.equal(sequences.has(record.sequence), false);
          ids.add(record.id);
          sequences.add(record.sequence);
          keys.add(path);
        }
      },
    );
    assert.equal(ids.size, snapshot.sequence);
    for (let n = 1; n <= snapshot.sequence; n++)
      assert.equal(sequences.has(n), true);
  } else {
    let hash = snapshot.tip;
    for (const record of snapshot.records.slice().reverse()) {
      assert.ok(hash);
      keys.add(`repos/default/records/${hash}`);
      if (record.pack) keys.add(`repos/default/packs/${record.pack}`);
      hash = record.parent;
    }
    assert.equal(hash, null);
  }
  const after = await store.get(rootKey);
  assert.equal(after?.version, before.version);
  assert.deepEqual(after?.bytes, before.bytes);
  return keys;
}

async function validateRetainedCopy(
  store: InventoryStore,
  repo: WalRepository,
): Promise<void> {
  const keys = await currentKeys(store, repo);
  const retained = new InventoryStore();
  for (const key of keys)
    await retained.put(key, store.objects.get(key)!, null);
  const cold = new WalRepository(retained, new NativeGitEngine());
  const snapshot = await cold.load();
  assert.deepEqual((await cold.loadRefs()).refs, snapshot.refs);
  const writes = retained.puts;
  let receipts = 0;
  for (const key of keys) {
    if (!key.includes("/records/")) continue;
    const record = JSON.parse(
      new TextDecoder().decode(retained.objects.get(key)!),
    );
    assert.deepEqual(await cold.lookupRecord(record.id), record);
    const receipt = await cold.commit({
      id: record.id,
      updates: record.updates,
      ...(record.pack
        ? { pack: retained.objects.get(`repos/default/packs/${record.pack}`)! }
        : {}),
    });
    assert.deepEqual(receipt, {
      id: record.id,
      sequence: record.sequence,
      replayed: true,
    });
    receipts++;
  }
  assert.equal(receipts, snapshot.sequence);
  assert.equal(
    retained.puts,
    writes,
    "all retained historical retries remain write-free",
  );
  assert.equal((await cold.load()).sequence, snapshot.sequence);
}

async function buildPack(): Promise<{ pack: Uint8Array; commit: string }> {
  const blob = text.encode("metadata growth fixture\n");
  const blobID = await objectID("blob", blob);
  const tree = new Uint8Array(14 + 20);
  tree.set(text.encode("100644 README\0"));
  tree.set(
    new Uint8Array(
      blobID.match(/../g)!.map((part) => Number.parseInt(part, 16)),
    ),
    14,
  );
  const treeID = await objectID("tree", tree);
  const commitData = text.encode(
    `tree ${treeID}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nmetadata growth\n`,
  );
  const commit = await objectID("commit", commitData);
  return {
    pack: await encodePack([
      { type: "blob", data: blob },
      { type: "tree", data: tree },
      { type: "commit", data: commitData },
    ]),
    commit,
  };
}

async function runScenario(
  newTagEachTime: boolean,
  pack: Uint8Array,
  commitOID: string,
): Promise<{
  store: InventoryStore;
  repo: WalRepository;
  at128: Awaited<ReturnType<WalRepository["load"]>>;
  at260: Awaited<ReturnType<WalRepository["load"]>>;
  measurement: Measurement;
  timeline: { sequence: number; measurement: Measurement }[];
}> {
  const store = new InventoryStore();
  const engine: GitEngine = new NativeGitEngine();
  const repo = new WalRepository(store, engine);
  let current = newTagEachTime ? null : commitOID;
  let at128: Snapshot | undefined;
  const timeline: { sequence: number; measurement: Measurement }[] = [];
  for (let n = 1; n <= 260; n++) {
    const name = newTagEachTime
      ? n === 1
        ? "refs/heads/main"
        : `refs/tags/t${n}`
      : "refs/heads/main";
    const old = newTagEachTime || n === 1 ? null : current;
    await repo.commit({
      id: `growth-${n}`,
      updates: [update(name, old, commitOID)],
      ...(n === 1 ? { pack } : {}),
    });
    current = commitOID;
    if (n === 128) {
      at128 = await repo.load();
      assert.equal(at128.sequence, 128);
      assert.equal(at128.records.length, 128);
      await repo.checkpoint();
    }
    if (n === 128 || n === 192)
      timeline.push({
        sequence: n,
        measurement: measure(store, await currentKeys(store, repo)),
      });
  }
  const at260 = await repo.load();
  assert.equal(at260.sequence, 260);
  assert.equal(at260.records.length, 1);
  assert.equal(Object.keys(at260.refs).length, newTagEachTime ? 260 : 1);

  const liveKeys = await currentKeys(store, repo);
  const measurement = measure(store, liveKeys);
  timeline.push({ sequence: 260, measurement });
  assert.equal(measurement.objects.records, 260);
  assert.equal(measurement.objects.manifests, 133);
  assert.equal(
    Object.values(measurement.objects).reduce((sum, value) => sum + value, 0),
    store.objects.size,
  );
  assert.equal(
    Object.values(measurement.bytes).reduce((sum, value) => sum + value, 0),
    [...store.objects.values()].reduce(
      (sum, value) => sum + value.byteLength,
      0,
    ),
  );
  assert.ok(at128);
  return {
    store,
    repo,
    at128,
    at260,
    measurement,
    timeline,
  };
}

test("measures checkpoint metadata growth for fixed refs and growing tags", async () => {
  const { pack, commit } = await buildPack();
  const fixed = await runScenario(false, pack, commit);
  const tags = await runScenario(true, pack, commit);
  assert.deepEqual(
    pack,
    [...fixed.store.objects.entries()].find(([key]) =>
      key.includes("/packs/"),
    )?.[1],
  );

  for (const scenario of [fixed, tags]) {
    await validateRetainedCopy(scenario.store, scenario.repo);
    const objects = await readObjects(scenario.at260.packs);
    const reachable = new Set<string>();
    const pending = Object.values(scenario.at260.refs);
    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      const object = objects.get(id);
      assert.ok(object);
      reachable.add(id);
      pending.push(...objectLinks(object).map((link) => link.oid));
    }
    assert.equal(objects.size, 3);
    assert.equal(
      reachable.size,
      objects.size,
      "fixture pack contains only current-ref reachable Git objects",
    );
    const cold = new WalRepository(scenario.store, new NativeGitEngine());
    for (const n of [1, 64, 128, 192, 260]) {
      const record = await cold.lookupRecord(`growth-${n}`);
      assert.equal(record?.sequence, n);
    }
    const before = scenario.store.gets;
    const refs = await cold.loadRefs();
    assert.equal(scenario.store.gets - before, 2);
    assert.deepEqual(refs.refs, scenario.at260.refs);
  }

  assert.equal(
    fixed.measurement.objects.records,
    tags.measurement.objects.records,
  );
  assert.equal(
    fixed.measurement.objects.manifests,
    tags.measurement.objects.manifests,
  );
  assert.ok(
    tags.measurement.bytes["receipt-index"] >=
      fixed.measurement.bytes["receipt-index"],
  );
  assert.ok(
    tags.measurement.bytes.manifests > fixed.measurement.bytes.manifests,
  );
  console.log(
    JSON.stringify({
      fixed: fixed.measurement,
      growingTags: tags.measurement,
      retentionTimeline: {
        fixed: fixed.timeline.map(({ sequence, measurement }) => ({
          sequence,
          ...measurement.totals,
          recordsBytes: measurement.liveBytes.records,
          indexBytes: measurement.liveBytes["receipt-index"],
          manifestBytes: measurement.liveBytes.manifests,
        })),
        growingTags: tags.timeline.map(({ sequence, measurement }) => ({
          sequence,
          ...measurement.totals,
          recordsBytes: measurement.liveBytes.records,
          indexBytes: measurement.liveBytes["receipt-index"],
          manifestBytes: measurement.liveBytes.manifests,
        })),
      },
    }),
  );
});

test("empty and one-commit storage baselines distinguish fixed overhead from history", async () => {
  const { pack, commit } = await buildPack();
  const store = new InventoryStore();
  const repo = new WalRepository(store, new NativeGitEngine());
  const baselines: Record<string, Measurement> = {};
  baselines.emptyLegacy = measure(store, await currentKeys(store, repo));
  const emptyStore = new InventoryStore();
  const emptyRepo = new WalRepository(emptyStore, new NativeGitEngine());
  await emptyRepo.checkpoint();
  baselines.emptyCheckpoint = measure(
    emptyStore,
    await currentKeys(emptyStore, emptyRepo),
  );
  await repo.commit({
    id: "growth-1",
    pack,
    updates: [update("refs/heads/main", null, commit)],
  });
  baselines.oneLegacy = measure(store, await currentKeys(store, repo));
  await repo.checkpoint();
  baselines.oneCheckpoint = measure(store, await currentKeys(store, repo));
  await validateRetainedCopy(store, repo);
  assert.equal(baselines.emptyLegacy.totals.storedBytes, 0);
  assert.equal(baselines.oneCheckpoint.totals.unreferencedBytes, 0);
  // A valid-address but unindexed record must never be counted as required retry data.
  const orphanBytes = text.encode(JSON.stringify({ unpublished: true }));
  await store.put(
    `repos/default/records/${await sha256(orphanBytes)}`,
    orphanBytes,
    null,
  );
  const withOrphan = measure(store, await currentKeys(store, repo));
  assert.equal(withOrphan.live.records, 1);
  assert.equal(withOrphan.obsolete.records, 1);
  assert.equal(withOrphan.unreferencedBytes.records, orphanBytes.length);
  await validateRetainedCopy(store, repo);
  console.log(
    JSON.stringify({ baselines, injectedOrphanBytes: orphanBytes.length }),
  );
});
