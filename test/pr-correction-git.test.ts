import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  createAcceptedStateRepository,
  createGitHandler,
  MemoryStore,
  NativeGitEngine,
  WalRepository,
  type AcceptedState,
} from "../src/index.ts";

const eventId = "a".repeat(64);
const prRef = `refs/nostr/${eventId}`;

function command(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} (${code}): ${stderr}`));
    });
  });
}

async function serve(handler: (request: Request) => Promise<Response>) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = `http://127.0.0.1${request.url ?? "/"}`;
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Readable.toWeb(request) as ReadableStream<Uint8Array>;
      const result = await handler(new Request(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
        ...(body === undefined ? {} : { body, duplex: "half" as const }),
      }));
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      if (result.body) Readable.fromWeb(result.body as never).pipe(response);
      else response.end();
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/repo.git` };
}

test("stock Git corrects an unknown PR ref after accepted state changes", async () => {
  const root = await mkdtemp(`${tmpdir()}/nostrwal-pr-correction-`);
  const source = `${root}/source`;
  const clone = `${root}/clone`;
  await command(root, ["init", source]);
  await command(source, ["config", "user.name", "Test"]);
  await command(source, ["config", "user.email", "test@example.com"]);
  await command(source, ["checkout", "-b", "main"]);

  await command(source, ["commit", "--allow-empty", "-m", "wrong"]);
  const wrong = await command(source, ["rev-parse", "HEAD"]);
  await command(source, ["commit", "--allow-empty", "-m", "accepted"]);
  const correct = await command(source, ["rev-parse", "HEAD"]);

  let acceptedTip: string | null = null;
  const state: AcceptedState = { eventId, refs: {}, head: null };
  const wal = new WalRepository(new MemoryStore(), new NativeGitEngine());
  const repository = createAcceptedStateRepository(wal, {
    lookupState: async () => state,
    lookupPrTip: async () => acceptedTip,
    allowUnknownPrRefs: true,
  });
  const handler = createGitHandler(repository, { authorizePush: () => true });
  const { server, url } = await serve(handler);
  try {
    // No accepted event exists yet, so GRASP's bounded unknown-event upload is
    // allowed.
    await command(source, ["push", "--no-progress", url, `${wrong}:${prRef}`]);

    // The accepted event now names a different, valid commit. The intermediate
    // ref is hidden, so Git sees it as absent and sends forty zeroes as the old
    // value on this push.
    acceptedTip = correct;
    const hidden = await repository.load();
    assert.equal(hidden.refs[prRef], undefined);
    await command(source, ["push", "--no-progress", url, `HEAD:${prRef}`]);
    const visible = await repository.load();
    assert.equal(visible.refs[prRef], correct);
    assert.notEqual(wrong, correct);

    await command(root, ["clone", "--no-checkout", url, clone]);
    await command(clone, ["fetch", "origin", prRef]);
    await command(clone, ["cat-file", "-e", `${correct}^{commit}`]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
