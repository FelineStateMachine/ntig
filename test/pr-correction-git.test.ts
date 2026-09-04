import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
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
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      try {
        const url = `http://127.0.0.1${request.url ?? "/"}`;
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
        const result = await handler(
          new Request(url, {
            method: request.method ?? "GET",
            headers: request.headers as HeadersInit,
            ...(body === undefined ? {} : { body, duplex: "half" as const }),
          }),
        );
        response.statusCode = result.status;
        result.headers.forEach((value, key) => response.setHeader(key, value));
        // Test fixture contains only two empty commits and their tree.
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    },
  );
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
  const submittedOlds: string[] = [];
  const { server, url } = await serve(async (request) => {
    if (request.url.endsWith("/git-receive-pack")) {
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      submittedOlds.push(new TextDecoder().decode(bytes.subarray(4, 44)));
    }
    return handler(request);
  });
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
    assert.deepEqual(submittedOlds, ["0".repeat(40), "0".repeat(40)]);
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

test("pending accepted HEAD keeps the materialized ordinary branch cloneable", async () => {
  const root = await mkdtemp(`${tmpdir()}/nostrwal-pending-head-`);
  const source = `${root}/source`;
  const clone = `${root}/clone`;
  await command(root, ["init", source]);
  await command(source, ["config", "user.name", "Test"]);
  await command(source, ["config", "user.email", "test@example.com"]);
  await command(source, ["checkout", "-b", "main"]);
  await writeFile(`${source}/tracked.txt`, "materialized\n");
  await command(source, ["add", "tracked.txt"]);
  await command(source, ["commit", "-m", "materialized"]);
  const oldTip = await command(source, ["rev-parse", "HEAD"]);
  await command(source, ["commit", "--allow-empty", "-m", "pending"]);
  const pendingTip = await command(source, ["rev-parse", "HEAD"]);

  const branch = "refs/heads/main";
  let state: AcceptedState = {
    eventId,
    refs: { [branch]: oldTip },
    head: branch,
  };
  const wal = new WalRepository(new MemoryStore(), new NativeGitEngine());
  const repository = createAcceptedStateRepository(wal, {
    lookupState: async () => state,
  });
  const handler = createGitHandler(repository, { authorizePush: () => true });
  const { server, url } = await serve(handler);
  try {
    // Materialize the currently accepted branch before advertising a pending
    // state that names the not-yet-uploaded future commit.
    await command(source, [
      "push",
      "--no-progress",
      url,
      `${oldTip}:${branch}`,
    ]);
    state = { eventId, refs: { [branch]: pendingTip }, head: branch };

    // HEAD remains the authority-selected branch, while its old materialized
    // tip is still advertised until the pending Git data arrives.
    await command(root, ["clone", url, clone]);
    assert.equal(await command(clone, ["rev-parse", "HEAD"]), oldTip);
    assert.equal(await command(clone, ["symbolic-ref", "HEAD"]), branch);
    assert.equal(
      await readFile(`${clone}/tracked.txt`, "utf8"),
      "materialized\n",
    );
    assert.equal(
      await command(clone, ["show", "HEAD:tracked.txt"]),
      "materialized",
    );

    // Fetch the future commit locally, then publish it with the ordinary CAS
    // old value. The accepted state now matches the new commit exactly.
    // Import the pending object out-of-band so the subsequent Smart HTTP push
    // can send it without requiring the server to advertise an unreachable tip.
    await command(clone, ["fetch", source, pendingTip]);
    await command(clone, ["reset", "--hard", pendingTip]);
    await command(clone, [
      "push",
      "--force",
      "--no-progress",
      url,
      `HEAD:${branch}`,
    ]);
    assert.equal((await repository.load()).refs[branch], pendingTip);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
