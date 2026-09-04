import { NativeGitEngine } from "../../src/git/engine.ts";
import { R2ObjectStore } from "../../src/r2-store.ts";
import { WalRepository } from "../../src/wal.ts";
import { createGitHandler } from "../../src/http.ts";

/** Test-only workerd harness; intentionally not imported by the production Worker. */
function repository(env: { WAL: R2Bucket }) {
  return new WalRepository(
    new R2ObjectStore(env.WAL, { prefix: "checkpoint-test" }),
    new NativeGitEngine(),
    { prefix: "repos/test/" },
  );
}
export default {
  async fetch(request: Request, env: { WAL: R2Bucket }): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/repo.git")) {
      return createGitHandler(repository(env), {
        prefix: "/repo.git",
        authorizePush: () => true,
      })(request);
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
    const repo = repository(env);
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
