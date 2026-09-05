import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fetchGitPack, type GitFetchMeterEvent } from "../src/git-fetch.ts";
import {
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
} from "../src/contracts.ts";
import { gitHttpInternals } from "../src/http.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { WalRepository } from "../src/wal.ts";
import { NativeGitEngine } from "../src/git/engine.ts";
import { readObjects } from "../src/git/pack.ts";
import { encodePack } from "../src/git/encode.ts";

const { pkt, flush } = gitHttpInternals;
const enc = new TextEncoder();
const cat = (...bytes: Uint8Array[]) => new Uint8Array(Buffer.concat(bytes));
const BASE = "https://git.example/repo.git";
const AD = "application/x-git-upload-pack-advertisement";
const RESULT = "application/x-git-upload-pack-result";
const response = (body: Uint8Array, type: string) =>
  new Response(body.slice().buffer, { headers: { "content-type": type } });
const ad = (oid: string, caps = "side-band-64k ofs-delta") =>
  cat(
    pkt("# service=git-upload-pack\n"),
    flush(),
    pkt(`${oid} refs/heads/main\0${caps}\n`),
    flush(),
  );

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ntig-fetch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (args: string[], input?: Uint8Array) => {
    const run = spawnSync("git", ["-C", directory, ...args], {
      input,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    assert.equal(run.status, 0, run.stderr?.toString());
    return new Uint8Array(run.stdout);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  for (let i = 0; i < 3; i++) {
    writeFileSync(
      join(directory, "file.txt"),
      "same\n".repeat(200) + `change ${i}\n`,
    );
    git(["add", "."]);
    git(["commit", "-qm", `commit ${i}`]);
  }
  git(["tag", "-am", "release", "v1"]);
  const tip = Buffer.from(git(["rev-parse", "HEAD"]))
    .toString()
    .trim();
  const advertisement = cat(
    pkt("# service=git-upload-pack\n"),
    flush(),
    git(["upload-pack", "--stateless-rpc", "--advertise-refs", "."]),
  );
  const requests: Request[] = [];
  const serve = async (request: Request) => {
    requests.push(request);
    assert.equal(request.redirect, "manual");
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("git-protocol"), null);
    if (request.method === "GET") return response(advertisement, AD);
    const body = new Uint8Array(await request.arrayBuffer());
    const text = Buffer.from(body).toString();
    assert.doesNotMatch(text, /thin-pack|deepen|filter|have /);
    return response(git(["upload-pack", "--stateless-rpc", "."], body), RESULT);
  };
  return { git, tip, advertisement, serve, requests };
}

test("fetches a complete native Git pack and publishes only the host's selected ref", async (t) => {
  const f = fixture(t);
  const meters: GitFetchMeterEvent[] = [];
  const result = await fetchGitPack(BASE + "/", {
    wants: [f.tip],
    fetch: f.serve,
    observe: (e) => meters.push(e),
  });
  assert.equal(result.refs["refs/heads/main"], f.tip);
  assert.equal(result.headRef, "refs/heads/main");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0]!.url, `${BASE}/info/refs?service=git-upload-pack`);
  const wal = new WalRepository(new MemoryStore(), new NativeGitEngine());
  await wal.commit({
    id: "import",
    updates: [{ name: "refs/heads/signed", old: null, new: f.tip }],
    pack: result.pack,
  });
  assert.deepEqual(
    { ...(await wal.loadRefs()).refs },
    { "refs/heads/signed": f.tip },
  );
  assert.equal(meters[0]!.requests, 2);
  assert.ok(meters[0]!.responseBytes > result.pack.length);
  assert.ok(meters[0]!.requestBytes > 0);
  const objects = await readObjects([result.pack]);
  assert.equal(objects.get(f.tip)!.type, "commit");
});

test("supports raw pack responses without sideband and rejects missing wanted objects", async () => {
  const pack = await encodePack([
    { type: "blob", data: enc.encode("payload") },
  ]);
  const tip = [...(await readObjects([pack])).keys()][0]!;
  const fetcher = async (request: Request) =>
    response(
      request.method === "GET"
        ? ad(tip, "allow-reachable-sha1-in-want")
        : cat(pkt("NAK\n"), pack),
      request.method === "GET" ? AD : RESULT,
    );
  assert.equal(
    (await fetchGitPack(BASE, { wants: [tip], fetch: fetcher })).pack.length,
    pack.length,
  );
  await assert.rejects(
    fetchGitPack(BASE, { wants: ["1".repeat(40)], fetch: fetcher }),
    IntegrityError,
  );
});

test("rejects corrupted packs and truncated sideband responses", async (t) => {
  const f = fixture(t);
  for (const mode of ["checksum", "truncated", "error-channel", "extra-data"]) {
    await assert.rejects(
      fetchGitPack(BASE, {
        wants: [f.tip],
        fetch: async (request) => {
          const r = await f.serve(request);
          if (request.method === "GET") return r;
          let bytes = new Uint8Array(await r.arrayBuffer());
          if (mode === "checksum")
            bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 1;
          if (mode === "truncated") bytes = bytes.slice(0, -4);
          if (mode === "extra-data") bytes = cat(bytes, enc.encode("bad"));
          if (mode === "error-channel")
            bytes = cat(
              pkt("NAK\n"),
              pkt(cat(Uint8Array.of(3), enc.encode("remote error"))),
              flush(),
            );
          return response(bytes, RESULT);
        },
      }),
      mode === "error-channel" ? RepositoryUnavailableError : IntegrityError,
    );
  }
});

test("bounds advertisements, wire progress and decoded pack bytes", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    fetchGitPack(BASE, {
      wants: [f.tip],
      fetch: f.serve,
      maxAdvertisementBytes: 16,
    }),
    LimitError,
  );
  await assert.rejects(
    fetchGitPack(BASE, { wants: [f.tip], fetch: f.serve, maxPackBytes: 32 }),
    LimitError,
  );
  const meters: GitFetchMeterEvent[] = [];
  let cancelled = false;
  await assert.rejects(
    fetchGitPack(BASE, {
      wants: [f.tip],
      maxResponseBytes: 32,
      observe: (e) => meters.push(e),
      fetch: async (request) => {
        if (request.method === "GET") return f.serve(request);
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(33));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": RESULT } },
        );
      },
    }),
    LimitError,
  );
  assert.equal(cancelled, true);
  assert.equal(meters[0]!.errorCode, "LIMIT_EXCEEDED");
  assert.ok(meters[0]!.responseBytes >= 33);
});

test("rejects oversized content length before consuming the body", async () => {
  let cancelled = false;
  await assert.rejects(
    fetchGitPack(BASE, {
      wants: ["1".repeat(40)],
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": AD, "content-length": "10000000" } },
        ),
    }),
    LimitError,
  );
  assert.equal(cancelled, true);
});

test("refuses redirects, credentials, non-HTTPS URLs and unsupported responses", async (t) => {
  const f = fixture(t);
  for (const url of [
    "http://git.example/repo",
    "https://user:pass@git.example/repo",
    BASE + "?token=x",
    BASE + "#fragment",
  ]) {
    await assert.rejects(
      fetchGitPack(url, { wants: [f.tip], fetch: f.serve }),
      IntegrityError,
    );
  }
  assert.equal(f.requests.length, 0);
  for (const status of [301, 302, 401, 404, 500]) {
    await assert.rejects(
      fetchGitPack(BASE, {
        wants: [f.tip],
        fetch: async () =>
          new Response(null, {
            status,
            headers: { location: "https://elsewhere.invalid/" },
          }),
      }),
      RepositoryUnavailableError,
    );
  }
  for (const headers of [
    { "content-type": "text/html" },
    { "content-type": AD, "content-encoding": "gzip" },
  ]) {
    await assert.rejects(
      fetchGitPack(BASE, {
        wants: [f.tip],
        fetch: async () =>
          new Response(f.advertisement.slice().buffer, { headers }),
      }),
      RepositoryUnavailableError,
    );
  }
});

test("rejects malformed refs, duplicate capabilities, SHA-256 and unadvertised wants before POST", async () => {
  const tip = "1".repeat(40);
  const inputs = [
    ad(tip, "object-format=sha256"),
    ad(tip, "ofs-delta ofs-delta"),
    cat(
      pkt("# service=git-upload-pack\n"),
      flush(),
      pkt(`${tip} refs/heads/../escape\0ofs-delta\n`),
      flush(),
    ),
    cat(
      pkt("# service=git-upload-pack\n"),
      flush(),
      pkt(`${tip} refs/heads/main\0ofs-delta\n`),
      pkt(`${tip} refs/heads/main\n`),
      flush(),
    ),
    ad("2".repeat(40), "ofs-delta"),
    cat(ad(tip), enc.encode("trailing")),
  ];
  for (const bytes of inputs) {
    let requests = 0;
    await assert.rejects(
      fetchGitPack(BASE, {
        wants: [tip],
        fetch: async (request) => {
          requests++;
          assert.equal(request.method, "GET");
          return response(bytes, AD);
        },
      }),
      IntegrityError,
    );
    assert.equal(requests, 1);
  }
});

test("cancellation interrupts a stalled body and request inputs are captured", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchGitPack(BASE, {
      wants: [f.tip],
      signal: controller.signal,
      fetch: f.serve,
    }),
    { name: "AbortError" },
  );
  assert.equal(f.requests.length, 0);
  let cancelled = false;
  await assert.rejects(
    fetchGitPack(BASE, {
      wants: [f.tip],
      timeoutMs: 10,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": AD } },
        ),
    }),
    { name: "TimeoutError" },
  );
  assert.equal(cancelled, true);
  const wants = [f.tip];
  await fetchGitPack(BASE, {
    wants,
    fetch: async (request) => {
      wants[0] = "2".repeat(40);
      return f.serve(request);
    },
    observe: () => {
      throw new Error("observer");
    },
  });
});
