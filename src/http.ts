import {
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
  classifyError,
} from "./contracts.ts";
import type {
  GitRepository,
  RefSnapshot,
  RefUpdate,
  Snapshot,
} from "./contracts.ts";
import { validateRefName } from "./wal.ts";
import {
  encodePack,
  readObjects,
  objectLinks,
  type GitObject,
  type PackLimits,
  DEFAULT_PACK_LIMITS,
} from "./git/index.ts";
import { streamUploadPack } from "./git/stream.ts";

export interface GitHttpOptions {
  prefix?: string;
  /** Integration hook for a configured or externally authorized symbolic HEAD. */
  headRef?: string;
  maxBodyBytes?: number;
  maxRefs?: number;
  maxObjects?: number;
  maxGraphEdges?: number;
  maxResponseBytes?: number;
  /** Shared native Git capacity profile for verification and pack generation. */
  gitLimits?: Partial<PackLimits>;
  /** Optional, independent profile for outbound upload-pack responses. */
  fetchLimits?: Partial<PackLimits>;
  /**
   * Optional streaming upload-pack implementation. It is called before the
   * legacy buffered request path, allowing a host with indexed object access
   * to keep a large clone out of Worker memory. Return null to fall back to
   * the buffered implementation.
   */
  streamUploadPack?: (
    request: Request,
    options: Readonly<GitStreamUploadPackOptions>,
  ) => Promise<Response | null>;
  /** Synchronous best-effort observer, not a quota or billing transaction. */
  observe?: (event: Readonly<GitHttpMeterEvent>) => void;
  /** Cheap authentication runs BEFORE reading a request body. Default: deny. */
  authorizePush?: (request: Request) => boolean | Promise<boolean>;
}
export interface GitStreamUploadPackOptions {
  maxResponseBytes: number;
  maxObjects: number;
  maxGraphEdges: number;
  gitLimits: Readonly<PackLimits>;
  /** Advisory request-byte meter for chunked streaming bodies. */
  observeRequestBytes?: (bytes: number) => void;
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
const RECEIVE_CAPS = [
  "report-status",
  "delete-refs",
  "ofs-delta",
  "atomic",
  // libgit2 sends this capability for receive-pack when it is available.
  // Receive reports use channel 1 framing below.
  "side-band-64k",
];
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
function sidebandPacket(payload: string): Uint8Array {
  return pkt(join([Uint8Array.of(1), pkt(payload)]));
}
function sidebandFlush(): Uint8Array {
  return pkt(join([Uint8Array.of(1), flush()]));
}
function receiveReport(
  lines: readonly string[],
  sideband: boolean,
): Uint8Array {
  return sideband
    ? join([...lines.map(sidebandPacket), sidebandFlush(), flush()])
    : join([...lines.map(pkt), flush()]);
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

function meteredStreamResponse(
  source: Response,
  requestBytes: () => number,
  observe: ((event: Readonly<GitHttpMeterEvent>) => void) | undefined,
): Response {
  if (!source.body || !observe) return source;
  const reader = source.body.getReader();
  let responseBytes = 0;
  let reported = false;
  const report = (errorCode?: string) => {
    if (reported) return;
    reported = true;
    try {
      const event = {
        requestBytes: requestBytes(),
        responseBytes,
        status: source.status,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
      const result = observe(Object.freeze(event));
      void Promise.resolve(result).catch(() => {});
    } catch {
      /* Advisory only. */
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          report();
          controller.close();
          reader.releaseLock();
          return;
        }
        responseBytes += next.value.length;
        controller.enqueue(next.value);
      } catch (error) {
        report(classifyError(error).code);
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      report("ABORTED");
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  return new Response(body, { status: source.status, headers });
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
  const declared = length === null ? null : Number(length);
  // Git clients normally send Content-Length. Allocate the final buffer once
  // in that case; retaining chunks and joining them later briefly doubles a
  // large push's memory footprint.
  if (declared !== null) {
    const output = new Uint8Array(declared);
    const reader = request.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        observe?.(chunk.value.length);
        if (size > declared) {
          await reader.cancel("body limit");
          throw new LimitError("Request body exceeds limit");
        }
        output.set(chunk.value, size - chunk.value.length);
      }
    } finally {
      reader.releaseLock();
    }
    if (size !== declared)
      throw new IntegrityError("Request body length mismatch");
    return output;
  }
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
async function gunzipRequest(
  compressed: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined")
    throw new IntegrityError("Gzip decompression is unavailable");
  const stream = new Response(compressed.slice().buffer).body!.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel("decompressed request limit");
        throw new LimitError("Decompressed request exceeds fetch limit");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof LimitError) throw error;
    throw new IntegrityError("Invalid gzip request", { cause: error });
  } finally {
    reader.releaseLock();
  }
  return join(chunks);
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
  snapshot: RefSnapshot,
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
  const caps = [...(upload ? UPLOAD_CAPS : RECEIVE_CAPS), "agent=ntig/0.1"];
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
  gitLimits: PackLimits,
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
  const objects = await readObjects(snapshot.packs, gitLimits);
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
  const pack = await encodePack(packed, gitLimits);
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

async function loadRepositoryRefs(repo: Repository): Promise<RefSnapshot> {
  try {
    return await (repo.loadRefs ? repo.loadRefs() : repo.load());
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
  const maxRefs = options.maxRefs ?? 1024;
  const maxEdges = options.maxGraphEdges ?? 65_536;
  const gitLimits = Object.freeze({
    ...DEFAULT_PACK_LIMITS,
    ...options.gitLimits,
  });
  const fetchLimits = Object.freeze({
    ...gitLimits,
    ...options.fetchLimits,
  });
  const maxObjects = options.maxObjects ?? fetchLimits.maxObjects;
  const bodyLimit = options.maxBodyBytes ?? gitLimits.maxPackBytes + 256 * 1024;
  const fetchRequestLimit = Math.min(bodyLimit, 1024 * 1024);
  const responseLimit =
    options.maxResponseBytes ?? fetchLimits.maxPackBytes + 1 * 1024 * 1024;
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
  for (const value of [bodyLimit, maxRefs, maxObjects, maxEdges, responseLimit])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid HTTP limit");
  for (const value of Object.values(gitLimits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid native Git limit");
  for (const value of Object.values(fetchLimits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid fetch Git limit");
  return async (request: Request): Promise<Response> => {
    let requestBytes = 0;
    let errorCode: string | undefined;
    let deferredStreamObservation = false;
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
              await loadRepositoryRefs(repo),
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
        const contentEncoding = request.headers
          .get("content-encoding")
          ?.toLowerCase();
        if (receive && contentEncoding)
          return response("Content encoding is not supported\n", 415);
        let gitRequest = request;
        let requestWasDecoded = false;
        if (fetch && contentEncoding === "gzip") {
          const compressed = await bodyBytes(
            request,
            fetchRequestLimit,
            (size) => {
              requestBytes += size;
            },
          );
          const expanded = await gunzipRequest(compressed, fetchRequestLimit);
          const headers = new Headers(request.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          gitRequest = new Request(request.url, {
            method: request.method,
            headers,
            body: expanded.slice().buffer,
          });
          requestWasDecoded = true;
        } else if (contentEncoding) {
          return response("Unsupported content encoding\n", 415);
        }
        if (
          fetch &&
          (options.streamUploadPack || (repo.getObjectInfo && repo.getObject))
        ) {
          const streamed = await (
            options.streamUploadPack ??
            ((request, streamOptions) =>
              streamUploadPack(repo, request, streamOptions))
          )(
            gitRequest,
            Object.freeze({
              maxResponseBytes: responseLimit,
              maxObjects,
              maxGraphEdges: maxEdges,
              gitLimits: fetchLimits,
              ...(requestWasDecoded
                ? {}
                : {
                    observeRequestBytes: (size: number) => {
                      requestBytes += size;
                    },
                  }),
            }),
          );
          if (streamed !== null) {
            deferredStreamObservation = true;
            const length = request.headers.get("content-length");
            const knownRequestBytes =
              length !== null && /^\d+$/.test(length) ? Number(length) : 0;
            return meteredStreamResponse(
              streamed,
              () => requestBytes || knownRequestBytes,
              options.observe,
            );
          }
        }
        const bytes = await bodyBytes(
          gitRequest,
          fetch ? fetchRequestLimit : bodyLimit,
          requestWasDecoded
            ? undefined
            : (size) => {
                requestBytes += size;
              },
        );
        // Recent Git clients probe receive-pack authorization with a standalone
        // flush before sending the real pack (notably for pushes over 1 MiB).
        // It is a successful empty exchange and must not be treated as a
        // malformed ref transaction.
        if (
          receive &&
          bytes.length === 4 &&
          bytes.every((value) => value === 48)
        )
          return response(null, 200, "application/x-git-receive-pack-result");
        if (fetch)
          return response(
            await upload(repo, bytes, maxObjects, maxEdges, fetchLimits),
            200,
            "application/x-git-upload-pack-result",
          );
        const parsed = receiveCommands(bytes, maxRefs);
        const reportsStatus = parsed.caps.includes("report-status");
        const sideband = parsed.caps.includes("side-band-64k");
        const successBytes = reportsStatus
          ? receiveReport(
              [
                "unpack ok\n",
                ...parsed.updates.map((update) => `ok ${update.name}\n`),
              ],
              sideband,
            ).length
          : 0;
        if (successBytes > responseLimit)
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
        if (!reportsStatus)
          return response(
            rejection ? "Push rejected\n" : null,
            rejection ? 409 : 200,
            "application/x-git-receive-pack-result",
          );
        const safeError = rejection?.replace(/[\r\n\0]/g, " ").slice(0, 512);
        const reportLines = [
          rejection ? `unpack ${safeError}\n` : "unpack ok\n",
          ...parsed.updates.map((update) =>
            rejection
              ? `ng ${update.name} ${safeError}\n`
              : `ok ${update.name}\n`,
          ),
        ];
        const report = receiveReport(reportLines, sideband);
        return response(report, 200, "application/x-git-receive-pack-result");
      } catch (error) {
        const classified = classifyError(error);
        errorCode = classified.code;
        return response(`${classified.message}\n`, classified.status);
      }
    };
    let result = await handle();
    let responseBytes = Number(result.headers.get("content-length") ?? 0);
    if (responseBytes > responseLimit) {
      await result.body?.cancel();
      result = response("Response byte limit exceeded\n", 413);
      responseBytes = Number(result.headers.get("content-length"));
      errorCode = "LIMIT_EXCEEDED";
    }
    if (deferredStreamObservation) return result;
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
