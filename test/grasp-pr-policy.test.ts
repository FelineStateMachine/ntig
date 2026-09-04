import assert from "node:assert/strict";
import test from "node:test";
import { IntegrityError } from "../src/contracts.ts";
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
    lookupTip: async (eventId) => (eventId === id ? oid("b") : null),
  });
  await assert.rejects(
    wrapped.commit({
      id: "mismatch",
      updates: [{ name: `refs/nostr/${id}`, old: null, new: oid("a") }],
    }),
    IntegrityError,
  );
  assert.equal(writes.length, 0);
  const unknown = event("c");
  await wrapped.commit({
    id: "unknown",
    updates: [{ name: `refs/nostr/${unknown}`, old: null, new: oid("a") }],
  });
  assert.equal(writes.length, 1);
});

test("deletion is allowed without tip lookup and receipts/errors pass through", async () => {
  const { repo, writes } = fake();
  let lookedUp = false;
  const wrapped = createPrRepository(repo, {
    lookupTip: async () => {
      lookedUp = true;
      return oid("a");
    },
  });
  const id = event("a");
  const receipt = await wrapped.commit({
    id: "delete",
    updates: [{ name: `refs/nostr/${id}`, old: oid("a"), new: null }],
  });
  assert.deepEqual(receipt, { id: "delete", sequence: 1, replayed: false });
  assert.equal(lookedUp, false);
  assert.equal(writes.length, 1);
  const delegated = new Error("delegate");
  const failing = createPrRepository({
    ...repo,
    commit: async () => {
      throw delegated;
    },
  });
  await assert.rejects(
    failing.commit({
      id: "x",
      updates: [{ name: `refs/nostr/${id}`, old: null, new: null }],
    }),
    delegated,
  );
});
