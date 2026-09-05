import {
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
  classifyError,
  type Refs,
} from "./contracts.ts";
import { NativeGitEngine } from "./git/engine.ts";
import { DEFAULT_PACK_LIMITS, type PackLimits } from "./git/pack.ts";
import { validateRefName } from "./wal.ts";

export interface GitFetchOptions {
  /** Host-authorized object IDs. Remote advertisements never grant authority. */
  wants: readonly string[];
  /** Enforce the host's outbound destination policy here; redirects stay disabled. */
  fetch?: (request: Request) => Promise<Response>;
  signal?: AbortSignal;
  maxPackBytes?: number;
  maxResponseBytes?: number;
  maxAdvertisementBytes?: number;
  maxRefs?: number;
  /** Native verification profile for the fetched pack. */
  gitLimits?: Partial<PackLimits>;
  timeoutMs?: number;
  /** Advisory, including bytes read on failed attempts. Not a quota transaction. */
  observe?: (event: Readonly<GitFetchMeterEvent>) => void;
}
export interface GitFetchMeterEvent {
  requests: number;
  requestBytes: number;
  responseBytes: number;
  status: number;
  errorCode?: string;
}
export interface GitFetchResult {
  /** Complete, verified pack containing every requested object and dependency. */
  pack: Uint8Array;
  /** Untrusted remote metadata, for diagnostics only. */
  refs: Refs;
  headRef: string | null;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const OID = /^(?!0{40}$)[a-f0-9]{40}$/;
const ZERO = "0".repeat(40);
const MIB = 1024 * 1024;
const pkt = (text: string): Uint8Array => {
  const bytes = enc.encode(text);
  if (bytes.length + 4 > 65520)
    throw new LimitError("Git packet exceeds limit");
  return join([
    enc.encode((bytes.length + 4).toString(16).padStart(4, "0")),
    bytes,
  ]);
};
const join = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
};

class Packets {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  next(): Uint8Array | null {
    const header = dec.decode(
      this.bytes.subarray(this.position, this.position + 4),
    );
    if (!/^[a-fA-F0-9]{4}$/.test(header))
      throw new IntegrityError("Invalid Git packet header");
    const size = parseInt(header, 16);
    this.position += 4;
    if (size === 0) return null;
    if (
      size < 4 ||
      size > 65520 ||
      this.position + size - 4 > this.bytes.length
    )
      throw new IntegrityError("Truncated or invalid Git packet");
    const result = this.bytes.subarray(this.position, this.position + size - 4);
    this.position += size - 4;
    return result;
  }
  text(): string | null {
    const bytes = this.next();
    return bytes === null ? null : dec.decode(bytes).replace(/\n$/, "");
  }
}

function advertisement(bytes: Uint8Array, maxRefs: number) {
  const packets = new Packets(bytes);
  if (packets.text() !== "# service=git-upload-pack" || packets.next() !== null)
    throw new IntegrityError("Expected upload-pack advertisement");
  const refs: Refs = Object.create(null);
  const all = new Map<string, string>();
  let caps: string[] = [];
  let count = 0;
  let empty = false;
  for (;;) {
    const line = packets.text();
    if (line === null) break;
    if (++count > maxRefs * 2 + 1)
      throw new LimitError("Too many advertised refs");
    const [record, suffix, ...extra] = line.split("\0");
    if (extra.length || (suffix !== undefined && count !== 1))
      throw new IntegrityError("Misplaced Git capabilities");
    if (suffix !== undefined) {
      caps = suffix.split(" ").filter(Boolean);
      if (
        caps.some((cap) => !/^[\x21-\x7e]+$/.test(cap)) ||
        new Set(caps).size !== caps.length
      )
        throw new IntegrityError("Invalid Git capabilities");
    }
    const match = /^([a-f0-9]{40}) ([^\0\r\n ]+)$/.exec(record!);
    if (!match) throw new IntegrityError("Invalid advertised ref");
    const oid = match[1]!;
    const name = match[2]!;
    if (oid === ZERO && name === "capabilities^{}" && count === 1) {
      empty = true;
      continue;
    }
    if (empty || !OID.test(oid) || all.has(name))
      throw new IntegrityError("Invalid or duplicate advertised ref");
    all.set(name, oid);
    if (name === "HEAD") continue;
    if (name.endsWith("^{}")) {
      const base = name.slice(0, -3);
      validateRefName(base);
      if (!base.startsWith("refs/tags/") || !all.has(base))
        throw new IntegrityError("Invalid peeled ref");
      continue;
    }
    validateRefName(name);
    refs[name] = oid;
    if (Object.keys(refs).length > maxRefs)
      throw new LimitError("Too many advertised refs");
  }
  if (packets.position !== bytes.length)
    throw new IntegrityError("Trailing advertisement data");
  if (
    caps.some(
      (cap) => cap.startsWith("object-format=") && cap !== "object-format=sha1",
    )
  )
    throw new IntegrityError("Only SHA-1 repositories are supported");
  const heads = caps.filter((cap) => cap.startsWith("symref=HEAD:"));
  if (heads.length > 1) throw new IntegrityError("Ambiguous remote HEAD");
  const headRef = heads[0]?.slice("symref=HEAD:".length) ?? null;
  if (headRef !== null) {
    validateRefName(headRef);
    if (!headRef.startsWith("refs/heads/"))
      throw new IntegrityError("Invalid remote HEAD");
  }
  return { refs, headRef, caps, tips: new Set(all.values()) };
}

async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
  count: (n: number) => void,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new LimitError("Git response exceeds byte limit");
  }
  if (!response.body) throw new IntegrityError("Missing Git response body");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      count(chunk.value.length);
      if (chunk.value.length > limit - size)
        throw new LimitError("Git response exceeds byte limit");
      bytes.set(chunk.value, size);
      size += chunk.value.length;
    }
    return bytes.slice(0, size);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function unpack(
  bytes: Uint8Array,
  sideband: boolean,
  maxPackBytes: number,
): Uint8Array {
  const packets = new Packets(bytes);
  // No haves or multi_ack are sent: the single stateless round starts with NAK.
  if (packets.text() !== "NAK")
    throw new IntegrityError("Unexpected upload-pack negotiation");
  if (!sideband) {
    const pack = bytes.subarray(packets.position);
    if (pack.length > maxPackBytes)
      throw new LimitError("Git pack exceeds byte limit");
    return pack;
  }
  const output = new Uint8Array(maxPackBytes);
  let size = 0;
  for (;;) {
    const packet = packets.next();
    if (packet === null) break;
    if (packet[0] === 3)
      throw new RepositoryUnavailableError("Remote Git transfer failed");
    if (packet[0] === 2) continue;
    if (packet[0] !== 1)
      throw new IntegrityError("Invalid Git sideband channel");
    const payload = packet.subarray(1);
    if (payload.length > maxPackBytes - size)
      throw new LimitError("Git pack exceeds byte limit");
    output.set(payload, size);
    size += payload.length;
  }
  if (packets.position !== bytes.length)
    throw new IntegrityError("Trailing upload-pack data");
  return output.slice(0, size);
}

/**
 * Fetch a complete SHA-1 pack over Smart HTTP without publishing repository refs.
 * HTTPS only, no credentials, redirects, cookies, shallow history or thin packs.
 * The host selects destinations and signed wants, admits cost, and rechecks
 * authority when committing. Advertisements are never publication authority.
 */
export async function fetchGitPack(
  rawURL: string,
  options: GitFetchOptions,
): Promise<GitFetchResult> {
  const url = new URL(rawURL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new IntegrityError(
      "Expected an HTTPS repository URL without credentials, query or fragment",
    );
  url.pathname = url.pathname.replace(/\/+$/, "");
  const maxPack = options.maxPackBytes ?? DEFAULT_PACK_LIMITS.maxPackBytes;
  const maxResponse =
    options.maxResponseBytes ?? DEFAULT_PACK_LIMITS.maxPackBytes + MIB;
  const maxAdvertisement = options.maxAdvertisementBytes ?? 256 * 1024;
  const maxRefs = options.maxRefs ?? 4096;
  const timeoutMs = options.timeoutMs ?? 30_000;
  for (const value of [maxPack, maxResponse, maxAdvertisement, maxRefs])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new LimitError("Invalid Git fetch limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new LimitError("Invalid Git fetch timeout");
  if (maxAdvertisement > MIB)
    throw new LimitError("Invalid Git advertisement limit");
  if (
    !Array.isArray(options.wants) ||
    !options.wants.length ||
    options.wants.length > 1024 ||
    options.wants.some((oid) => typeof oid !== "string" || !OID.test(oid))
  )
    throw new IntegrityError("Expected 1 to 1024 SHA-1 wants");
  const wants = [...new Set(options.wants)];
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal!.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("Git fetch timed out", "TimeoutError")),
    timeoutMs,
  );
  const signal = controller.signal;
  const meter: GitFetchMeterEvent = {
    requests: 0,
    requestBytes: 0,
    responseBytes: 0,
    status: 0,
  };
  const get = async (
    endpoint: string,
    type: string,
    limit: number,
    body?: Uint8Array<ArrayBuffer>,
  ) => {
    signal.throwIfAborted();
    const target = new URL(url);
    target.pathname += endpoint;
    if (body === undefined) target.search = "?service=git-upload-pack";
    const request = new Request(target, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        accept: type,
        "accept-encoding": "identity",
        ...(body === undefined
          ? {}
          : { "content-type": "application/x-git-upload-pack-request" }),
      },
      ...(body === undefined ? {} : { body }),
    });
    meter.requests++;
    meter.requestBytes += body?.length ?? 0;
    const response = await fetcher(request);
    meter.status = response.status;
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== type ||
      (response.headers.has("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    ) {
      await response.body?.cancel();
      throw new RepositoryUnavailableError(
        "Remote does not serve the requested Git protocol",
      );
    }
    return boundedBody(response, limit, signal, (n) => {
      meter.responseBytes += n;
    });
  };
  try {
    const remote = advertisement(
      await get(
        "/info/refs",
        "application/x-git-upload-pack-advertisement",
        maxAdvertisement,
      ),
      maxRefs,
    );
    if (
      wants.some((want) => !remote.tips.has(want)) &&
      !remote.caps.includes("allow-tip-sha1-in-want") &&
      !remote.caps.includes("allow-reachable-sha1-in-want")
    )
      throw new IntegrityError(
        "Remote does not support the requested unadvertised object",
      );
    const caps = ["side-band-64k", "ofs-delta", "no-progress"].filter((cap) =>
      remote.caps.includes(cap),
    );
    const body = join([
      ...wants.map((want, i) =>
        pkt(
          `want ${want}${i === 0 && caps.length ? ` ${caps.join(" ")}` : ""}\n`,
        ),
      ),
      enc.encode("0000"),
      pkt("done\n"),
    ]);
    const wire = await get(
      "/git-upload-pack",
      "application/x-git-upload-pack-result",
      maxResponse,
      body,
    );
    const pack = unpack(wire, caps.includes("side-band-64k"), maxPack);
    signal.throwIfAborted();
    await new NativeGitEngine(
      options.gitLimits === undefined ? {} : { limits: options.gitLimits },
    ).verify(
      [pack],
      Object.fromEntries(
        wants.map((want, i) => [`refs/ntig-wants/${i}`, want]),
      ),
    );
    signal.throwIfAborted();
    return { pack, refs: remote.refs, headRef: remote.headRef };
  } catch (error) {
    meter.errorCode = classifyError(error).code;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    try {
      void Promise.resolve(
        options.observe?.(Object.freeze({ ...meter })),
      ).catch(() => {});
    } catch {
      /* Advisory only. */
    }
  }
}
