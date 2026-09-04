/// <reference types="@cloudflare/workers-types" />
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Miniflare } from "miniflare";
import { R2InventoryListing } from "../src/r2-inventory.ts";
import type { R2ListBucket } from "../src/r2-inventory.ts";

function fake(
  pages: Array<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>,
): R2ListBucket {
  let calls = 0;
  return {
    list: async () => pages[calls++] ?? { objects: [], truncated: false },
  };
}

describe("R2InventoryListing", () => {
  it("strips namespace, paginates, and rejects malformed responses", async () => {
    const listing = new R2InventoryListing(
      fake([
        {
          objects: [{ key: "tenant/objects/a", size: 3 }],
          truncated: true,
          cursor: "next",
        },
        { objects: [{ key: "tenant/objects/b", size: 4 }], truncated: false },
      ]),
      { prefix: "tenant", pageSize: 1 },
    );
    const first = await listing.list("objects/", null);
    assert.deepEqual(first, {
      keys: [{ key: "objects/a", size: 3 }],
      cursor: "next",
    });
    assert.deepEqual(await listing.list("objects/", first.cursor), {
      keys: [{ key: "objects/b", size: 4 }],
      cursor: null,
    });

    await assert.rejects(
      new R2InventoryListing(
        fake([
          { objects: [{ key: "elsewhere/a", size: 1 }], truncated: false },
        ]),
        { prefix: "tenant" },
      ).list("", null),
      /outside/,
    );
    await assert.rejects(
      new R2InventoryListing(fake([{ objects: [], truncated: true }])).list(
        "",
        null,
      ),
      /no cursor/,
    );
    await assert.rejects(
      new R2InventoryListing(
        fake([{ objects: [], truncated: false, cursor: "surplus" }]),
      ).list("", null),
      /Non-truncated/,
    );
  });

  it("validates bounds and is unaffected by caller options objects", async () => {
    assert.throws(
      () => new R2InventoryListing(fake([]), { pageSize: 1001 }),
      /1000/,
    );
    assert.throws(
      () => new R2InventoryListing(fake([]), { maxKeyBytes: 0 }),
      /positive/,
    );
    assert.throws(
      () => new R2InventoryListing(fake([]), { maxKeyBytes: 1025 }),
      /1024/,
    );
    const options = { prefix: "tenant", pageSize: 1 };
    const listing = new R2InventoryListing(
      {
        list: async (actual) => {
          assert.deepEqual(actual, { prefix: "tenant/objects/", limit: 1 });
          return { objects: [], truncated: false };
        },
      },
      options,
    );
    options.prefix = "other";
    options.pageSize = 100;
    await listing.list("objects/", null);
  });

  it("rejects duplicate keys, oversized pages, unsafe sizes and invalid cursors", async () => {
    const duplicate = { key: "repo/a", size: 1 };
    for (const [objects, expected] of [
      [[duplicate, duplicate], /Duplicate/],
      [[{ key: "repo/a", size: Number.MAX_SAFE_INTEGER + 1 }], /entry/],
      [[{ key: "repo/\u0000a", size: 1 }], /key/],
    ] as const) {
      await assert.rejects(
        new R2InventoryListing({
          list: async () => ({ objects, truncated: false }),
        }).list("repo/", null),
        expected,
      );
    }
    await assert.rejects(
      new R2InventoryListing(
        fake([
          {
            objects: [duplicate, { key: "repo/b", size: 1 }],
            truncated: false,
          },
        ]),
        { pageSize: 1 },
      ).list("repo/", null),
      /pageSize/,
    );
    for (const cursor of ["next", "x".repeat(8193), "bad\u0000cursor"]) {
      await assert.rejects(
        new R2InventoryListing(
          fake([
            {
              objects: [],
              truncated: true,
              cursor,
            },
          ]),
        ).list("repo/", "next"),
        /cursor/,
      );
    }
    let calls = 0;
    const listing = new R2InventoryListing({
      list: async () => {
        calls++;
        return { objects: [], truncated: false };
      },
    });
    await assert.rejects(listing.list("repo/", "x".repeat(8193)), /cursor/);
    await assert.rejects(listing.list("../repo/", null), /traversal/);
    assert.equal(calls, 0);
  });
});

let mf: Miniflare;
let bucket: R2ListBucket;
before(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "inventory",
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
  const raw = await mf.getR2Bucket("WAL");
  bucket = raw;
});
after(async () => mf.dispose());

it("lists actual Miniflare R2 objects with the namespace removed", async () => {
  const raw = await mf.getR2Bucket("WAL");
  await raw.put("tenant/objects/a", new Uint8Array([1]));
  await raw.put("tenant/objects/b", new Uint8Array([1, 2]));
  await raw.put("other/objects/c", new Uint8Array([1]));
  const listing = new R2InventoryListing(bucket, {
    prefix: "tenant",
    pageSize: 1,
  });
  const first = await listing.list("objects/", null);
  assert.equal(first.keys.length, 1);
  assert.equal(first.keys[0]?.key, "objects/a");
  assert.ok(first.cursor);
  const second = await listing.list("objects/", first.cursor);
  assert.deepEqual(second, {
    keys: [{ key: "objects/b", size: 2 }],
    cursor: null,
  });
});
