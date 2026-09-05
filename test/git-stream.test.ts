import assert from "node:assert/strict";
import test from "node:test";
import { createGitHandler } from "../src/http.ts";
import { readObjects } from "../src/git/pack.ts";
import type { GitRepository } from "../src/contracts.ts";
import type { GitObject } from "../src/git/pack.ts";

const enc = new TextEncoder();
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const pkt = (s: string) =>
  `${(enc.encode(s).length + 4).toString(16).padStart(4, "0")}${s}`;

test("indexed upload-pack streams a pack larger than 64 MiB without buffering it", async () => {
  const objects = new Map<string, GitObject>();
  const refs: Record<string, string> = {};
  for (let n = 0; n < 5; n++) {
    const data = new Uint8Array(13 * 1024 * 1024);
    let state = (0x9e3779b9 ^ n) >>> 0;
    for (let i = 0; i < data.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      data[i] = state & 255;
    }
    const header = enc.encode(`blob ${data.length}\0`);
    const input = new Uint8Array(header.length + data.length);
    input.set(header);
    input.set(data, header.length);
    const oid = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-1", input.buffer)),
    );
    const object = { oid, type: "blob" as const, data };
    objects.set(oid, object);
    refs[`refs/tags/blob-${n}`] = oid;
  }
  const repo: GitRepository = {
    async load() {
      return {
        sequence: 0,
        tip: null,
        version: null,
        refs,
        records: [],
        packs: [],
      };
    },
    async loadRefs() {
      return { sequence: 0, tip: null, version: null, refs };
    },
    async commit() {
      return { id: "test", sequence: 1, replayed: false };
    },
    async getObjectInfo(oid) {
      const o = objects.get(oid);
      return o ? { oid, type: o.type, size: o.data.length, links: [] } : null;
    },
    async getObject(oid) {
      return objects.get(oid) ?? null;
    },
  };
  const wants =
    [...objects.keys()]
      .map((oid, i) => pkt(`want ${oid}${i === 0 ? " side-band-64k" : ""}\n`))
      .join("") +
    "0000" +
    pkt("done\n") +
    "0000";
  const handler = createGitHandler(repo, {
    maxResponseBytes: 100 * 1024 * 1024,
    fetchLimits: {
      maxObjectBytes: 14 * 1024 * 1024,
      maxObjects: 16,
      maxPackBytes: 100 * 1024 * 1024,
      maxTotalObjectBytes: 100 * 1024 * 1024,
    },
  });
  const response = await handler(
    new Request("https://x/repo.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: wants,
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 64 * 1024 * 1024);
  // Strip NAK and sideband packet framing, then let the native pack decoder
  // verify the incremental pack checksum and every object header.
  let p = 8;
  const pack: number[] = [];
  while (p < bytes.length) {
    const size = Number.parseInt(
      new TextDecoder().decode(bytes.subarray(p, p + 4)),
      16,
    );
    p += 4;
    if (size === 0) break;
    const payload = bytes.subarray(p, p + size - 4);
    p += size - 4;
    assert.equal(payload[0], 1);
    pack.push(...payload.subarray(1));
  }
  const decoded = await readObjects([Uint8Array.from(pack)], {
    maxPackBytes: 100 * 1024 * 1024,
    maxTotalPackBytes: 100 * 1024 * 1024,
    maxTotalObjectBytes: 100 * 1024 * 1024,
    maxObjectBytes: 14 * 1024 * 1024,
    maxObjects: 16,
  });
  assert.equal(decoded.size, 5);
});

test("chunked upload-pack negotiation is bounded before materialization", async () => {
  const repo: GitRepository = {
    async load() {
      return {
        sequence: 0,
        tip: null,
        version: null,
        refs: {},
        records: [],
        packs: [],
      };
    },
    async commit() {
      return { id: "test", sequence: 1, replayed: false };
    },
    async getObjectInfo() {
      return null;
    },
    async getObject() {
      return null;
    },
  };
  const chunk = new Uint8Array(128 * 1024);
  let sent = 0;
  const request = new Request("https://x/repo.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: new ReadableStream({
        pull(controller) {
          if (sent >= 9) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(chunk);
        },
      }),
      // Node requires duplex for a streaming request body.
      duplex: "half",
    } as RequestInit),
    response = await createGitHandler(repo)(request);
  assert.equal(response.status, 413);
});
