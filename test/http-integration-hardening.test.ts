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

test("HTTP limits cannot exceed bounded native Git ceilings", () => {
  assert.throws(
    () => createGitHandler(repository(), { maxObjects: 4097 }),
    /exceed native Git support/,
  );
  assert.throws(
    () => createGitHandler(repository(), { maxRefs: 1025 }),
    /exceed native Git support/,
  );
  assert.throws(
    () => createGitHandler(repository(), { maxGraphEdges: 65_537 }),
    /exceed native Git support/,
  );
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
