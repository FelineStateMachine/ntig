import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { bech32 } from "@scure/base";

const execFile = promisify(execFileCallback);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(args: string[], cwd?: string) {
  return execFile("git", args, {
    cwd,
    env: gitEnv,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
const auth = ["-c", "http.extraHeader=Authorization: Bearer test-only-token"];
const canonicalNpub = bech32.encodeFromBytes(
  "npub",
  new Uint8Array(32).fill(7),
);
const canonicalPath = `/${canonicalNpub}/docs%2Fspace%20caf%C3%A9.git`;

async function workerBundle(
  dir: string,
): Promise<{ path: string; contents: Uint8Array }> {
  const outfile = join(dir, "worker.js");
  await build({
    entryPoints: ["src/worker.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  // Ensure this is genuinely a bundled Worker and not an accidental source
  // import that Miniflare could resolve with Node semantics.
  assert.match(await readFile(outfile, "utf8"), /WalRepository/);
  return { path: outfile, contents: new Uint8Array(await readFile(outfile)) };
}

test("worker runs in workerd with R2 and fails closed for pushes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nostrwal-worker-"));
  const persist = await mkdtemp(join(tmpdir(), "nostrwal-r2-"));
  const bundle = await workerBundle(dir);
  const create = () =>
    new Miniflare({
      resourcePersistencePath: persist,
      workers: [
        {
          config: {
            type: "worker",
            name: "nostrwal",
            compatibilityDate: "2026-09-04",
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": { type: "esm", contents: bundle.contents },
              },
            },
            env: { WAL: { type: "r2", name: "WAL" } },
          },
          dev: { rootPath: dir },
        },
      ],
    });
  const mf = create();
  let active = mf;
  t.after(async () => {
    await active.dispose();
    await rm(dir, { recursive: true, force: true });
    await rm(persist, { recursive: true, force: true });
  });

  const health = await mf.dispatchFetch("https://nostrwal.test/healthz");
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok\n");

  const unauth = await mf.dispatchFetch(
    "https://nostrwal.test/repo.git/git-receive-pack",
    {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    },
  );
  assert.equal(unauth.status, 403);
  assert.equal(unauth.headers.get("access-control-allow-origin"), "*");
  const discovery = await mf.dispatchFetch("https://nostrwal.test/", {
    headers: { Accept: "application/nostr+json" },
  });
  assert.equal(discovery.headers.get("content-type"), "application/nostr+json");
  const information = (await discovery.json()) as {
    supported_grasps: string[];
    supported_nips: number[];
  };
  assert.deepEqual(information.supported_grasps, []);
  assert.deepEqual(information.supported_nips, []);
  assert.equal(
    (
      await mf.dispatchFetch("https://nostrwal.test/unknown", {
        method: "OPTIONS",
      })
    ).status,
    204,
  );
  const missing = await mf.dispatchFetch("https://nostrwal.test/missing.git");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("access-control-allow-origin"), "*");

  await mf.dispose();

  // A fresh workerd instance points at the same persisted R2 directory.
  const restarted = create();
  active = restarted;
  const healthAfterRestart = await restarted.dispatchFetch(
    "https://nostrwal.test/healthz",
  );
  assert.equal(healthAfterRestart.status, 200);
});

test("Git push and clone survive a workerd restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nostrwal-git-"));
  const persist = await mkdtemp(join(tmpdir(), "nostrwal-git-r2-"));
  const bundle = await workerBundle(dir);
  const create = () =>
    new Miniflare({
      resourcePersistencePath: persist,
      workers: [
        {
          config: {
            type: "worker",
            name: "nostrwal",
            compatibilityDate: "2026-09-04",
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": { type: "esm", contents: bundle.contents },
              },
            },
            env: {
              WAL: { type: "r2", name: "WAL" },
              PUSH_TOKEN: { type: "text", value: "test-only-token" },
              REPOSITORY_NPUB: { type: "text", value: canonicalNpub },
              REPOSITORY_IDENTIFIER: { type: "text", value: "docs/space café" },
            },
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
        `http://nostrwal.test${incoming.url}`,
        init,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(
        `bridge failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(async () => {
    await mf.dispose().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await rm(persist, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const remote = `http://127.0.0.1:${address.port}${canonicalPath}`;
  const landing = await mf.dispatchFetch(
    `https://nostrwal.test${canonicalPath}`,
  );
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get("content-type")!, /text\/html/);
  assert.equal(
    (
      await mf.dispatchFetch(
        "https://nostrwal.test/repo.git/info/refs?service=git-upload-pack",
      )
    ).status,
    404,
  );
  const source = join(dir, "source");
  const clone = join(dir, "clone");
  await git(["init", "-b", "main", source]);
  await git(["config", "user.email", "test@example.invalid"], source);
  await git(["config", "user.name", "Nostrwal Test"], source);
  await git(["config", "commit.gpgsign", "false"], source);
  await writeFile(join(source, "README"), "one\n");
  await git(["add", "README"], source);
  await git(["commit", "-m", "one"], source);
  await assert.rejects(
    git(
      [
        "-c",
        "http.extraHeader=Authorization: Bearer wrong",
        "push",
        remote,
        "HEAD:refs/heads/denied",
      ],
      source,
    ),
  );
  await git([...auth, "push", remote, "HEAD:refs/heads/main"], source);
  await git(["clone", remote, clone]);
  const firstHead = (await git(["rev-parse", "HEAD"], clone)).stdout.trim();
  assert.equal(await readFile(join(clone, "README"), "utf8"), "one\n");
  await git(["fsck", "--full"], clone);

  await writeFile(join(source, "README"), "two\n");
  await git(["add", "README"], source);
  await git(["commit", "-m", "two"], source);
  const secondHead = (await git(["rev-parse", "HEAD"], source)).stdout.trim();
  assert.notEqual(secondHead, firstHead);
  await git([...auth, "push", remote, "HEAD:refs/heads/main"], source);
  await git(["-C", clone, "pull", "--ff-only", "origin", "main"]);
  assert.equal(
    (await git(["rev-parse", "HEAD"], clone)).stdout.trim(),
    secondHead,
  );
  assert.equal(await readFile(join(clone, "README"), "utf8"), "two\n");

  await git(["tag", "-a", "release-1", "-m", "release"], source);
  await git(["switch", "-c", "side"], source);
  await writeFile(join(source, "SIDE"), "side\n");
  await git(["add", "SIDE"], source);
  await git(["commit", "-m", "side"], source);
  await git(
    [...auth, "push", remote, "HEAD:refs/heads/side", "refs/tags/release-1"],
    source,
  );
  await git(["switch", "main"], source);
  await git(
    [
      ...auth,
      "push",
      "--atomic",
      remote,
      "HEAD:refs/heads/atomic-a",
      "HEAD:refs/heads/atomic-b",
    ],
    source,
  );
  const atomicRefs = (await git(["ls-remote", "--heads", remote, "atomic-*"]))
    .stdout;
  assert.match(atomicRefs, /refs\/heads\/atomic-a/);
  assert.match(atomicRefs, /refs\/heads\/atomic-b/);
  await git([...auth, "push", remote, ":refs/heads/side"], source);
  assert.equal(
    (await git(["ls-remote", "--heads", remote, "side"])).stdout,
    "",
  );
  await git(
    [...auth, "push", "--force", remote, `${firstHead}:refs/heads/main`],
    source,
  );
  assert.match(
    (await git(["ls-remote", "--heads", remote, "main"])).stdout,
    new RegExp(firstHead),
  );
  await git(
    [...auth, "push", "--force", remote, `${secondHead}:refs/heads/main`],
    source,
  );

  await mf.dispose();
  mf = create();
  const fresh = join(dir, "fresh-clone");
  await git(["clone", remote, fresh]);
  await git(["fsck", "--full"], fresh);
  assert.equal((await git(["show", "HEAD:README"], fresh)).stdout, "two\n");
  await git(["fetch", "origin", "tag", "release-1"], fresh);
  assert.equal(
    (await git(["cat-file", "-t", "refs/tags/release-1"], fresh)).stdout.trim(),
    "tag",
  );

  const filtered = join(dir, "filtered-clone");
  const filteredResult = await git([
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    remote,
    filtered,
  ]);
  assert.equal(
    filteredResult.stderr.includes("filtering not recognized") ||
      filteredResult.stderr.includes("does not support"),
    false,
    filteredResult.stderr,
  );
  await git(["checkout", "main"], filtered);
  assert.equal(await readFile(join(filtered, "README"), "utf8"), "two\n");
  const treeless = join(dir, "treeless-clone");
  const treelessResult = await git([
    "clone",
    "--filter=tree:0",
    "--no-checkout",
    remote,
    treeless,
  ]);
  assert.doesNotMatch(
    treelessResult.stderr,
    /filtering not recognized|does not support/,
  );
  await git(["checkout", "main"], treeless);
  assert.equal(await readFile(join(treeless, "README"), "utf8"), "two\n");
});
