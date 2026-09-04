/// <reference types="@cloudflare/workers-types" />
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Miniflare } from "miniflare";
import { R2ObjectStore, type R2StoreBucket } from "../src/r2-store.js";

let mf: Miniflare;
let bucket: R2StoreBucket;

before(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "worker",
          compatibilityDate: "2026-09-04",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response('ok') } }",
              },
            },
          },
          env: { WAL: { type: "r2", name: "WAL" } },
        },
      },
    ],
  });
  // Project only the binding methods we use, avoiding incompatible
  // DOM/Headers definitions between Miniflare and generated Workers types.
  const raw = await mf.getR2Bucket("WAL");
  bucket = {
    get: async (key) => {
      const object = await raw.get(key);
      return (
        object && {
          size: object.size,
          etag: object.etag,
          arrayBuffer: () => object.arrayBuffer(),
        }
      );
    },
    put: async (key, value, options) => {
      const object = await raw.put(key, value, options);
      return object && { etag: object.etag };
    },
  };
});

after(async () => {
  await mf.dispose();
});

describe("R2ObjectStore", () => {
  it("round-trips bytes and returns an opaque etag version", async () => {
    const store = new R2ObjectStore(bucket, { prefix: "repo-a" });
    const input = new Uint8Array([0, 1, 255]);
    assert.equal(await store.put("objects/a", input, null), true);
    input[0] = 99;
    const first = await store.get("objects/a");
    assert.deepEqual(first && [...first.bytes], [0, 1, 255]);
    assert.ok(first?.version);
    first!.bytes[0] = 88;
    assert.deepEqual([...(await store.get("objects/a"))!.bytes], [0, 1, 255]);
    assert.equal(
      await new R2ObjectStore(bucket, { prefix: "repo-b" }).get("objects/a"),
      null,
    );
    // A fresh adapter sees the same object: there is no process-local cache.
    const cold = await new R2ObjectStore(bucket, { prefix: "repo-a" }).get(
      "objects/a",
    );
    assert.deepEqual(cold && [...cold.bytes], [0, 1, 255]);
  });

  it("enforces create-if-absent and atomic concurrent CAS", async () => {
    const store = new R2ObjectStore(bucket, { prefix: "cas" });
    assert.equal(await store.put("manifest", new Uint8Array([1]), null), true);
    const current = await store.get("manifest");
    assert.ok(current);
    const rejected = new Uint8Array([9]);
    assert.equal(await store.put("manifest", rejected, null), false);
    rejected[0] = 77;
    assert.deepEqual([...(await store.get("manifest"))!.bytes], [1]);
    const attempts = await Promise.all([
      store.put("manifest", new Uint8Array([2]), current.version),
      store.put("manifest", new Uint8Array([3]), current.version),
    ]);
    assert.equal(attempts.filter(Boolean).length, 1);
    const final = await store.get("manifest");
    assert.ok(final);
    assert.ok(final.bytes[0] === 2 || final.bytes[0] === 3);
    assert.notEqual(final.version, current.version);
  });

  it("applies prefix and byte-size limits before R2 writes and reads", async () => {
    const store = new R2ObjectStore(bucket, {
      prefix: "bounded",
      maxObjectBytes: 3,
    });
    await assert.rejects(
      store.put("too-large", new Uint8Array(4), null),
      /exceeds maxObjectBytes/,
    );
    await assert.rejects(store.get("missing\nkey"), /control character/);
    assert.throws(
      () => new R2ObjectStore(bucket, { maxObjectBytes: 0 }),
      /positive/,
    );
    assert.equal(await store.put("ok", new Uint8Array([1, 2, 3]), null), true);
    await assert.rejects(
      new R2ObjectStore(bucket, { prefix: "bounded", maxObjectBytes: 2 }).get(
        "ok",
      ),
      /exceeds maxObjectBytes/,
    );
    const multibytePrefix = new R2ObjectStore(bucket, {
      prefix: "é".repeat(511),
    });
    await assert.rejects(
      multibytePrefix.put("é", new Uint8Array([1]), null),
      /UTF-8 limit/,
    );
    const exactPrefix = new R2ObjectStore(bucket, { prefix: "a".repeat(1020) });
    assert.equal(await exactPrefix.put("ok", new Uint8Array([1]), null), true);
    await assert.rejects(
      exactPrefix.put("éé", new Uint8Array([1]), null),
      /UTF-8 limit/,
    );
  });
});
