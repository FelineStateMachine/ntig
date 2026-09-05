import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, IntegrityError } from "../src/contracts.ts";
import type { CommitRequest } from "../src/contracts.ts";
import { createPrRepository, isPrRef } from "../src/grasp/pr-policy.ts";

const oid = (value: string) => value.repeat(40).slice(0, 40);
const event = (value: string) => value.repeat(64).slice(0, 64);
const snapshot = {
  sequence: 0,
  tip: null,
  version: null,
  refs: {},
  records: [],
  packs: [],
};

function fake() {
  const writes: CommitRequest[] = [];
  const repo = {
    async load() {
      return snapshot;
    },
    async commit(request: CommitRequest) {
      writes.push(request);
      return { id: request.id, sequence: 1, replayed: false };
    },
  };
  return { repo, writes };
}

test("recognizes only lower-case PR refs", () => {
  assert.equal(isPrRef(`refs/nostr/${event("a")}`), true);
  assert.equal(isPrRef(`refs/nostr/${event("A")}`), false);
  assert.equal(isPrRef("refs/heads/main"), false);
});

test("caller mutations during async lookup cannot escape PR-only authorization", async () => {
  const { repo, writes } = fake();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = createPrRepository(repo, {
    allowUnknownPrRefs: true,
    lookupTip: async () => {
      await gate;
      return null;
    },
  });
  const name = `refs/nostr/${event("a")}`;
  const request = {
    id: "copied",
    updates: [{ name, old: null, new: oid("b") }],
    pack: new Uint8Array(32).fill(1),
  };
  const pending = wrapped.commit(request);
  request.updates[0]!.name = "refs/heads/main";
  request.pack.fill(9);
  release();
  await pending;
  assert.equal(writes[0]!.updates[0]!.name, name);
  assert.equal(writes[0]!.pack![0], 1);
});

test("rejects malformed and mixed transactions before any write", async () => {
  const { repo, writes } = fake();
  const wrapped = createPrRepository(repo);
  for (const name of [
    "refs/nostr/ABC",
    `refs/nostr/${event("a").toUpperCase()}`,
    `refs/nostr/${event("a")}/extra`,
    "refs/heads/main",
  ]) {
    await assert.rejects(
      wrapped.commit({
        id: `bad-${writes.length}`,
        updates: [{ name, old: null, new: oid("a") }],
      }),
      IntegrityError,
    );
    assert.equal(writes.length, 0);
  }
  await assert.rejects(
    wrapped.commit({
      id: "mixed",
      updates: [
        { name: `refs/nostr/${event("a")}`, old: null, new: oid("a") },
        { name: "refs/heads/main", old: null, new: oid("b") },
      ],
    }),
    IntegrityError,
  );
  assert.equal(writes.length, 0);
});

test("known event tip must match, while an unknown event permits bounded push", async () => {
  const { repo, writes } = fake();
  const id = event("a");
  const wrapped = createPrRepository(repo, {
    allowUnknownPrRefs: true,
    lookupTip: async (eventId) => (eventId === id ? oid("b") : null),
  });
  await assert.rejects(
    wrapped.commit({
      id: "mismatch",
      updates: [{ name: `refs/nostr/${id}`, old: null, new: oid("a") }],
    }),
    AuthorizationError,
  );
  assert.equal(writes.length, 0);
  const unknown = event("c");
  await wrapped.commit({
    id: "unknown",
    updates: [{ name: `refs/nostr/${unknown}`, old: null, new: oid("a") }],
  });
  assert.equal(writes.length, 1);
});

test("public deletion is denied even when the event is accepted", async () => {
  const { repo, writes } = fake();
  const wrapped = createPrRepository(repo, { lookupTip: async () => oid("a") });
  await assert.rejects(
    wrapped.commit({
      id: "delete",
      updates: [{ name: `refs/nostr/${event("a")}`, old: oid("a"), new: null }],
    }),
    AuthorizationError,
  );
  assert.equal(writes.length, 0);
});

test("unknown uploads require opt-in, while false authority always denies", async () => {
  const { repo, writes } = fake();
  const request = {
    id: "unknown",
    updates: [{ name: `refs/nostr/${event("a")}`, old: null, new: oid("a") }],
  };
  await assert.rejects(
    createPrRepository(repo).commit(request),
    AuthorizationError,
  );
  await assert.rejects(
    createPrRepository(repo, {
      allowUnknownPrRefs: true,
      lookupTip: async () => false,
    }).commit(request),
    AuthorizationError,
  );
  assert.equal(writes.length, 0);
});

test("metadata reads hide ordinary, expired and mismatched refs without reading packs", async () => {
  let loads = 0;
  let fenced = false;
  const { repo } = fake();
  const wrapped = createPrRepository(
    {
      ...repo,
      load: async () => {
        loads++;
        return snapshot;
      },
      loadRefs: async () => {
        assert.equal(fenced, true);
        return {
          ...snapshot,
          refs: {
            "refs/heads/main": oid("a"),
            [`refs/nostr/${event("a")}`]: oid("a"),
            [`refs/nostr/${event("b")}`]: oid("b"),
            [`refs/nostr/${event("c")}`]: oid("c"),
            [`refs/nostr/${event("d")}`]: oid("d"),
          },
        };
      },
    },
    {
      allowUnknownPrRefs: true,
      lookupTip: async (id) => {
        assert.equal(fenced, true);
        return id === event("a")
          ? oid("a")
          : id === event("b")
            ? false
            : id === event("c")
              ? oid("b")
              : null;
      },
      serialize: async (operation) => {
        fenced = true;
        try {
          return await operation();
        } finally {
          fenced = false;
        }
      },
    },
  );
  const view = await wrapped.loadRefs!();
  assert.deepEqual(
    { ...view.refs },
    {
      [`refs/nostr/${event("a")}`]: oid("a"),
      [`refs/nostr/${event("d")}`]: oid("d"),
    },
  );
  assert.equal(view.headRef, null);
  assert.equal(loads, 0);
  assert.equal(fenced, false);
});
