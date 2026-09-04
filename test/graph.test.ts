import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { encodePack, hex } from "../src/git/encode.ts";
import {
  decodePack,
  type GitObject,
  type GitObjectType,
} from "../src/git/pack.ts";
import { IntegrityError, LimitError } from "../src/contracts.ts";
import { NativeGitEngine, objectLinks, parseTree } from "../src/git/engine.ts";

const enc = new TextEncoder();
async function oid(type: GitObjectType, data: Uint8Array): Promise<string> {
  const h = enc.encode(`${type} ${data.length}\0`);
  const all = new Uint8Array(h.length + data.length);
  all.set(h);
  all.set(data, h.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", all)));
}
async function object(
  type: GitObjectType,
  data: Uint8Array,
): Promise<GitObject> {
  return { type, data, oid: await oid(type, data) };
}
async function pack(objects: readonly GitObject[]): Promise<Uint8Array> {
  return encodePack(objects);
}
async function verify(
  objects: readonly GitObject[],
  ref: string,
  name = "refs/heads/main",
  options = {},
): Promise<void> {
  await new NativeGitEngine(options).verify([await pack(objects)], {
    [name]: ref,
  });
}
function treeEntry(mode: string, name: string, id: string): Uint8Array {
  return new Uint8Array([
    ...enc.encode(`${mode} ${name}\0`),
    ...Uint8Array.from(id.match(/../g)!, (x) => parseInt(x, 16)),
  ]);
}
async function basicGraph() {
  const blob = await object("blob", enc.encode("content\n"));
  const tree = await object("tree", treeEntry("100644", "file", blob.oid));
  const commit = await object(
    "commit",
    enc.encode(
      `tree ${tree.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\nmessage\n`,
    ),
  );
  return { blob, tree, commit };
}
async function expectIntegrity(
  fn: () => Promise<unknown> | unknown,
  message?: string,
) {
  await assert.rejects(
    Promise.resolve().then(fn),
    (e: unknown) =>
      e instanceof IntegrityError &&
      (!message || (e as Error).message === message),
  );
}

test("valid files and directory tree agree with git fsck", async (t) => {
  try {
    execFileSync("git", ["--version"]);
  } catch {
    t.skip("git unavailable");
    return;
  }
  const blob = await object("blob", enc.encode("x\n"));
  const nested = await object("tree", treeEntry("100644", "z", blob.oid));
  const root = await object(
    "tree",
    new Uint8Array([
      ...treeEntry("100644", "a", blob.oid),
      ...treeEntry("40000", "dir", nested.oid),
    ]),
  );
  const commit = await object(
    "commit",
    enc.encode(
      `tree ${root.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\nok\n`,
    ),
  );
  await verify([blob, nested, root, commit], commit.oid);
  // Git's tree ordering is directory-as-slash; parseTree must accept this canonical order.
  assert.deepEqual(
    parseTree(root.data).map((x) => x.mode),
    ["100644", "40000"],
  );
  const dir = mkdtempSync(`${tmpdir()}/nostrwal-fsck-`);
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    for (const item of [blob, nested, root, commit]) {
      const got = execFileSync(
        "git",
        ["-C", dir, "hash-object", "-w", "--stdin", "-t", item.type],
        { input: item.data, encoding: "utf8" },
      ).trim();
      assert.equal(got, item.oid);
    }
    execFileSync("git", [
      "-C",
      dir,
      "update-ref",
      "refs/heads/main",
      commit.oid,
    ]);
    execFileSync("git", ["-C", dir, "fsck", "--full", "--no-progress"], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing graph objects, wrong types, and invalid branch targets are rejected", async () => {
  const { tree, commit } = await basicGraph();
  await expectIntegrity(
    () => verify([commit], commit.oid),
    `Missing or wrong-type tree: ${tree.oid}`,
  );
  const wrong = await object("blob", new Uint8Array());
  const badCommit = await object(
    "commit",
    enc.encode(
      `tree ${wrong.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\n`,
    ),
  );
  await expectIntegrity(
    () => verify([wrong, badCommit], badCommit.oid),
    `Missing or wrong-type tree: ${wrong.oid}`,
  );
  await expectIntegrity(
    () => verify([wrong], wrong.oid),
    "Branch target must be a commit",
  );
  await verify([wrong], wrong.oid, "refs/tags/blob-tag");
});

test("commit parent lines are headers only; body text does not create dependencies", async () => {
  const { blob, tree } = await basicGraph();
  const commit = await object(
    "commit",
    enc.encode(
      `tree ${tree.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\nparent ${"0".repeat(40)}\nnot utf8 follows\n`,
    ),
  );
  await verify([blob, tree, commit], commit.oid);
  assert.equal(objectLinks(commit).length, 1);
  const nonUtf8 = new Uint8Array([
    ...enc.encode(
      `tree ${tree.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\n`,
    ),
    0xff,
    0xfe,
  ]);
  const binaryCommit = await object("commit", nonUtf8);
  await verify([blob, tree, binaryCommit], binaryCommit.oid);
});

test("annotated tags validate target type and can be refs", async () => {
  const blob = await object("blob", enc.encode("x"));
  const tag = await object(
    "tag",
    enc.encode(
      `object ${blob.oid}\ntype blob\ntag release\ntagger A <a@b> 0 +0000\n\nnotes\n`,
    ),
  );
  await verify([blob, tag], tag.oid, "refs/tags/release");
  const bad = await object(
    "tag",
    enc.encode(`object ${blob.oid}\ntype tree\ntag release\n\n`),
  );
  await expectIntegrity(
    () => verify([blob, bad], bad.oid, "refs/tags/release"),
    `Missing or wrong-type tree: ${blob.oid}`,
  );
});

test("external gitlinks are allowed without local objects", async () => {
  const tree = await object(
    "tree",
    treeEntry(
      "160000",
      "submodule",
      "1234567890abcdef1234567890abcdef12345678",
    ),
  );
  const commit = await object(
    "commit",
    enc.encode(
      `tree ${tree.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\n`,
    ),
  );
  await verify([tree, commit], commit.oid);
});

test("tree names, modes, duplicates, and ordering are hardened", async () => {
  const validOid = "1234567890abcdef1234567890abcdef12345678";
  for (const [mode, name] of [
    ["100644", "a/b"],
    ["100644", "."],
    ["100644", ".."],
    ["100644", ".git"] as const,
  ]) {
    const data = treeEntry(mode, name, validOid);
    await expectIntegrity(() => parseTree(data));
  }
  for (const mode of ["100600", "000000", "040000", "10064"]) {
    await expectIntegrity(() => parseTree(treeEntry(mode, "a", validOid)));
  }
  const duplicate = new Uint8Array([
    ...treeEntry("100644", "a", validOid),
    ...treeEntry("100755", "a", validOid),
  ]);
  await expectIntegrity(() => parseTree(duplicate), "Duplicate tree entry");
  const wrongSort = new Uint8Array([
    ...treeEntry("100644", "b", validOid),
    ...treeEntry("100644", "a", validOid),
  ]);
  await expectIntegrity(
    () => parseTree(wrongSort),
    "Tree entries are not sorted",
  );
});

test("tree entry type mismatches and ref namespace parent/sub collisions reject", async () => {
  const blob = await object("blob", enc.encode("x"));
  const tree = await object("tree", treeEntry("40000", "dir", blob.oid));
  const commit = await object(
    "commit",
    enc.encode(
      `tree ${tree.oid}\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\n`,
    ),
  );
  await expectIntegrity(
    () => verify([blob, tree, commit], commit.oid),
    `Missing or wrong-type tree: ${blob.oid}`,
  );
  const valid = await basicGraph();
  const validPack = await pack([valid.blob, valid.tree, valid.commit]);
  await assert.rejects(
    () =>
      new NativeGitEngine().verify([validPack], {
        "refs/heads/main": valid.commit.oid,
        "refs/heads/main/x": valid.commit.oid,
      }),
    /Ref namespace collision/,
  );
});

test("deep commit history is checked iteratively", async () => {
  const { blob, tree } = await basicGraph();
  const commits: GitObject[] = [];
  let parent: string | undefined;
  for (let i = 0; i < 3_000; i++) {
    const body = `tree ${tree.oid}\n${parent ? `parent ${parent}\n` : ""}author A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\n${i}\n`;
    const commit = await object("commit", enc.encode(body));
    commits.push(commit);
    parent = commit.oid;
  }
  const packs: Uint8Array[] = [];
  for (let i = 0; i < commits.length; i += 500)
    packs.push(
      await pack([
        ...(i === 0 ? [blob, tree] : []),
        ...commits.slice(i, i + 500),
      ]),
    );
  await new NativeGitEngine({ maxGraphEdges: 10_000 }).verify(packs, {
    "refs/heads/main": parent!,
  });
});

test("graph edge limits are public LimitErrors", async () => {
  const { tree, commit } = await basicGraph();
  await assert.rejects(
    () =>
      verify([tree, commit], commit.oid, "refs/heads/main", {
        maxGraphEdges: 1,
      }),
    (e: unknown) => e instanceof LimitError,
  );
});
