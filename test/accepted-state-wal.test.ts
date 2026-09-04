import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationError,
  ConflictError,
  MemoryStore,
  NativeGitEngine,
  WalRepository,
  createAcceptedStateRepository,
  createGitHandler,
  encodePack,
  decodePack,
  type AcceptedState,
} from "../src/index.ts";

const enc = new TextEncoder();
const eventId = "a".repeat(64);
const branch = "refs/heads/main";

async function fixture() {
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const pack = await encodePack([
    { type: "tree", data: new Uint8Array() },
    {
      type: "commit",
      data: enc.encode(
        `tree ${emptyTree}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\none\n`,
      ),
    },
    {
      type: "commit",
      data: enc.encode(
        `tree ${emptyTree}\nauthor A <a@b> 2 +0000\ncommitter A <a@b> 2 +0000\n\ntwo\n`,
      ),
    },
  ]);
  const commits = (await decodePack(pack)).filter((o) => o.type === "commit");
  const first = commits[0]!.oid,
    second = commits[1]!.oid;
  const wal = new WalRepository(new MemoryStore(), new NativeGitEngine());
  let state: AcceptedState = {
    eventId,
    refs: { [branch]: first },
    head: branch,
  };
  const repo = createAcceptedStateRepository(wal, {
    lookupState: async () => state,
  });
  await repo.commit({
    id: "initial",
    pack,
    updates: [{ name: branch, old: null, new: first }],
  });
  return {
    wal,
    repo,
    first,
    second,
    setState: (value: AcceptedState) => {
      state = value;
    },
  };
}

test("pending state preserves materialized ref and signed HEAD until target arrives", async () => {
  const { repo, first, second, setState } = await fixture();
  setState({ eventId, refs: { [branch]: second }, head: branch });
  const pending = await repo.load();
  assert.equal(pending.refs[branch], first);
  assert.equal(pending.headRef, branch);
  await repo.commit({
    id: "update",
    updates: [{ name: branch, old: first, new: second }],
  });
  assert.equal((await repo.load()).headRef, branch);
  assert.equal((await repo.load()).refs[branch], second);
});

test("a mixed rejected transaction performs no WAL publication", async () => {
  const { repo, wal, first, second, setState } = await fixture();
  setState({ eventId, refs: { [branch]: second }, head: branch });
  await assert.rejects(
    repo.commit({
      id: "mixed",
      updates: [
        { name: branch, old: first, new: second },
        { name: "refs/heads/unauthorized", old: null, new: second },
      ],
    }),
    AuthorizationError,
  );
  assert.equal((await wal.load()).sequence, 1);
  assert.equal((await wal.load()).refs[branch], first);
});

test("PR deletion from public transport is not expiry-cleanup authority", async () => {
  const { wal, first } = await fixture();
  const name = `refs/nostr/${eventId}`;
  const repo = createAcceptedStateRepository(wal, {
    lookupState: async () => null,
    lookupPrTip: async () => first,
  });
  await repo.commit({ id: "pr", updates: [{ name, old: null, new: first }] });
  await assert.rejects(
    repo.commit({ id: "erase", updates: [{ name, old: first, new: null }] }),
    AuthorizationError,
  );
  assert.equal((await wal.load()).refs[name], first);
});

test("response budget is checked before a successful push can become committed", async () => {
  const { repo, wal, first } = await fixture();
  const command = `${first} ${first} ${branch}\0report-status\n`;
  const body =
    (enc.encode(command).length + 4).toString(16).padStart(4, "0") +
    command +
    "0000";
  const handler = createGitHandler(repo, {
    authorizePush: () => true,
    maxResponseBytes: 1,
  });
  const response = await handler(
    new Request("https://x/repo.git/git-receive-pack", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-git-receive-pack-request" },
    }),
  );
  assert.equal(response.status, 413);
  assert.equal((await wal.load()).sequence, 1);
});

test("known-correct PR repairs a hidden tip and its physical receipt survives retries", async () => {
  const { wal, first, second } = await fixture();
  const name = `refs/nostr/${eventId}`;
  let tip: string | null = null;
  const repo = createAcceptedStateRepository(wal, {
    lookupState: async () => null,
    lookupPrTip: async () => tip,
    allowUnknownPrRefs: true,
  });
  await repo.commit({
    id: "unknown",
    updates: [{ name, old: null, new: first }],
  });
  tip = second;
  assert.equal((await repo.load()).refs[name], undefined);
  const correction = {
    id: "correct",
    updates: [{ name, old: null, new: second }],
  };
  const receipt = await repo.commit(correction);
  assert.equal(
    correction.updates[0]!.old,
    null,
    "caller request stays unchanged",
  );
  assert.equal((await repo.load()).refs[name], second);
  const physical = await wal.load();
  assert.equal(physical.records.at(-1)!.updates[0]!.old, first);
  await wal.commit({
    id: "later",
    updates: [{ name: branch, old: first, new: second }],
  });
  assert.deepEqual(await repo.commit(correction), {
    ...receipt,
    replayed: true,
  });
  await assert.rejects(
    repo.commit({ ...correction, pack: new Uint8Array(32) }),
    ConflictError,
  );
});

test("a corrected push with a lost acknowledgement replays without another commit", async () => {
  const { wal, first, second } = await fixture();
  const name = `refs/nostr/${eventId}`;
  await wal.commit({
    id: "unknown",
    updates: [{ name, old: null, new: first }],
  });
  let loseAck = true;
  const repo = createAcceptedStateRepository(
    {
      load: () => wal.load(),
      commit: async (request) => {
        const result = await wal.commit(request);
        if (loseAck) {
          loseAck = false;
          throw new Error("lost acknowledgement");
        }
        return result;
      },
    },
    { lookupState: async () => null, lookupPrTip: async () => second },
  );
  const request = {
    id: "correct",
    updates: [{ name, old: null, new: second }],
  };
  await assert.rejects(repo.commit(request), /lost acknowledgement/);
  assert.equal((await repo.commit(request)).replayed, true);
  assert.equal((await wal.load()).sequence, 3);
});

test("checkpointed hidden-PR correction retries use retained indexed records", async () => {
  const { wal, first, second } = await fixture();
  const name = `refs/nostr/${eventId}`;
  await wal.commit({
    id: "unknown-before-checkpoint",
    updates: [{ name, old: null, new: first }],
  });
  const repo = createAcceptedStateRepository(wal, {
    lookupState: async () => null,
    lookupPrTip: async () => second,
  });
  const correction = {
    id: "indexed-correction",
    updates: [{ name, old: null, new: second }],
  };
  const receipt = await repo.commit(correction);
  await wal.checkpoint();
  await wal.commit({
    id: "later-checkpointed",
    updates: [{ name: branch, old: first, new: second }],
  });
  assert.equal(
    (await wal.load()).records.some((r) => r.id === correction.id),
    false,
  );
  assert.deepEqual(await repo.commit(correction), {
    ...receipt,
    replayed: true,
  });
  await assert.rejects(
    repo.commit({ ...correction, pack: new Uint8Array(32) }),
    ConflictError,
  );
  assert.equal((await wal.load()).sequence, 4);
});

test("PR repair does not relax visible, unknown, or explicit stale old-OID checks", async () => {
  const { wal, first, second } = await fixture();
  const name = `refs/nostr/${eventId}`;
  await wal.commit({
    id: "unknown",
    updates: [{ name, old: null, new: first }],
  });
  let tip: string | null = first;
  const repo = createAcceptedStateRepository(wal, {
    lookupState: async () => null,
    lookupPrTip: async () => tip,
    allowUnknownPrRefs: true,
  });
  await assert.rejects(
    repo.commit({ id: "visible", updates: [{ name, old: null, new: first }] }),
    ConflictError,
  );
  tip = null;
  await assert.rejects(
    repo.commit({
      id: "unknown-collision",
      updates: [{ name, old: null, new: second }],
    }),
    ConflictError,
  );
  tip = second;
  await assert.rejects(
    repo.commit({ id: "stale", updates: [{ name, old: second, new: second }] }),
    ConflictError,
  );
  assert.equal((await wal.load()).sequence, 2);
});

test("physical changes between repair lookup and publication still lose old-ref CAS", async () => {
  const { wal, first, second } = await fixture();
  const name = `refs/nostr/${eventId}`;
  await wal.commit({
    id: "unknown",
    updates: [{ name, old: null, new: first }],
  });
  const repo = createAcceptedStateRepository(
    {
      load: () => wal.load(),
      commit: async (request) => {
        // Simulates a caller bypassing the required shared fence.
        await wal.commit({
          id: "race",
          updates: [{ name, old: first, new: null }],
        });
        return wal.commit(request);
      },
    },
    { lookupState: async () => null, lookupPrTip: async () => second },
  );
  await assert.rejects(
    repo.commit({ id: "correct", updates: [{ name, old: null, new: second }] }),
    ConflictError,
  );
  assert.equal((await wal.load()).refs[name], undefined);
  assert.equal((await wal.load()).sequence, 3);
});
