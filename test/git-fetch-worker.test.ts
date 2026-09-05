import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { encodePack, readObjects } from "../src/git/index.ts";

test("workerd fetches verified Git data into an accepted PR namespace and R2 survives restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ntig-fetch-workerd-"));
  const outfile = join(directory, "worker.js");
  await build({
    entryPoints: ["test/fixtures/git-fetch-worker.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const contents = new Uint8Array(await readFile(outfile));
  const create = () =>
    new Miniflare({
      resourcePersistencePath: join(directory, "persist"),
      workers: [
        {
          config: {
            type: "worker",
            name: "git-fetch-test",
            compatibilityDate: "2026-09-04",
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents } },
            },
            env: { WAL: { type: "r2", name: "WAL" } },
          },
          dev: { rootPath: directory },
        },
      ],
    });
  let mf = create();
  t.after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const pack = await encodePack([
    { type: "blob", data: new TextEncoder().encode("remote data") },
  ]);
  const tip = [...(await readObjects([pack])).keys()][0]!;
  const response = await mf.dispatchFetch("https://test.example/", {
    method: "POST",
    body: pack.slice().buffer,
    headers: { "x-test-tip": tip },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const result = JSON.parse(body);
  assert.deepEqual(result.refs, { [`refs/nostr/${"a".repeat(64)}`]: tip });
  assert.equal(result.meter.requests, 2);
  assert.ok(result.meter.responseBytes > pack.length);
  await mf.dispose();
  mf = create();
  const restored = await mf.dispatchFetch("https://test.example/", {
    headers: { "x-test-tip": tip },
  });
  const view = (await restored.json()) as {
    refs: Record<string, string>;
    headRef: null;
  };
  assert.deepEqual(view.refs, result.refs);
  assert.equal(view.headRef, null);
});
