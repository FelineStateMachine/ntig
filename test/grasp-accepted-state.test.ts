import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationError,
  IntegrityError,
  type CommitRequest,
  type GitRepository,
  type Snapshot,
} from "../src/contracts.js";
import {
  createAcceptedStateRepository,
  type AcceptedState,
} from "../src/grasp/accepted-state.js";

const OID = "1".repeat(40);
const OID2 = "2".repeat(40);
const EVENT = "a".repeat(64);
const EVENT2 = "b".repeat(64);

function snapshot(
  refs: Record<string, string>,
  headRef?: string | null,
): Snapshot {
  return {
    sequence: 1,
    tip: null,
    version: "v1",
    refs,
    records: [],
    packs: [],
    ...(headRef === undefined ? {} : { headRef }),
  };
}

function fakeRepo(initial: Snapshot) {
  const calls: CommitRequest[] = [];
  const repo: GitRepository = {
    async load() {
      return initial;
    },
    async commit(request) {
      calls.push(request);
      return { id: request.id, sequence: 2, replayed: false };
    },
  };
  return { repo, calls };
}

function state(
  refs: Record<string, string>,
  head: string | null = null,
): AcceptedState {
  return { eventId: EVENT, refs, head };
}

function request(
  name: string,
  old: string | null,
  next: string | null,
): CommitRequest {
  return { id: "request-1", updates: [{ name, old, new: next }] };
}

test("matches accepted ordinary refs and retains unrelated materialized refs", async () => {
  const { repo, calls } = fakeRepo(
    snapshot({ "refs/heads/main": OID, "refs/heads/legacy": OID2 }),
  );
  const wrapped = createAcceptedStateRepository(repo, {
    lookupState: async () => state({ "refs/heads/main": OID }),
  });
  const loaded = await wrapped.load();
  assert.deepEqual(Object.fromEntries(Object.entries(loaded.refs)), {
    "refs/heads/main": OID,
    "refs/heads/legacy": OID2,
  });
  await wrapped.commit(request("refs/heads/main", OID, OID));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.updates[0]!.old, OID);
});

test("fails closed when authority is absent and only permits accepted state", async () => {
  const { repo, calls } = fakeRepo(snapshot({ "refs/heads/main": OID }));
  const wrapped = createAcceptedStateRepository(repo, {
    lookupState: async () => null,
  });
  await assert.rejects(
    wrapped.commit(request("refs/heads/main", OID, OID)),
    AuthorizationError,
  );
  assert.equal(calls.length, 0);
});

test("ordinary deletion is allowed only when the accepted state is already absent", async () => {
  const { repo: presentRepo } = fakeRepo(snapshot({ "refs/heads/main": OID }));
  const present = createAcceptedStateRepository(presentRepo, {
    lookupState: async () => state({ "refs/heads/main": OID }),
  });
  await assert.rejects(
    present.commit(request("refs/heads/main", OID, null)),
    AuthorizationError,
  );

  const { repo: absentRepo, calls } = fakeRepo(snapshot({}));
  const absent = createAcceptedStateRepository(absentRepo, {
    lookupState: async () => state({}),
  });
  await absent.commit(request("refs/heads/main", null, null));
  assert.equal(calls.length, 1);
});

test("known PR tips must match, while unknown PRs are opt-in and false authority denies", async () => {
  const pr = `refs/nostr/${EVENT}`;
  const { repo, calls } = fakeRepo(snapshot({}));
  const known = createAcceptedStateRepository(repo, {
    lookupState: async () => state({}),
    lookupPrTip: async () => OID,
  });
  await known.commit(request(pr, null, OID));
  assert.equal(calls.length, 1);
  await assert.rejects(
    known.commit(request(pr, OID, OID2)),
    AuthorizationError,
  );

  const { repo: unknownRepo } = fakeRepo(snapshot({}));
  const unknown = createAcceptedStateRepository(unknownRepo, {
    lookupState: async () => state({}),
    lookupPrTip: async () => null,
  });
  await assert.rejects(
    unknown.commit(request(pr, null, OID)),
    AuthorizationError,
  );
  const optedIn = createAcceptedStateRepository(unknownRepo, {
    lookupState: async () => state({}),
    lookupPrTip: async () => null,
    allowUnknownPrRefs: true,
  });
  await optedIn.commit(request(pr, null, OID));

  const falseKnown = createAcceptedStateRepository(unknownRepo, {
    lookupState: async () => state({}),
    lookupPrTip: async () => false,
    allowUnknownPrRefs: true,
  });
  await assert.rejects(
    falseKnown.commit(request(pr, null, OID)),
    AuthorizationError,
  );
});

test("invalid namespaces are rejected before delegation", async () => {
  const { repo, calls } = fakeRepo(snapshot({}));
  const wrapped = createAcceptedStateRepository(repo, {
    lookupState: async () => state({}),
  });
  await assert.rejects(
    wrapped.commit(request("refs/nostr/not-an-event", null, OID)),
    (error) =>
      error instanceof IntegrityError || error instanceof AuthorizationError,
  );
  assert.equal(calls.length, 0);
});

test("captures request data before an asynchronous authority lookup", async () => {
  const { repo, calls } = fakeRepo(snapshot({}));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const wrapped = createAcceptedStateRepository(repo, {
    lookupState: async () => {
      await waiting;
      return state({ "refs/heads/main": OID });
    },
  });
  const original = request("refs/heads/main", OID, OID);
  const pending = wrapped.commit(original);
  original.updates[0]!.new = OID2;
  release();
  await pending;
  assert.equal(calls[0]!.updates[0]!.new, OID);
});

test("serialize fences authority lookup and repository commit together", async () => {
  const { repo } = fakeRepo(snapshot({ "refs/heads/main": OID }));
  const order: string[] = [];
  const wrapped = createAcceptedStateRepository(repo, {
    lookupState: async () => {
      order.push("lookup");
      return state({ "refs/heads/main": OID });
    },
    serialize: async (operation) => {
      order.push("enter");
      const result = await operation();
      order.push("exit");
      return result;
    },
  });
  await wrapped.commit(request("refs/heads/main", OID, OID));
  assert.deepEqual(order, ["enter", "lookup", "exit"]);
});

test("HEAD comes only from accepted authority, never a branch heuristic", async () => {
  const { repo } = fakeRepo(
    snapshot({ "refs/heads/main": OID, "refs/heads/release": OID2 }),
  );
  const selected = createAcceptedStateRepository(repo, {
    lookupState: async () =>
      state(
        { "refs/heads/main": OID, "refs/heads/release": OID2 },
        "refs/heads/release",
      ),
  });
  assert.equal((await selected.load()).headRef, "refs/heads/release");

  const noHead = createAcceptedStateRepository(repo, {
    lookupState: async () => state({ "refs/heads/main": OID }, null),
  });
  assert.equal((await noHead.load()).headRef, null);
});

test("HEAD retains its signed branch while pending or unborn", async () => {
  const staleRepo = fakeRepo(snapshot({ "refs/heads/main": OID2 }));
  const stale = createAcceptedStateRepository(staleRepo.repo, {
    lookupState: async () =>
      state({ "refs/heads/main": OID }, "refs/heads/main"),
  });
  assert.equal((await stale.load()).headRef, "refs/heads/main");

  const missingRepo = fakeRepo(snapshot({}));
  const missing = createAcceptedStateRepository(missingRepo.repo, {
    lookupState: async () => state({}, "refs/heads/main"),
  });
  assert.equal((await missing.load()).headRef, "refs/heads/main");
});
