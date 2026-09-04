import assert from "node:assert/strict";
import test from "node:test";
import { createGitHandler } from "../src/http.ts";
import { WalRepository } from "../src/wal.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { NativeGitEngine } from "../src/git/engine.ts";
import { encodePack } from "../src/git/encode.ts";
import { decodePack } from "../src/git/pack.ts";

const enc = new TextEncoder();
async function oid(type: string, data: Uint8Array) {
  const h = enc.encode(`${type} ${data.length}\0`),
    x = new Uint8Array(h.length + data.length);
  x.set(h);
  x.set(data, h.length);
  const d = await crypto.subtle.digest("SHA-1", x);
  return Array.from(new Uint8Array(d), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const pkt = (s: string) => {
  const b = enc.encode(s),
    h = enc.encode((b.length + 4).toString(16).padStart(4, "0"));
  return new Uint8Array([...h, ...b]);
};
const flush = () => new Uint8Array([48, 48, 48, 48]);
const cat = (...xs: Uint8Array[]) => {
  const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of xs) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
async function fixture() {
  const blob = enc.encode("hello\n"),
    bo = await oid("blob", blob);
  const tree = new Uint8Array([
      ...enc.encode("100644 file\0"),
      ...Uint8Array.from(bo.match(/../g)!, (x) => parseInt(x, 16)),
    ]),
    to = await oid("tree", tree);
  const commit = enc.encode(
      `tree ${to}\nauthor Test <t@example.com> 1 +0000\ncommitter Test <t@example.com> 1 +0000\n\ninitial\n`,
    ),
    co = await oid("commit", commit);
  const secret = enc.encode("unreachable must not be served"),
    secretOid = await oid("blob", secret);
  const pack = await encodePack([
    { type: "blob", data: blob },
    { type: "tree", data: tree },
    { type: "commit", data: commit },
    { type: "blob", data: secret },
  ]);
  const repo = new WalRepository(new MemoryStore(), new NativeGitEngine());
  await repo.commit({
    id: "seed",
    updates: [{ name: "refs/heads/main", old: null, new: co }],
    pack,
  });
  return { repo, co, pack, bo, to, secretOid };
}
test("advertisement uses smart route, service type, and flush packets", async () => {
  const { repo, co } = await fixture();
  const h = createGitHandler(repo);
  const r = await h(
    new Request("https://x/repo.git/info/refs?service=git-upload-pack"),
  );
  const b = new Uint8Array(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.equal(
    r.headers.get("content-type"),
    "application/x-git-upload-pack-advertisement",
  );
  assert.match(
    new TextDecoder().decode(b),
    new RegExp(`${co} refs/heads/main`),
  );
  assert.deepEqual(Array.from(b.slice(-4)), [48, 48, 48, 48]);
  assert.equal(
    (
      await h(
        new Request("https://x/repo.git/info/refs?service=git-receive-pack"),
      )
    ).headers.get("content-type"),
    "application/x-git-receive-pack-advertisement",
  );
  assert.equal(
    (
      await h(
        new Request(
          "https://x/repo.git/info/refs?service=git-upload-pack&x=1",
          { headers: { "content-encoding": "gzip" } },
        ),
      )
    ).status,
    200,
  );
});
test("auth is fail-closed before body read and unknown suffix is 404", async () => {
  const { repo } = await fixture();
  let used = true;
  const h = createGitHandler(repo, {
    authorizePush: (r) => {
      used = r.bodyUsed;
      return false;
    },
  });
  assert.equal(
    (
      await h(
        new Request("https://x/repo.git/git-receive-pack", {
          method: "POST",
          body: "x",
        }),
      )
    ).status,
    403,
  );
  assert.equal(used, false);
  assert.equal(
    (
      await h(
        new Request("https://x/repo.git/git-upload-pack-extra", {
          method: "POST",
          body: "",
        }),
      )
    ).status,
    404,
  );
});
test("stale receive command reports failure without changing refs", async () => {
  const { repo, co } = await fixture();
  const h = createGitHandler(repo, { authorizePush: () => true });
  const bad = "f".repeat(40);
  const body = cat(
    pkt(`${bad} ${co} refs/heads/main\0report-status\n`),
    flush(),
  );
  const r = await h(
    new Request("https://x/repo.git/git-receive-pack", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-git-receive-pack-request" },
    }),
  );
  const text = new TextDecoder().decode(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.match(text, /ng|unpack/);
  assert.equal((await repo.load()).refs["refs/heads/main"], co);
});
test("malformed pkt and oversized upload are rejected", async () => {
  const { repo } = await fixture();
  const h = createGitHandler(repo, {
    authorizePush: () => true,
    maxBodyBytes: 10,
  });
  const headers = { "content-type": "application/x-git-receive-pack-request" };
  assert.equal(
    (
      await h(
        new Request("https://x/repo.git/git-receive-pack", {
          method: "POST",
          body: "000g",
          headers,
        }),
      )
    ).status,
    400,
  );
  const limited = createGitHandler(repo, {
    authorizePush: () => true,
    maxBodyBytes: 3,
  });
  assert.equal(
    (
      await limited(
        new Request("https://x/repo.git/git-receive-pack", {
          method: "POST",
          body: "abcd",
          headers,
        }),
      )
    ).status,
    413,
  );
});
test("upload returns the exact reachable graph and rejects unreachable wants", async () => {
  const { repo, co, bo, to, secretOid } = await fixture();
  const h = createGitHandler(repo);
  const fetch = (want: string, filter?: string) =>
    h(
      new Request("https://x/repo.git/git-upload-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: cat(
          pkt(`want ${want}${filter ? " filter" : " ofs-delta"}\n`),
          ...(filter ? [pkt(`filter ${filter}\n`)] : []),
          flush(),
          pkt("done\n"),
        ),
      }),
    );
  const result = await fetch(co);
  assert.equal(result.status, 200);
  const responseBytes = new Uint8Array(await result.arrayBuffer());
  assert.equal(
    new TextDecoder().decode(responseBytes.slice(0, 8)),
    "0008NAK\n",
  );
  const objects = await decodePack(responseBytes.slice(8));
  assert.deepEqual(
    objects.map((object) => object.oid).sort(),
    [co, bo, to].sort(),
  );
  assert.equal((await fetch(secretOid)).status, 400);
  for (const [filter, expected] of [
    ["blob:none", [co, to]],
    ["tree:0", [co]],
  ] as const) {
    const filtered = await fetch(co, filter);
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      (await decodePack(new Uint8Array(await filtered.arrayBuffer()).slice(8)))
        .map((object) => object.oid)
        .sort(),
      [...expected].sort(),
    );
  }
});

test("receive requires a flush, rejects unsupported capabilities and commits nothing", async () => {
  const { repo, co } = await fixture();
  const h = createGitHandler(repo, { authorizePush: () => true });
  const command = `${"0".repeat(40)} ${co} refs/heads/side`;
  const post = (
    body: Uint8Array,
    headers = { "content-type": "application/x-git-receive-pack-request" },
  ) =>
    h(
      new Request("https://x/repo.git/git-receive-pack", {
        method: "POST",
        headers,
        body: body.slice().buffer,
      }),
    );
  assert.equal((await post(pkt(command))).status, 400);
  assert.equal(
    (await post(cat(pkt(`${command}\0report-status-v2`), flush()))).status,
    400,
  );
  assert.equal(
    (await post(cat(pkt(command), flush()), { "content-type": "text/plain" }))
      .status,
    415,
  );
  assert.equal((await repo.load()).sequence, 1);
});

test("advertisement never claims multi_ack, no-done or receive sideband", async () => {
  const { repo } = await fixture();
  const h = createGitHandler(repo);
  const upload = await (
    await h(new Request("https://x/repo.git/info/refs?service=git-upload-pack"))
  ).text();
  const receive = await (
    await h(
      new Request("https://x/repo.git/info/refs?service=git-receive-pack"),
    )
  ).text();
  assert.match(upload, /allow-reachable-sha1-in-want/);
  assert.doesNotMatch(upload, /multi_ack|no-done|report-status/);
  assert.match(receive, /report-status delete-refs ofs-delta atomic/);
  assert.doesNotMatch(receive, /side-band|report-status-v2|filter/);
});

test("explicit HEAD follows the selected branch when its Git data exists", async () => {
  const { repo, co } = await fixture();
  await repo.commit({
    id: "head",
    updates: [{ name: "refs/heads/develop", old: null, new: co }],
  });
  const h = createGitHandler(repo, { headRef: "refs/heads/develop" });
  const body = await (
    await h(new Request("https://x/repo.git/info/refs?service=git-upload-pack"))
  ).text();
  assert.match(body, /symref=HEAD:refs\/heads\/develop/);
  assert.match(body, new RegExp(`${co} HEAD`));
  assert.throws(
    () => createGitHandler(repo, { headRef: "refs/tags/v1" }),
    /HEAD must name a branch/,
  );
});
