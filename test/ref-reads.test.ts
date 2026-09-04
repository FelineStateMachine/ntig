import assert from "node:assert/strict";
import test from "node:test";
import { createGitHandler } from "../src/http.ts";
import {
  createAcceptedStateRepository,
  type AcceptedState,
} from "../src/grasp/accepted-state.ts";
import type { GitRepository, RefSnapshot, Snapshot } from "../src/contracts.ts";

const oid = "1".repeat(40);
const other = "2".repeat(40);
const event = "a".repeat(64);
const pr = `refs/nostr/${event}`;

function refsSnapshot(): RefSnapshot {
  return {
    sequence: 9,
    tip: null,
    version: "v9",
    refs: { "refs/heads/main": oid, [pr]: other },
    headRef: "refs/heads/main",
  };
}

test("HTTP advertisements use the metadata-only ref view", async () => {
  let loads = 0;
  let refLoads = 0;
  const repo: GitRepository = {
    load: async (): Promise<Snapshot> => {
      loads++;
      return { ...refsSnapshot(), records: [], packs: [] };
    },
    loadRefs: async () => {
      refLoads++;
      return refsSnapshot();
    },
    commit: async () => ({ id: "x", sequence: 1, replayed: false }),
  };
  const handler = createGitHandler(repo);
  const response = await handler(
    new Request(
      "https://example.test/repo.git/info/refs?service=git-upload-pack",
    ),
  );
  const body = new TextDecoder().decode(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(loads, 0);
  assert.equal(refLoads, 1);
  assert.match(body, new RegExp(`${oid} refs/heads/main`));
  assert.match(body, new RegExp(`${other} ${pr}`));
});

test("accepted-state metadata reads preserve HEAD and PR visibility", async () => {
  let loads = 0;
  let refLoads = 0;
  const state: AcceptedState = {
    eventId: "b".repeat(64),
    refs: { "refs/heads/main": oid },
    head: "refs/heads/main",
  };
  const repo: GitRepository = {
    load: async (): Promise<Snapshot> => {
      loads++;
      return { ...refsSnapshot(), records: [], packs: [] };
    },
    loadRefs: async () => {
      refLoads++;
      return refsSnapshot();
    },
    commit: async () => ({ id: "x", sequence: 1, replayed: false }),
  };
  const wrapped = createAcceptedStateRepository(repo, {
    lookupState: async () => state,
    lookupPrTip: async () => oid,
  });
  const view = await wrapped.loadRefs!();
  assert.equal(loads, 0);
  assert.equal(refLoads, 1);
  assert.equal(view.headRef, state.head);
  assert.equal(view.refs["refs/heads/main"], oid);
  assert.equal(view.refs[pr], undefined);
});

test("metadata read failure is unavailable and never falls back to stale full reads", async () => {
  let loads = 0;
  const handler = createGitHandler({
    load: async () => {
      loads++;
      return { ...refsSnapshot(), packs: [], records: [] };
    },
    loadRefs: async () => {
      throw new Error("private-provider-error");
    },
    commit: async () => ({ id: "unused", sequence: 1, replayed: false }),
  });
  const response = await handler(
    new Request(
      "https://example.test/repo.git/info/refs?service=git-upload-pack",
    ),
  );
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-provider-error/);
  assert.equal(loads, 0);
});

test("legacy metadata fallback and authority filtering share the same fence", async () => {
  let locked = false;
  let calls = 0;
  const repo: GitRepository = {
    load: async () => {
      assert.equal(locked, true);
      calls++;
      return { ...refsSnapshot(), packs: [], records: [] };
    },
    commit: async () => ({ id: "unused", sequence: 1, replayed: false }),
  };
  const wrapped = createAcceptedStateRepository(repo, {
    serialize: async (operation) => {
      assert.equal(locked, false);
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    lookupState: async () => {
      assert.equal(locked, true);
      return null;
    },
    lookupPrTip: async () => {
      assert.equal(locked, true);
      return false;
    },
  });
  const result = await wrapped.loadRefs!();
  assert.equal(result.headRef, null);
  assert.equal(result.refs[pr], undefined);
  assert.equal(calls, 1);
  assert.equal(locked, false);
});
