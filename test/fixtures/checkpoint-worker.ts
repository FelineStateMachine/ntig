import { NativeGitEngine } from "../../src/git/engine.ts";
import { R2ObjectStore } from "../../src/r2-store.ts";
import { WalRepository } from "../../src/wal.ts";
import { createGitHandler } from "../../src/http.ts";
import type { ObjectStore } from "../../src/contracts.ts";
import { R2InventoryListing } from "../../src/r2-inventory.ts";

/** Test-only workerd harness; intentionally not imported by the production Worker. */
function repository(env: { WAL: R2Bucket }) {
  let gets = 0;
  let puts = 0;
  const inner = new R2ObjectStore(env.WAL, { prefix: "checkpoint-test" });
  const store: ObjectStore = {
    get: async (key) => {
      gets++;
      return inner.get(key);
    },
    put: (key, bytes, expected) => {
      puts++;
      return inner.put(key, bytes, expected);
    },
  };
  return {
    repo: new WalRepository(store, new NativeGitEngine(), {
      prefix: "repos/test/",
    }),
    getCount: () => gets,
    putCount: () => puts,
  };
}
export default {
  async fetch(request: Request, env: { WAL: R2Bucket }): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/repo.git")) {
      const { repo, getCount } = repository(env);
      const handlerOptions = {
        prefix: "/repo.git",
        authorizePush: () => true,
      };
      // Every request gets one short-lived session. Sessions forward writes,
      // invalidate cached objects around them, and close even on exceptions.
      const response = await repo.withReadSession((session) =>
        createGitHandler(session, handlerOptions)(request),
      );
      const headers = new Headers(response.headers);
      headers.set("x-test-object-gets", String(getCount()));
      return new Response(response.body, { status: response.status, headers });
    }
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    const body = (await request.json()) as {
      op?: string;
      id?: string;
      name?: string;
      old?: string | null;
      new?: string | null;
      pack?: string;
    };
    const { repo, getCount, putCount } = repository(env);
    if (body.op === "commit") {
      const pack = body.pack
        ? Uint8Array.from(atob(body.pack), (c) => c.charCodeAt(0))
        : undefined;
      const receipt = await repo.commit({
        id: body.id ?? "test",
        updates: [
          {
            name: body.name ?? "refs/heads/test",
            old: body.old ?? null,
            new: body.new ?? null,
          },
        ],
        ...(pack ? { pack } : {}),
      });
      return Response.json(receipt);
    }
    if (body.op === "checkpoint") return Response.json(await repo.checkpoint());
    if (body.op === "inventory") {
      const report = await repo.inventory(
        new R2InventoryListing(env.WAL, {
          prefix: "checkpoint-test",
          pageSize: 64,
        }),
      );
      return Response.json({
        ...report,
        testGets: getCount(),
        testPuts: putCount(),
      });
    }
    if (body.op === "load") {
      const snapshot = await repo.load();
      return Response.json({
        sequence: snapshot.sequence,
        checkpoint: Boolean(snapshot.checkpoint),
        records: snapshot.records.length,
        refs: snapshot.refs,
      });
    }
    return new Response("unknown operation", { status: 400 });
  },
};
