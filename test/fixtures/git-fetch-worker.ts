import {
  fetchGitPack,
  createGitHandler,
  createPrRepository,
  MemoryStore,
  R2ObjectStore,
  NativeGitEngine,
  WalRepository,
  classifyError,
  type GitFetchMeterEvent,
} from "../../src/index.ts";

/** Test-only workerd/R2 harness. The remote handler has no storage authority. */
export default {
  async fetch(request: Request, env: { WAL: R2Bucket }): Promise<Response> {
    const engine = new NativeGitEngine();
    const target = new WalRepository(new R2ObjectStore(env.WAL), engine);
    const tip = request.headers.get("x-test-tip")!;
    const eventId = "a".repeat(64);
    const pr = `refs/nostr/${eventId}`;
    const authorized = createPrRepository(target, {
      lookupTip: async () => tip,
    });
    if (request.method === "GET")
      return Response.json(await authorized.loadRefs!());
    const remote = new WalRepository(new MemoryStore(), engine);
    await remote.commit({
      id: "source",
      updates: [{ name: "refs/tags/data", old: null, new: tip }],
      pack: new Uint8Array(await request.arrayBuffer()),
    });
    let meter: Readonly<GitFetchMeterEvent> | undefined;
    try {
      const result = await fetchGitPack("https://source.example/repo.git", {
        wants: [tip],
        fetch: createGitHandler(remote),
        observe: (event) => {
          meter = event;
        },
      });
      const receipt = await authorized.commit({
        id: "accepted-pr",
        updates: [{ name: pr, old: null, new: tip }],
        pack: result.pack,
      });
      return Response.json({
        receipt,
        refs: (await authorized.loadRefs!()).refs,
        meter,
      });
    } catch (error) {
      return Response.json(
        {
          ...classifyError(error),
          detail: String(error),
          stack: error instanceof Error ? error.stack : "",
        },
        { status: 500 },
      );
    }
  },
};
