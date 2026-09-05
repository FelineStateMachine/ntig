import { sha1 } from "@noble/hashes/legacy.js";
import { IntegrityError, LimitError } from "../contracts.ts";
import type { GitRepository } from "../contracts.ts";
import type { GitObjectType, PackLimits } from "./pack.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const OID = /^[a-f0-9]{40}$/;
const ZERO = "0".repeat(40);
const MAX_PKT = 65_515;
const TYPES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");

function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function pkt(bytes: string | Uint8Array): Uint8Array {
  const body = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  if (body.length > MAX_PKT) throw new LimitError("pkt-line is too long");
  return join([
    enc.encode((body.length + 4).toString(16).padStart(4, "0")),
    body,
  ]);
}
const flush = () => enc.encode("0000");

class Packets {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  next(): Uint8Array | null {
    if (this.position + 4 > this.bytes.length)
      throw new IntegrityError("Truncated pkt-line");
    const h = dec.decode(this.bytes.subarray(this.position, this.position + 4));
    if (!/^[a-fA-F0-9]{4}$/.test(h))
      throw new IntegrityError("Invalid pkt-line length");
    const size = Number.parseInt(h, 16);
    this.position += 4;
    if (size === 0) return null;
    if (
      size < 4 ||
      size > 65_520 ||
      this.position + size - 4 > this.bytes.length
    )
      throw new IntegrityError("Invalid pkt-line size");
    const result = this.bytes.subarray(this.position, this.position + size - 4);
    this.position += size - 4;
    return result.at(-1) === 10 ? result.subarray(0, -1) : result;
  }
  text() {
    const p = this.next();
    return p === null ? null : dec.decode(p);
  }
}

function checkCaps(caps: readonly string[]) {
  for (const cap of caps)
    if (
      ![
        "side-band-64k",
        "ofs-delta",
        "filter",
        "allow-tip-sha1-in-want",
        "allow-reachable-sha1-in-want",
      ].includes(cap) &&
      !/^agent=[\x21-\x7e]+$/.test(cap)
    )
      throw new IntegrityError(`Unsupported capability: ${cap}`);
}

async function requestBytes(
  request: Request,
  observe?: (bytes: number) => void,
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)
  ) {
    await request.body?.cancel("request limit");
    throw new LimitError("Request body exceeds limit");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      observe?.(next.value.length);
      if (size > 1024 * 1024) {
        await reader.cancel("request limit");
        throw new LimitError("Request body exceeds limit");
      }
      parts.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

function parseRequest(bytes: Uint8Array) {
  const p = new Packets(bytes),
    wants: string[] = [],
    haves: string[] = [];
  let caps: string[] = [],
    filter: string | undefined,
    done = false;
  while (p.position < bytes.length) {
    const line = p.text();
    if (line === null) continue;
    if (line.startsWith("want ")) {
      const m = /^want ([a-f0-9]{40})(?: (.+))?$/.exec(line);
      if (!m || wants.length >= 1024)
        throw new IntegrityError("Malformed or excessive wants");
      if (m[2]) {
        if (wants.length)
          throw new IntegrityError("Misplaced want capabilities");
        caps = m[2].split(" ");
      }
      wants.push(m[1]!);
      continue;
    }
    if (line.startsWith("have ")) {
      if (!/^have [a-f0-9]{40}$/.test(line) || haves.length >= 4096)
        throw new IntegrityError("Unsupported negotiation command");
      haves.push(line.slice(5));
      continue;
    }
    if (line.startsWith("filter ")) {
      if (
        filter ||
        !caps.includes("filter") ||
        !["blob:none", "tree:0"].includes(line.slice(7))
      )
        throw new IntegrityError("Unsupported filter");
      filter = line.slice(7);
      continue;
    }
    if (line === "done") {
      if (done) throw new IntegrityError("Duplicate done");
      done = true;
      continue;
    }
    throw new IntegrityError("Unsupported negotiation command");
  }
  if (!wants.length || !done || p.position !== bytes.length)
    throw new IntegrityError("Incomplete upload-pack request");
  checkCaps(caps);
  return { wants: [...new Set(wants)], caps, filter };
}

function objectHeader(type: GitObjectType, size: number) {
  return enc.encode(`${type} ${size}\0`);
}

async function* deflate(data: Uint8Array): AsyncGenerator<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(
      new CompressionStream("deflate") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    )
    .getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function reachableInfo(
  repo: GitRepository,
  roots: readonly string[],
  maxObjects: number,
  maxEdges: number,
  maxTotalObjectBytes: number,
) {
  return (async () => {
    const seen = new Map<
      string,
      {
        type: GitObjectType;
        links: readonly { oid: string; type: GitObjectType }[];
      }
    >();
    const pending: { oid: string; expected?: GitObjectType }[] = roots.map(
      (oid) => ({ oid }),
    );
    let edges = 0;
    let totalBytes = 0;
    while (pending.length) {
      const { oid, expected } = pending.pop()!;
      if (seen.has(oid)) {
        if (expected && seen.get(oid)!.type !== expected)
          throw new IntegrityError("Object dependency type mismatch");
        continue;
      }
      if (!OID.test(oid) || oid === ZERO)
        throw new IntegrityError("Invalid object ID");
      if (seen.size >= maxObjects)
        throw new LimitError("Fetch object limit exceeded");
      const info = await repo.getObjectInfo!(oid);
      if (!info || info.oid !== oid)
        throw new IntegrityError(`Missing reachable object: ${oid}`);
      if (
        !OID.test(info.oid) ||
        info.size < 0 ||
        !TYPES[info.type] ||
        (expected && info.type !== expected)
      )
        throw new IntegrityError("Invalid object metadata");
      totalBytes += info.size;
      if (totalBytes > maxTotalObjectBytes)
        throw new LimitError("Fetch object bytes exceed aggregate limit");
      edges += info.links.length;
      if (edges > maxEdges)
        throw new LimitError("Fetch graph edge limit exceeded");
      seen.set(oid, { type: info.type, links: info.links });
      for (const link of info.links) {
        if (!OID.test(link.oid) || link.oid === ZERO || !TYPES[link.type])
          throw new IntegrityError("Invalid object dependency");
        pending.push({ oid: link.oid, expected: link.type });
      }
    }
    return seen;
  })();
}

export interface StreamUploadPackOptions {
  maxResponseBytes: number;
  maxObjects: number;
  maxGraphEdges: number;
  gitLimits: Readonly<PackLimits>;
  observeRequestBytes?: (bytes: number) => void;
}

/** Native indexed upload-pack: validates metadata first, then emits one object at a time. */
export async function streamUploadPack(
  repo: GitRepository,
  request: Request,
  options: StreamUploadPackOptions,
): Promise<Response | null> {
  if (!repo.getObjectInfo || !repo.getObject) return null;
  const parsed = parseRequest(
    await requestBytes(request, options.observeRequestBytes),
  );
  const refs = await (repo.loadRefs ? repo.loadRefs() : repo.load());
  const all = await reachableInfo(
    repo,
    Object.values(refs.refs),
    options.maxObjects,
    options.maxGraphEdges,
    options.gitLimits.maxTotalObjectBytes,
  );
  const selectedIds = new Set<string>();
  const pending = [...parsed.wants];
  while (pending.length) {
    const oid = pending.pop()!;
    if (selectedIds.has(oid)) continue;
    if (!all.has(oid))
      throw new IntegrityError("Want is not reachable from an advertised ref");
    selectedIds.add(oid);
    for (const l of all.get(oid)!.links) pending.push(l.oid);
  }
  const objects = [...selectedIds]
    .filter((oid) => {
      const o = all.get(oid)!;
      if (parsed.filter === "blob:none") return o.type !== "blob";
      if (parsed.filter === "tree:0")
        return o.type === "commit" || o.type === "tag";
      return true;
    })
    .map((oid) => ({ oid, type: all.get(oid)!.type }));
  const lim = options.gitLimits;
  if (objects.length > lim.maxObjects)
    throw new LimitError("Too many output objects");
  const side = parsed.caps.includes("side-band-64k");
  let canceled = false;
  async function* produce(): AsyncGenerator<Uint8Array> {
    const hash = sha1.create();
    const emit = function* (b: Uint8Array): Generator<Uint8Array> {
      hash.update(b);
      if (!side) yield b;
      else
        for (let at = 0; at < b.length; at += MAX_PKT - 1)
          yield pkt(join([Uint8Array.of(1), b.subarray(at, at + MAX_PKT - 1)]));
    };
    yield pkt("NAK\n");
    const head = new Uint8Array(12);
    head.set(enc.encode("PACK"));
    new DataView(head.buffer).setUint32(4, 2);
    new DataView(head.buffer).setUint32(8, objects.length);
    yield* emit(head);
    for (const { oid, type } of objects) {
      if (canceled) throw new DOMException("Fetch canceled", "AbortError");
      const object = await repo.getObject!(oid);
      if (
        !object ||
        object.oid !== oid ||
        object.type !== type ||
        object.data.length > lim.maxObjectBytes
      )
        throw new IntegrityError("Indexed object changed during fetch");
      const digest = sha1
        .create()
        .update(objectHeader(type, object.data.length))
        .update(object.data)
        .digest();
      if (hex(digest) !== oid)
        throw new IntegrityError("Indexed object hash mismatch");
      let size = object.data.length;
      const header = [
        (TYPES[type] << 4) |
          (size % 16) |
          ((size = Math.floor(size / 16)) ? 128 : 0),
      ];
      while (size) {
        const x = size % 128;
        size = Math.floor(size / 128);
        header.push(x | (size ? 128 : 0));
      }
      yield* emit(Uint8Array.from(header));
      for await (const chunk of deflate(object.data)) yield* emit(chunk);
    }
    const trailer = hash.digest();
    if (!side) yield trailer;
    else {
      for (let at = 0; at < trailer.length; at += MAX_PKT - 1)
        yield pkt(
          join([Uint8Array.of(1), trailer.subarray(at, at + MAX_PKT - 1)]),
        );
      yield flush();
    }
  }
  const iterator = produce();
  let output = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const chunk = next.value;
        output += chunk.length;
        if (output > options.maxResponseBytes)
          throw new LimitError("Fetch response exceeds byte limit");
        controller.enqueue(chunk);
      } catch (error) {
        if (!canceled) controller.error(error);
      }
    },
    async cancel() {
      canceled = true;
      await iterator.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-git-upload-pack-result",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
