/// <reference path="../worker-configuration.d.ts" />
import { createGitHandler } from "./http.js";
import { NativeGitEngine } from "./git/engine.js";
import { R2ObjectStore } from "./r2-store.js";
import { WalRepository } from "./wal.js";
import {
  repositoryAddress,
  repositoryPath,
  repositoryStoragePrefix,
} from "./grasp/address.ts";
import {
  repositoryPage,
  serviceInformation,
  wantsServiceInformation,
  withGraspCors,
} from "./grasp/discovery.ts";

/** Single-repository example. Authentication is not GRASP authorization. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS")
      return withGraspCors(new Response(null, { status: 204 }));
    if (url.pathname === "/healthz") {
      return withGraspCors(
        new Response("ok\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }
    let path = "/repo.git";
    let storagePrefix = "repos/default/";
    try {
      if (env.REPOSITORY_NPUB) {
        const address = repositoryAddress(
          env.REPOSITORY_NPUB,
          env.REPOSITORY_IDENTIFIER,
        );
        path = repositoryPath(address);
        storagePrefix = await repositoryStoragePrefix(address);
      }
    } catch {
      return withGraspCors(
        new Response("Invalid repository configuration\n", { status: 503 }),
      );
    }
    if (url.pathname === "/" && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
        return withGraspCors(
          new Response("Nostr relay is not implemented\n", { status: 426 }),
        );
      if (wantsServiceInformation(request))
        return withGraspCors(
          new Response(JSON.stringify(serviceInformation(path)), {
            headers: {
              "content-type": "application/nostr+json",
              "cache-control": "no-store",
              vary: "Accept",
            },
          }),
        );
      return withGraspCors(repositoryPage(path));
    }
    if (url.pathname === path && request.method === "GET")
      return withGraspCors(repositoryPage(path));
    const store = new R2ObjectStore(env.WAL);
    const repository = new WalRepository(store, new NativeGitEngine(), {
      prefix: storagePrefix,
    });
    try {
      return withGraspCors(
        await createGitHandler(repository, {
          prefix: path,
          ...(env.HEAD_REF ? { headRef: env.HEAD_REF } : {}),
          authorizePush: (pushRequest) =>
            authorizePush(pushRequest, env.PUSH_TOKEN),
        })(request),
      );
    } catch {
      return withGraspCors(
        new Response("Repository unavailable\n", { status: 503 }),
      );
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Use WebCrypto verification rather than a JavaScript secret comparison.
 * Missing configuration is intentionally deny-by-default.
 */
async function authorizePush(
  request: Request,
  configured: string | undefined,
): Promise<boolean> {
  if (!configured) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  if (presented.length === 0 || presented.length > 4096) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configured),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(configured)),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(presented),
  );
}

export { authorizePush };
