import assert from "node:assert/strict";
import test from "node:test";
import type {
  GitEngine,
  ObjectStore,
  Snapshot,
  StoredObject,
} from "../src/contracts.ts";
import { encodePack } from "../src/git/encode.ts";
import { NativeGitEngine } from "../src/git/engine.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { MerkleIndex } from "../src/merkle-index.ts";
import { WalRepository } from "../src/wal.ts";

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

  async get(key: string): Promise<StoredObject | null> {
    this.gets++;
    return this.inner.get(key);
  }

  async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    const committed = await this.inner.put(key, bytes, expectedVersion);
    if (committed) this.objects.set(key, bytes.slice());
    return committed;
  }
}

type Category = "root" | "packs" | "records" | "manifests" | "receipt-index";
type Measurement = {
  objects: Record<Category, number>;
  bytes: Record<Category, number>;
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
  for (const key of liveKeys) {
    const name = category(key);
    if (name !== "root") live[name]++;
  }
  return {
    objects,
    bytes,
    live,
    obsolete: {
      manifests: objects.manifests - live.manifests,
      packs: objects.packs - live.packs,
      records: objects.records - live.records,
      "receipt-index": objects["receipt-index"] - live["receipt-index"],
    },
  };
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
}> {
  const store = new InventoryStore();
  const engine: GitEngine = new NativeGitEngine();
  const repo = new WalRepository(store, engine);
  let current = newTagEachTime ? null : commitOID;
  let at128: Snapshot | undefined;
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
  }
  const at260 = await repo.load();
  assert.equal(at260.sequence, 260);
  assert.equal(at260.records.length, 1);
  assert.equal(Object.keys(at260.refs).length, newTagEachTime ? 260 : 1);

  const liveKeys = new Set<string>(["repos/default/root.json"]);
  const root = await store.inner.get("repos/default/root.json");
  assert.ok(root && at260.checkpoint);
  liveKeys.add(`repos/default/manifests/${at260.checkpoint.manifestHash}`);
  for (const packID of at260.checkpoint.packIds)
    liveKeys.add(`repos/default/packs/${packID}`);
  for (const key of store.objects.keys())
    if (key.includes("/records/")) liveKeys.add(key);
  if (at260.checkpoint.receiptRoot) {
    const index = new MerkleIndex(store, "repos/default/receipt-index/");
    await index.visit(at260.checkpoint.receiptRoot, (hash) => {
      liveKeys.add(`repos/default/receipt-index/${hash}`);
    });
  }
  const measurement = measure(store, liveKeys);
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
    JSON.stringify({ fixed: fixed.measurement, growingTags: tags.measurement }),
  );
});
