import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { InventoryReport } from "../src/inventory.ts";
const runExecFile = promisify(execFileCallback);
const execFile = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
) =>
  runExecFile(file, args, {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

test("checkpoint migration bounds WAL history and survives workerd restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nostrwal-checkpoint-"));
  const persist = await mkdtemp(join(tmpdir(), "nostrwal-checkpoint-r2-"));
  const outfile = join(dir, "worker.js");
  await build({
    entryPoints: ["test/fixtures/checkpoint-worker.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const contents = new Uint8Array(await readFile(outfile));
  const create = () =>
    new Miniflare({
      resourcePersistencePath: persist,
      workers: [
        {
          config: {
            type: "worker",
            name: "checkpoint-test",
            compatibilityDate: "2026-09-04",
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents } },
            },
            env: { WAL: { type: "r2", name: "WAL" } },
          },
          dev: { rootPath: dir },
        },
      ],
    });
  let mf = create();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(incoming.headers))
        if (typeof value === "string") headers[key] = value;
      const init: NonNullable<Parameters<Miniflare["dispatchFetch"]>[1]> = {
        method: incoming.method ?? "GET",
        headers,
      };
      if (
        chunks.length &&
        incoming.method !== "GET" &&
        incoming.method !== "HEAD"
      ) {
        const bytes = Buffer.concat(chunks);
        init.body = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      }
      const response = await mf.dispatchFetch(
        `http://checkpoint.test${incoming.url}`,
        init,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await mf.dispose().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await rm(persist, { recursive: true, force: true });
  });
  const call = async (body: object) => {
    const response = await mf.dispatchFetch("https://checkpoint.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const inventory = async (format: 1 | 2, sequence: number) => {
    const bucket = await mf.getR2Bucket("WAL");
    const rootKey = "checkpoint-test/repos/test/root.json";
    const before = await bucket.get(rootKey);
    assert.ok(before);
    const rootBytes = await before.arrayBuffer();
    const report = (await call({
      op: "inventory",
    })) as unknown as InventoryReport & {
      testGets: number;
      testPuts: number;
    };
    assert.equal(report.format, format);
    assert.equal(report.sequence, sequence);
    assert.equal(report.validation, "metadata-and-pack-hashes");
    assert.equal(report.authority, false);
    assert.equal(report.gcCandidate, false);
    assert.equal(report.testPuts, 0);
    assert.equal(report.testGets, report.observed.gets);
    assert.equal(report.live.byKind.records.keys, sequence);
    assert.equal(report.live.byKind.packs.keys, 1);
    assert.equal(report.live.byKind.manifests.keys, format === 2 ? 1 : 0);
    for (const field of ["keys", "bytes"] as const) {
      assert.equal(
        report.listed[field],
        report.live[field] + report.unreferenced[field] + report.unknown[field],
      );
      for (const total of [
        report.listed,
        report.live,
        report.unreferenced,
        report.unknown,
      ])
        assert.equal(
          total[field],
          Object.values(total.byKind).reduce(
            (sum, kind) => sum + kind[field],
            0,
          ),
        );
    }
    const after = await bucket.get(rootKey);
    assert.ok(after);
    assert.equal(after.etag, before.etag);
    assert.deepEqual(await after.arrayBuffer(), rootBytes);
    return report;
  };
  const source = join(dir, "source");
  await execFile("git", ["init", "-b", "main", source]);
  await execFile("git", [
    "-C",
    source,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await execFile("git", [
    "-C",
    source,
    "config",
    "user.name",
    "Checkpoint Test",
  ]);
  await writeFile(join(source, "README"), "checkpoint\n");
  await execFile("git", ["-C", source, "add", "README"]);
  await execFile("git", ["-C", source, "commit", "-m", "checkpoint"]);
  await execFile("git", ["-C", source, "gc"]);
  const packName = (
    await readdir(join(source, ".git", "objects", "pack"))
  ).find((name) => name.endsWith(".pack"));
  if (!packName) throw new Error("git gc did not create a pack");
  const pack = Buffer.from(
    await readFile(join(source, ".git", "objects", "pack", packName)),
  ).toString("base64");
  const head = (
    await execFile("git", ["-C", source, "rev-parse", "HEAD"])
  ).stdout.trim();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const remote = `http://127.0.0.1:${address.port}/repo.git`;
  const initial = await call({
    op: "commit",
    id: "initial-pack",
    name: "refs/heads/main",
    old: null,
    new: head,
    pack,
  });
  assert.equal(initial.replayed, false);
  assert.equal(initial.sequence, 1);
  for (let i = 1; i < 128; i++)
    await call({ op: "commit", id: `ref-${i}`, name: `refs/heads/test-${i}` });
  assert.equal((await call({ op: "load" })).sequence, 128);
  await inventory(1, 128);
  const migrated = await call({ op: "checkpoint" });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.sequence, 128);
  const after = await call({ op: "load" });
  assert.equal(after.checkpoint, true);
  assert.equal((after.refs as Record<string, string>)["refs/heads/main"], head);
  assert.ok(
    (after.records as number) <= 1,
    `checkpoint retained too many records: ${after.records}`,
  );
  await inventory(2, 128);
  for (let i = 128; i < 138; i++)
    await call({
      op: "commit",
      id: `ref-${i}`,
      name: `refs/heads/test-${i}`,
      new: head,
    });
  assert.equal((await call({ op: "load" })).sequence, 138);
  await mf.dispose();
  mf = create();
  const restartedState = await call({ op: "load" });
  assert.equal(restartedState.checkpoint, true);
  assert.equal(restartedState.sequence, 138);
  await inventory(2, 138);
  const replay = await call({
    op: "commit",
    id: "initial-pack",
    name: "refs/heads/main",
    old: null,
    new: head,
    pack,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.sequence, 1);
  const ad1 = await mf.dispatchFetch(
    "https://checkpoint.test/repo.git/info/refs?service=git-upload-pack",
  );
  const ad2 = await mf.dispatchFetch(
    "https://checkpoint.test/repo.git/info/refs?service=git-upload-pack",
  );
  assert.equal(ad1.status, 200);
  assert.equal(ad2.status, 200);
  assert.equal(ad1.headers.get("x-test-object-gets"), "2");
  assert.equal(ad2.headers.get("x-test-object-gets"), "2");
  assert.deepEqual(
    new Uint8Array(await ad1.arrayBuffer()),
    new Uint8Array(await ad2.arrayBuffer()),
  );
  const clone = join(dir, "post-checkpoint-clone");
  await execFile("git", ["clone", remote, clone], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  await execFile("git", ["-C", clone, "fsck", "--full"], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(await readFile(join(clone, "README"), "utf8"), "checkpoint\n");
  await writeFile(join(clone, "README"), "checkpoint\npost-migration push\n");
  await execFile("git", [
    "-C",
    clone,
    "-c",
    "user.name=Checkpoint Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-am",
    "post-migration",
  ]);
  await execFile("git", ["-C", clone, "push", "origin", "main"]);
  const pushedHead = (
    await execFile("git", ["-C", clone, "rev-parse", "HEAD"])
  ).stdout.trim();
  assert.equal(
    ((await call({ op: "load" })).refs as Record<string, string>)[
      "refs/heads/main"
    ],
    pushedHead,
  );
  const freshClone = join(dir, "post-push-clone");
  await execFile("git", ["clone", remote, freshClone]);
  await execFile("git", ["-C", freshClone, "fsck", "--full"]);
  assert.equal(
    await readFile(join(freshClone, "README"), "utf8"),
    "checkpoint\npost-migration push\n",
  );
  assert.equal((await call({ op: "checkpoint" })).changed, false);
});
