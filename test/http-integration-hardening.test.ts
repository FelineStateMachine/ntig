import assert from "node:assert/strict";
import test from "node:test";
import { createGitHandler, type GitHttpMeterEvent } from "../src/http.ts";
import {
  IntegrityError,
  type GitRepository,
  type Snapshot,
} from "../src/contracts.ts";

const oid = "1".repeat(40);

function repository(snapshot: Partial<Snapshot> = {}): GitRepository {
  return {
    async load() {
      return {
        sequence: 0,
        tip: null,
        version: null,
        refs: {},
        records: [],
        packs: [],
        ...snapshot,
      };
    },
    async commit() {
      return { id: "test", sequence: 1, replayed: false };
    },
  };
}

test("observe reports bounded request/response bytes and stable error code", async () => {
  const events: GitHttpMeterEvent[] = [];
  const handler = createGitHandler(repository(), {
    observe: (event) => events.push(event),
  });
  const response = await handler(
    new Request("https://nostrwal.test/repo.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: "not-a-pkt",
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(events, [
    {
      requestBytes: 9,
      responseBytes: Number(response.headers.get("content-length")),
      status: 400,
      errorCode: "INVALID_DATA",
    },
  ]);
});

test("maxResponseBytes converts oversized responses into bounded 413 errors", async () => {
  const events: GitHttpMeterEvent[] = [];
  const handler = createGitHandler(repository(), {
    maxResponseBytes: 1,
    observe: (event) => events.push(event),
  });
  const response = await handler(
    new Request(
      "https://nostrwal.test/repo.git/info/refs?service=git-upload-pack",
    ),
  );
  assert.equal(response.status, 413);
  assert.ok(
    Number(response.headers.get("content-length")) <=
      1 + new TextEncoder().encode("Response byte limit exceeded\n").length,
  );
  assert.equal(events.at(-1)?.errorCode, "LIMIT_EXCEEDED");
  assert.equal(events.at(-1)?.status, 413);
});

test("HTTP limits can use a configured native Git capacity profile", () => {
  assert.doesNotThrow(() =>
    createGitHandler(repository(), {
      maxObjects: 131_072,
      maxRefs: 4096,
      maxGraphEdges: 1_000_000,
      gitLimits: {
        maxPackBytes: 64 * 1024 * 1024,
        maxObjectBytes: 32 * 1024 * 1024,
        maxTotalObjectBytes: 128 * 1024 * 1024,
        maxObjects: 1_000_000,
        maxPacks: 1024,
        maxTotalPackBytes: 256 * 1024 * 1024,
      },
    }),
  );
  assert.throws(
    () => createGitHandler(repository(), { gitLimits: { maxObjectBytes: 0 } }),
    /Invalid native Git limit/,
  );
});

test("stream upload-pack hook runs before the buffered request path", async () => {
  let received:
    Readonly<{ maxObjects: number; maxPackBytes: number }> | undefined;
  const handler = createGitHandler(repository(), {
    streamUploadPack: async (_request, options) => {
      received = {
        maxObjects: options.maxObjects,
        maxPackBytes: options.gitLimits.maxPackBytes,
      };
      return new Response("streamed", {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    },
  });
  const result = await handler(
    new Request("https://nostrwal.test/repo.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: "not buffered",
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "streamed");
  assert.deepEqual(received, {
    maxObjects: 131_072,
    maxPackBytes: 32 * 1024 * 1024,
  });
});

test("streamed responses report bytes when the consumer reaches EOF", async () => {
  const events: GitHttpMeterEvent[] = [];
  const handler = createGitHandler(repository(), {
    observe: (event) => events.push(event),
    streamUploadPack: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5]));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-git-upload-pack-result" } },
      ),
  });
  const result = await handler(
    new Request("https://nostrwal.test/repo.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: "0000",
    }),
  );
  assert.deepEqual(
    [...new Uint8Array(await result.arrayBuffer())],
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(events, [
    { requestBytes: 0, responseBytes: 5, status: 200 },
  ]);
});

test("explicit null HEAD suppresses heuristics and accepted HEAD overrides options", async () => {
  const noHead = createGitHandler(
    repository({
      refs: { "refs/heads/main": oid },
      headRef: null,
    }),
    { headRef: "refs/heads/main" },
  );
  const noHeadBody = await (
    await noHead(
      new Request(
        "https://nostrwal.test/repo.git/info/refs?service=git-upload-pack",
      ),
    )
  ).text();
  assert.doesNotMatch(noHeadBody, /symref=HEAD/);

  const acceptedHead = createGitHandler(
    repository({
      refs: { "refs/heads/main": oid, "refs/heads/dev": oid },
      headRef: "refs/heads/dev",
    }),
    { headRef: "refs/heads/main" },
  );
  const acceptedBody = await (
    await acceptedHead(
      new Request(
        "https://nostrwal.test/repo.git/info/refs?service=git-upload-pack",
      ),
    )
  ).text();
  assert.match(acceptedBody, /symref=HEAD:refs\/heads\/dev/);
  assert.match(acceptedBody, new RegExp(oid + " HEAD\\0"));
});

test("repository corruption is unavailable and backend details stay private", async () => {
  const handler = createGitHandler({
    async load() {
      throw new IntegrityError("secret backend corruption detail");
    },
    async commit() {
      return { id: "test", sequence: 1, replayed: false };
    },
  });
  const response = await handler(
    new Request(
      "https://nostrwal.test/repo.git/info/refs?service=git-upload-pack",
    ),
  );
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.doesNotMatch(body, /secret backend corruption detail/);
  assert.equal(body, "Repository unavailable; push outcome may be unknown\n");
});
