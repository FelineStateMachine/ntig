import test from "node:test";
import assert from "node:assert/strict";
import { encodePack } from "../src/git/encode.ts";
import { decodePack, readObjects } from "../src/git/pack.ts";
import { NativeGitEngine } from "../src/git/engine.ts";

test("encodePack and decodePack preserve large objects", async () => {
  const data = new Uint8Array(300);
  data.fill(0x61);
  const pack = await encodePack([{ type: "blob", data }]);
  const objects = await decodePack(pack);
  assert.equal(objects.length, 1);
  assert.equal(objects[0]!.type, "blob");
  assert.deepEqual(objects[0]!.data, data);
});

test("readObjects combines packs and verifies reachable commits", async () => {
  const blob = new TextEncoder().encode("hello\n");
  const blobOid = ""; // The engine computes and indexes the canonical object id.
  const tree = new Uint8Array([
    ...new TextEncoder().encode("100644 file\0"),
    ...(await sha1Object("blob", blob)),
  ]);
  const treePack = await encodePack([
    { type: "blob", data: blob },
    { type: "tree", data: tree },
  ]);
  const treeObj = (await decodePack(treePack)).find((x) => x.type === "tree")!;
  const commit = new TextEncoder().encode(
    `tree ${treeObj.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\nmessage\n`,
  );
  const commitPack = await encodePack([{ type: "commit", data: commit }]);
  const all = await readObjects([treePack, commitPack]);
  assert.equal(all.size, 3);
  await new NativeGitEngine().verify([treePack, commitPack], {
    "refs/heads/main": (await decodePack(commitPack))[0]!.oid,
  });
  void blobOid;
});

async function sha1Object(type: string, data: Uint8Array) {
  const h = new TextEncoder().encode(`${type} ${data.length}\0`);
  const all = new Uint8Array(h.length + data.length);
  all.set(h);
  all.set(data, h.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-1", all));
}
