import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError, MemoryStore } from "../src/index.js";
import {
  MeteredObjectStore,
  type ObjectStoreMeterEvent,
} from "../src/metering.js";

test("reports hit/miss and separates attempted and successful puts", async () => {
  const events: ObjectStoreMeterEvent[] = [];
  const store = new MeteredObjectStore(new MemoryStore(), (event) => {
    events.push({ ...event });
  });

  assert.equal(await store.get("repo/root.json"), null);
  assert.equal(
    await store.put("repo/pack", new Uint8Array([1, 2]), null),
    true,
  );
  const item = await store.get("repo/pack");
  assert.deepEqual(item?.bytes, new Uint8Array([1, 2]));
  assert.equal(await store.put("repo/pack", new Uint8Array([3]), null), false);

  assert.deepEqual(
    events.map(
      ({
        operation,
        outcome,
        attemptedPutBytes,
        successfulPutBytes,
        bytesRead,
        conditional,
      }) => ({
        operation,
        outcome,
        attemptedPutBytes,
        successfulPutBytes,
        bytesRead,
        conditional,
      }),
    ),
    [
      {
        operation: "get",
        outcome: "miss",
        attemptedPutBytes: 0,
        successfulPutBytes: 0,
        bytesRead: 0,
        conditional: "none",
      },
      {
        operation: "put",
        outcome: "committed",
        attemptedPutBytes: 2,
        successfulPutBytes: 2,
        bytesRead: 0,
        conditional: "create",
      },
      {
        operation: "get",
        outcome: "hit",
        attemptedPutBytes: 0,
        successfulPutBytes: 0,
        bytesRead: 2,
        conditional: "none",
      },
      {
        operation: "put",
        outcome: "condition-failed",
        attemptedPutBytes: 1,
        successfulPutBytes: 0,
        bytesRead: 0,
        conditional: "create",
      },
    ],
  );
  assert.equal("key" in events[0]!, false);
});

test("redacts failures and preserves the original storage error", async () => {
  const error = new ConflictError("secret provider detail");
  const events: ObjectStoreMeterEvent[] = [];
  const store = new MeteredObjectStore(
    {
      async get() {
        throw error;
      },
      async put() {
        throw error;
      },
    },
    async (event) => {
      events.push({ ...event });
      throw new Error("observer failure");
    },
  );
  await assert.rejects(store.get("private/repo"), (actual) => actual === error);
  await assert.rejects(
    store.put("private/repo", new Uint8Array(4), "v1"),
    (actual) => actual === error,
  );
  assert.deepEqual(
    events.map((event) => ({ outcome: event.outcome, error: event.error })),
    [
      { outcome: "error", error: "conflict" },
      { outcome: "error", error: "conflict" },
    ],
  );
  assert.equal(
    JSON.stringify(events).includes("secret provider detail"),
    false,
  );
});
