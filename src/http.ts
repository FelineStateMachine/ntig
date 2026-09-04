import {
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
  classifyError,
} from "./contracts.ts";
import type { GitRepository, RefUpdate, Snapshot } from "./contracts.ts";
import { validateRefName } from "./wal.ts";
import {
  encodePack,
  readObjects,
  objectLinks,
  type GitObject,
} from "./git/index.ts";

export interface GitHttpOptions {
  prefix?: string;
  /** Integration hook for a configured or externally authorized symbolic HEAD. */
  headRef?: string;
  maxBodyBytes?: number;
  maxRefs?: number;
  maxObjects?: number;
  maxGraphEdges?: number;
  maxResponseBytes?: number;
  /** Synchronous best-effort observer, not a quota or billing transaction. */
  observe?: (event: Readonly<GitHttpMeterEvent>) => void;
  /** Cheap authentication runs BEFORE reading a request body. Default: deny. */
  authorizePush?: (request: Request) => boolean | Promise<boolean>;
}
export interface GitHttpMeterEvent {
  requestBytes: number;
  responseBytes: number;
  status: number;
  errorCode?: string;
}
type Repository = GitRepository;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const OID = /^[a-f0-9]{40}$/;
const ZERO = "0".repeat(40);
const RECEIVE_CAPS = ["report-status", "delete-refs", "ofs-delta", "atomic"];
const UPLOAD_CAPS = [
  "side-band-64k",
  "ofs-delta",
  "filter",
  "allow-tip-sha1-in-want",
  "allow-reachable-sha1-in-want",
];

function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
function pkt(payload: string | Uint8Array): Uint8Array {
  const data = typeof payload === "string" ? encoder.encode(payload) : payload;
  if (data.length + 4 > 65_520) throw new LimitError("pkt-line is too long");
  return join([
    encoder.encode((data.length + 4).toString(16).padStart(4, "0")),
    data,
  ]);
}
function flush(): Uint8Array {
  return encoder.encode("0000");
}
function response(
  body: string | Uint8Array | null,
  status = 200,
  type = "text/plain; charset=utf-8",
): Response {
  return new Response(body instanceof Uint8Array ? body.slice().buffer : body, {
    status,
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "Content-Type, Authorization, Git-Protocol, X-Git-Request-Id",
      "access-control-expose-headers": "Content-Type",
      ...(body === null
        ? {}
        : {
            "content-length": String(
              typeof body === "string"
                ? encoder.encode(body).length
                : body.length,
            ),
          }),
    },
  });
}

async function bodyBytes(
  request: Request,
  limit: number,
  observe?: (bytes: number) => void,
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await request.body?.cancel("body limit");
    throw new LimitError("Request body exceeds limit");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      observe?.(chunk.value.length);
      if (size > limit) {
        await reader.cancel("body limit");
        throw new LimitError("Request body exceeds limit");
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return join(parts);
}

class Packets {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  next(): string | null {
    if (this.position + 4 > this.bytes.length)
      throw new IntegrityError("Truncated pkt-line");
    const header = decoder.decode(
      this.bytes.subarray(this.position, this.position + 4),
    );
    if (!/^[a-fA-F0-9]{4}$/.test(header))
      throw new IntegrityError("Invalid pkt-line length");
    const size = Number.parseInt(header, 16);
    this.position += 4;
    if (size === 0) return null;
    if (
      size < 4 ||
      size > 65_520 ||
      this.position + size - 4 > this.bytes.length
    )
      throw new IntegrityError("Invalid pkt-line size");
    const text = decoder.decode(
      this.bytes.subarray(this.position, this.position + size - 4),
    );
    this.position += size - 4;
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  }
}

function checkCapabilities(
  caps: readonly string[],
  allowed: readonly string[],
): void {
  for (const cap of caps)
    if (!allowed.includes(cap) && !/^agent=[\x21-\x7e]+$/.test(cap))
      throw new IntegrityError(`Unsupported capability: ${cap}`);
}

function advertisement(
  service: string,
  snapshot: Snapshot,
  maxRefs: number,
  headRef?: string,
): Uint8Array {
  const entries = Object.entries(snapshot.refs).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length > maxRefs) throw new LimitError("Too many refs");
  for (const [name, oid] of entries) {
    validateRefName(name);
    if (!OID.test(oid) || oid === ZERO)
      throw new IntegrityError("Invalid advertised ref");
  }
  const upload = service === "git-upload-pack";
  const caps = [...(upload ? UPLOAD_CAPS : RECEIVE_CAPS), "agent=nostrwal/0.1"];
  const head =
    snapshot.headRef !== undefined
      ? snapshot.headRef
      : (headRef ??
        (snapshot.refs["refs/heads/main"]
          ? "refs/heads/main"
          : snapshot.refs["refs/heads/master"]
            ? "refs/heads/master"
            : entries.find(([name]) => name.startsWith("refs/heads/"))?.[0]));
  if (head !== null && head !== undefined) {
    validateRefName(head);
    if (!head.startsWith("refs/heads/"))
      throw new IntegrityError("HEAD must name a branch");
  }
  if (upload && head) {
    caps.push(`symref=HEAD:${head}`);
    if (snapshot.refs[head]) entries.unshift(["HEAD", snapshot.refs[head]!]);
  }
  const parts = [pkt(`# service=${service}\n`), flush()];
  if (entries.length === 0)
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps.join(" ")}\n`));
  else
    entries.forEach(([name, oid], index) =>
      parts.push(
        pkt(`${oid} ${name}${index === 0 ? `\0${caps.join(" ")}` : ""}\n`),
      ),
    );
  return join([...parts, flush()]);
}

function receiveCommands(
  bytes: Uint8Array,
  maxRefs: number,
): { updates: RefUpdate[]; caps: string[]; pack: Uint8Array } {
  const packets = new Packets(bytes);
  const updates: RefUpdate[] = [];
  let caps: string[] = [];
  for (;;) {
    const line = packets.next();
    if (line === null) break;
    if (updates.length >= maxRefs)
      throw new LimitError("Too many ref commands");
    const [command, suffix, ...extra] = line.split("\0");
    if (extra.length || (suffix !== undefined && updates.length > 0))
      throw new IntegrityError("Misplaced capabilities");
    if (suffix !== undefined) caps = suffix.split(" ").filter(Boolean);
    const match = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^\r\n\0]+)$/.exec(
      command!,
    );
    if (!match) throw new IntegrityError("Malformed receive command");
    validateRefName(match[3]!);
    updates.push({
      name: match[3]!,
      old: match[1] === ZERO ? null : match[1]!,
      new: match[2] === ZERO ? null : match[2]!,
    });
  }
  if (!updates.length) throw new IntegrityError("Missing receive commands");
  checkCapabilities(caps, RECEIVE_CAPS);
  return { updates, caps, pack: bytes.subarray(packets.position) };
}

function reachable(
  objects: Map<string, GitObject>,
  roots: readonly string[],
  maxObjects: number,
  links: (object: GitObject) => readonly { oid: string }[],
): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    if (seen.size >= maxObjects) throw new LimitError("Object limit exceeded");
    const object = objects.get(oid);
    if (!object) throw new IntegrityError("Missing reachable object");
    seen.add(oid);
    for (const link of links(object))
      if (!seen.has(link.oid)) pending.push(link.oid);
  }
  return seen;
}

async function upload(
  repo: Repository,
  bytes: Uint8Array,
  maxObjects: number,
  maxEdges: number,
): Promise<Uint8Array> {
  const packets = new Packets(bytes);
  const wants: string[] = [];
  let caps: string[] = [];
  let filter: string | undefined;
  for (;;) {
    const line = packets.next();
    if (line === null) break;
    if (line.startsWith("filter ")) {
      if (filter !== undefined || !caps.includes("filter"))
        throw new IntegrityError("Unexpected filter");
      filter = line.slice(7);
      if (filter !== "blob:none" && filter !== "tree:0")
        throw new IntegrityError("Unsupported filter");
      continue;
    }
    const match = /^want ([a-f0-9]{40})(?: (.+))?$/.exec(line);
    if (!match || wants.length >= 1024)
      throw new IntegrityError("Malformed or excessive wants");
    if (match[2]) {
      if (wants.length) throw new IntegrityError("Misplaced want capabilities");
      caps = match[2].split(" ");
    }
    wants.push(match[1]!);
  }
  if (!wants.length) throw new IntegrityError("Missing wants");
  checkCapabilities(caps, UPLOAD_CAPS);
  let done = false;
  let haves = 0;
  while (packets.position < bytes.length) {
    const line = packets.next();
    if (done) throw new IntegrityError("Data after done");
    if (line === null) continue;
    if (line === "done") {
      done = true;
      continue;
    }
    if (!/^have [a-f0-9]{40}$/.test(line) || ++haves > 4096)
      throw new IntegrityError("Unsupported negotiation command");
  }
  const snapshot = await loadRepository(repo);
  const objects = await readObjects(snapshot.packs);
  let edges = 0;
  const cache = new Map<string, ReturnType<typeof objectLinks>>();
  const links = (object: GitObject) => {
    let result = cache.get(object.oid);
    if (result === undefined) {
      result = objectLinks(object, maxEdges - edges);
      edges += result.length;
      if (edges > maxEdges)
        throw new LimitError("Fetch graph edge limit exceeded");
      cache.set(object.oid, result);
    }
    return result;
  };
  const allowed = reachable(
    objects,
    Object.values(snapshot.refs),
    maxObjects,
    links,
  );
  if (wants.some((want) => !allowed.has(want)))
    throw new IntegrityError("Want is not reachable from an advertised ref");
  // We deliberately do not advertise multi_ack/no-done: each negotiation round
  // can safely NAK, and the final pack includes all wanted reachable objects.
  if (!done) return pkt("NAK\n");
  const selected = reachable(objects, wants, maxObjects, links);
  const explicit = new Set(wants);
  const packed = [...selected]
    .map((oid) => objects.get(oid)!)
    .filter(
      (object) =>
        explicit.has(object.oid) ||
        ((filter !== "blob:none" || object.type !== "blob") &&
          (filter !== "tree:0" ||
            object.type === "commit" ||
            object.type === "tag")),
    );
  const pack = await encodePack(packed);
  if (!caps.includes("side-band-64k")) return join([pkt("NAK\n"), pack]);
  const parts = [pkt("NAK\n")];
  for (let position = 0; position < pack.length; position += 65_515) {
    parts.push(
      pkt(join([Uint8Array.of(1), pack.subarray(position, position + 65_515)])),
    );
  }
  return join([...parts, flush()]);
}

async function loadRepository(repo: Repository): Promise<Snapshot> {
  try {
    return await repo.load();
  } catch (cause) {
    if (cause instanceof LimitError) throw cause;
    throw new RepositoryUnavailableError("Cannot read repository", { cause });
  }
}

export function createGitHandler(
  repo: Repository,
  options: GitHttpOptions = {},
): (request: Request) => Promise<Response> {
  const prefix = (options.prefix ?? "/repo.git").replace(/\/$/, "");
  const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024 + 256 * 1024;
  const maxRefs = options.maxRefs ?? 1024;
  const maxObjects = options.maxObjects ?? 4096;
  const maxEdges = options.maxGraphEdges ?? 65_536;
  const maxResponseBytes = options.maxResponseBytes ?? 17 * 1024 * 1024;
  const parsedPrefix = new URL(prefix, "https://nostrwal.invalid");
  if (
    !prefix.startsWith("/") ||
    prefix.startsWith("//") ||
    !prefix.endsWith(".git") ||
    parsedPrefix.origin !== "https://nostrwal.invalid" ||
    parsedPrefix.pathname !== prefix ||
    parsedPrefix.search ||
    parsedPrefix.hash ||
    /%(?![a-fA-F0-9]{2})/.test(prefix)
  )
    throw new Error("Invalid repository route");
  if (options.headRef !== undefined) {
    validateRefName(options.headRef);
    if (!options.headRef.startsWith("refs/heads/"))
      throw new Error("HEAD must name a branch");
  }
  for (const value of [
    maxBody,
    maxRefs,
    maxObjects,
    maxEdges,
    maxResponseBytes,
  ])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid HTTP limit");
  if (maxObjects > 4096 || maxRefs > 1024 || maxEdges > 65_536)
    throw new Error("HTTP limits exceed native Git support");
  return async (request: Request): Promise<Response> => {
    let requestBytes = 0;
    let errorCode: string | undefined;
    const handle = async (): Promise<Response> => {
      const url = new URL(request.url);
      const info = url.pathname === `${prefix}/info/refs`;
      const receive = url.pathname === `${prefix}/git-receive-pack`;
      const fetch = url.pathname === `${prefix}/git-upload-pack`;
      if (!info && !receive && !fetch) return response("Not found\n", 404);
      if (request.method === "OPTIONS") return response(null, 204);
      try {
        if (info && request.method === "GET") {
          const service = url.searchParams.get("service");
          if (service !== "git-receive-pack" && service !== "git-upload-pack")
            return response("Unsupported service\n", 400);
          return response(
            advertisement(
              service,
              await loadRepository(repo),
              maxRefs,
              options.headRef,
            ),
            200,
            `application/x-${service}-advertisement`,
          );
        }
        if (request.method !== "POST" || info)
          return response("Method not allowed\n", 405);
        if (
          receive &&
          (!options.authorizePush || !(await options.authorizePush(request)))
        )
          return response("Push authorization required\n", 403);
        const service = receive ? "git-receive-pack" : "git-upload-pack";
        if (
          request.headers.get("content-type")?.split(";", 1)[0] !==
          `application/x-${service}-request`
        )
          return response("Unsupported media type\n", 415);
        if (request.headers.has("content-encoding"))
          return response("Content encoding is not supported\n", 415);
        const bytes = await bodyBytes(request, maxBody, (size) => {
          requestBytes += size;
        });
        if (fetch)
          return response(
            await upload(repo, bytes, maxObjects, maxEdges),
            200,
            "application/x-git-upload-pack-result",
          );
        const parsed = receiveCommands(bytes, maxRefs);
        const successBytes = parsed.caps.includes("report-status")
          ? pkt("unpack ok\n").length +
            4 +
            parsed.updates.reduce(
              (sum, update) => sum + pkt(`ok ${update.name}\n`).length,
              0,
            )
          : 0;
        if (successBytes > maxResponseBytes)
          throw new LimitError("Push report exceeds response limit");
        let rejection: string | undefined;
        try {
          await repo.commit({
            id: request.headers.get("x-git-request-id") ?? crypto.randomUUID(),
            updates: parsed.updates,
            ...(parsed.pack.length ? { pack: parsed.pack } : {}),
          });
        } catch (error) {
          const classified = classifyError(error);
          errorCode = classified.code;
          rejection = classified.message;
        }
        if (!parsed.caps.includes("report-status"))
          return response(
            rejection ? "Push rejected\n" : null,
            rejection ? 409 : 200,
            "application/x-git-receive-pack-result",
          );
        const safeError = rejection?.replace(/[\r\n\0]/g, " ").slice(0, 512);
        const report = [
          pkt(rejection ? `unpack ${safeError}\n` : "unpack ok\n"),
          ...parsed.updates.map((update) =>
            pkt(
              rejection
                ? `ng ${update.name} ${safeError}\n`
                : `ok ${update.name}\n`,
            ),
          ),
          flush(),
        ];
        return response(
          join(report),
          200,
          "application/x-git-receive-pack-result",
        );
      } catch (error) {
        const classified = classifyError(error);
        errorCode = classified.code;
        return response(`${classified.message}\n`, classified.status);
      }
    };
    let result = await handle();
    let responseBytes = Number(result.headers.get("content-length") ?? 0);
    if (responseBytes > maxResponseBytes) {
      await result.body?.cancel();
      result = response("Response byte limit exceeded\n", 413);
      responseBytes = Number(result.headers.get("content-length"));
      errorCode = "LIMIT_EXCEEDED";
    }
    try {
      const observed = options.observe?.(
        Object.freeze({
          requestBytes,
          responseBytes,
          status: result.status,
          ...(errorCode === undefined ? {} : { errorCode }),
        }),
      );
      void Promise.resolve(observed).catch(() => {});
    } catch {
      /* Advisory only. */
    }
    return result;
  };
}

export const gitHttpInternals = { pkt, flush, bodyBytes };
