import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationError,
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

test("pending state preserves old ref CAS and HEAD activates only at accepted target", async () => {
  const { repo, first, second, setState } = await fixture();
  setState({ eventId, refs: { [branch]: second }, head: branch });
  const pending = await repo.load();
  assert.equal(pending.refs[branch], first);
  assert.equal(pending.headRef, null);
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
