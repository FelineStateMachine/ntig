import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryStore,
  NativeGitEngine,
  WalRepository,
  type ObjectStore,
} from "../src/index.ts";

const prefix = "repos/default/";
const rootKey = `${prefix}root.json`;
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = (id: string) => ({
  id,
  updates: [{ name: "refs/heads/absent", old: null, new: null }],
});
async function fixture() {
  const store = new MemoryStore();
  const wal = new WalRepository(store, new NativeGitEngine());
  await wal.commit(request("first"));
  await wal.checkpoint();
  return { store, wal };
}

// Counterexamples only: no collector, object deletion, or change to runtime locking.
test(
  "an unchanged inventory root does not protect an already-started old-root reader",
  { timeout: 5000 },
  async () => {
    const { store, wal } = await fixture();
    const first = await wal.load();
    const oldManifest = `${prefix}manifests/${first.checkpoint!.manifestHash}`;
    const started = latch();
    const release = latch();
    let pause = true;
    const readerStore: ObjectStore = {
      get: async (key) => {
        if (pause && key === oldManifest) {
          pause = false;
          started.resolve();
          await release.promise;
        }
        return store.get(key);
      },
      put: () => {
        throw new Error("reader must not write");
      },
    };
    const reader = new WalRepository(readerStore, new NativeGitEngine());
    const pending = reader.withReadSession((scoped) => scoped.load());
    try {
      await started.promise; // Reader captured old root, but has not read its manifest.
      await wal.commit(request("second"));
      const before = await store.get(rootKey);
      const current = await wal.load();
      const after = await store.get(rootKey);
      assert.deepEqual(
        after,
        before,
        "root can remain stable for the entire inventory",
      );
      assert.equal(current.sequence, 2);
      assert.notEqual(
        current.checkpoint!.manifestHash,
        first.checkpoint!.manifestHash,
      );
      assert.ok(
        await store.get(oldManifest),
        "unreferenced current-root metadata is still needed by the old reader",
      );
    } finally {
      release.resolve();
    }
    assert.equal(
      (await pending).sequence,
      1,
      "request-scoped caching is not a reader lease",
    );
  },
);

test(
  "an unchanged inventory root does not protect an in-flight publisher's immutable metadata",
  { timeout: 5000 },
  async () => {
    const { store, wal } = await fixture();
    const started = latch();
    const release = latch();
    let nextManifest = "";
    const publishingStore: ObjectStore = {
      get: (key) => store.get(key),
      put: async (key, bytes, expected) => {
        if (key.startsWith(`${prefix}manifests/`)) nextManifest = key;
        if (key === rootKey) {
          started.resolve();
          await release.promise; // Immutable record/index/manifest already written.
        }
        return store.put(key, bytes, expected);
      },
    };
    const writer = new WalRepository(publishingStore, new NativeGitEngine());
    const pending = writer.withReadSession((scoped) =>
      scoped.commit(request("second")),
    );
    try {
      await started.promise;
      const before = await store.get(rootKey);
      const current = await wal.load();
      const after = await store.get(rootKey);
      assert.deepEqual(after, before);
      assert.equal(current.sequence, 1);
      assert.ok(nextManifest);
      assert.notEqual(
        nextManifest,
        `${prefix}manifests/${current.checkpoint!.manifestHash}`,
      );
      assert.ok(
        await store.get(nextManifest),
        "unreferenced current-root metadata belongs to a still-pending publisher",
      );
    } finally {
      release.resolve();
    }
    assert.equal((await pending).sequence, 2);
    const published = await wal.load();
    assert.equal(
      `${prefix}manifests/${published.checkpoint!.manifestHash}`,
      nextManifest,
    );
  },
);
