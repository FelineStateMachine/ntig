import { unzlibSync } from "fflate";
import { IntegrityError, LimitError } from "../contracts.ts";

export type GitObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  oid: string;
  type: GitObjectType;
  data: Uint8Array;
}
export interface PackLimits {
  maxPackBytes: number;
  maxObjectBytes: number;
  maxObjects: number;
  maxDeltaDepth: number;
  maxTotalObjectBytes: number;
}
export const DEFAULT_PACK_LIMITS: Readonly<PackLimits> = Object.freeze({
  maxPackBytes: 4 * 1024 * 1024,
  maxObjectBytes: 4 * 1024 * 1024,
  maxObjects: 4096,
  maxDeltaDepth: 64,
  maxTotalObjectBytes: 16 * 1024 * 1024,
});
const TYPES: Record<number, GitObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
async function sha1(d: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", d.slice().buffer));
}
function bad(s: string): never {
  throw new IntegrityError(s);
}
function readVarint(a: Uint8Array, p: number): [number, number] {
  let n = 0,
    sh = 0;
  for (;;) {
    if (p >= a.length || sh > 53) bad("invalid varint");
    const x = a[p++]!,
      v = (x & 127) * 2 ** sh;
    if (!Number.isSafeInteger(n + v)) bad("varint overflow");
    n += v;
    if (!(x & 128)) return [n, p];
    sh += 7;
  }
}
function objectBytes(t: GitObjectType, d: Uint8Array) {
  const h = new TextEncoder().encode(`${t} ${d.length}\0`),
    o = new Uint8Array(h.length + d.length);
  o.set(h);
  o.set(d, h.length);
  return o;
}
class Bits {
  constructor(
    readonly a: Uint8Array,
    public bit: number,
  ) {}
  get(n: number) {
    if (this.bit + n > this.a.length * 8) bad("truncated deflate stream");
    let v = 0;
    for (let i = 0; i < n; i++)
      ((v |= ((this.a[this.bit >> 3]! >> (this.bit & 7)) & 1) << i),
        this.bit++);
    return v >>> 0;
  }
  align() {
    this.bit = (this.bit + 7) & ~7;
  }
}
function rev(v: number, n: number) {
  let x = 0;
  for (let i = 0; i < n; i++) x = x * 2 + ((v >> i) & 1);
  return x;
}
function huff(ls: number[], kind: "code" | "literal" | "distance" = "literal") {
  const cnt = Array(16).fill(0);
  for (const n of ls) {
    if (n > 15) bad("bad huffman length");
    if (n) cnt[n]++;
  }
  let left = 1;
  for (let n = 1; n <= 15; n++) {
    left = left * 2 - cnt[n];
    if (left < 0) bad("oversubscribed huffman tree");
  }
  const symbols = ls.filter((n) => n !== 0).length;
  // RFC1951 allows a single one-bit literal/distance code and an unused empty
  // distance tree. The code-length alphabet must always be complete.
  if (
    left > 0 &&
    !(kind !== "code" && symbols === 1 && cnt[1] === 1) &&
    !(kind === "distance" && symbols === 0)
  )
    bad("incomplete huffman tree");
  let code = 0;
  const next = Array(16).fill(0);
  for (let n = 1; n <= 15; n++) {
    code = (code + cnt[n - 1]) << 1;
    next[n] = code;
  }
  const tab = new Map<number, number>();
  for (let s = 0; s < ls.length; s++) {
    const n = ls[s]!;
    if (n) tab.set((n << 16) | rev(next[n]++, n), s);
  }
  return (b: Bits) => {
    let c = 0;
    for (let n = 1; n <= 15; n++) {
      c |= b.get(1) << (n - 1);
      const s = tab.get((n << 16) | c);
      if (s !== undefined) return s;
    }
    bad("invalid huffman code");
  };
}
const LB = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
    83, 99, 115, 131, 163, 195, 227, 258,
  ],
  LE = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
    5, 5, 5, 0,
  ];
const DB = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ],
  DE = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13,
  ];
function scan(
  a: Uint8Array,
  start: number,
  expected: number,
  max: number,
): [number, number] {
  if (start + 6 > a.length) bad("missing zlib stream");
  const cmf = a[start]!,
    flg = a[start + 1]!;
  if ((cmf & 15) !== 8 || cmf >> 4 > 7 || ((cmf << 8) + flg) % 31 || flg & 32)
    bad("invalid zlib header");
  const b = new Bits(a, (start + 2) * 8);
  let out = 0,
    done = false;
  while (!done) {
    done = !!b.get(1);
    const ty = b.get(2);
    if (ty === 0) {
      b.align();
      const n = b.get(16),
        nn = b.get(16);
      if ((n ^ 65535) !== nn) bad("bad stored block");
      if (b.bit + n * 8 > a.length * 8) bad("truncated stored block");
      b.bit += n * 8;
      out += n;
    } else if (ty !== 3) {
      let lh: (b: Bits) => number, dh: (b: Bits) => number;
      if (ty === 1) {
        lh = huff([
          ...Array(144).fill(8),
          ...Array(112).fill(9),
          ...Array(24).fill(7),
          ...Array(8).fill(8),
        ]);
        dh = huff(Array(32).fill(5), "distance");
      } else {
        const nl = b.get(5) + 257,
          nd = b.get(5) + 1,
          nc = b.get(4) + 4,
          ord = [
            16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
          ],
          cl = Array(19).fill(0);
        if (nl > 286) bad("reserved literal code count");
        for (let i = 0; i < nc; i++) cl[ord[i]!] = b.get(3);
        const ch = huff(cl, "code"),
          all: number[] = [];
        while (all.length < nl + nd) {
          const s = ch(b);
          if (s < 16) all.push(s);
          else {
            const rep =
              s === 16 ? b.get(2) + 3 : s === 17 ? b.get(3) + 3 : b.get(7) + 11;
            if (s === 16 && !all.length) bad("bad huffman repeat");
            if (all.length + rep > nl + nd) bad("huffman repeat overflow");
            const v = s === 16 ? all[all.length - 1]! : 0;
            for (let j = 0; j < rep; j++) all.push(v);
          }
        }
        if (!all[256]) bad("missing end-of-block code");
        lh = huff(all.slice(0, nl));
        dh = huff(all.slice(nl), "distance");
      }
      for (;;) {
        const s = lh(b);
        if (s < 256) out++;
        else if (s === 256) break;
        else if (s <= 285) {
          const i = s - 257,
            len = LB[i]! + b.get(LE[i]!),
            ds = dh(b);
          if (ds > 29) bad("bad distance");
          const dist = DB[ds]! + b.get(DE[ds]!);
          if (dist > out || dist > 2 ** ((cmf >> 4) + 8))
            bad("distance before output or beyond window");
          out += len;
        } else bad("bad length symbol");
        if (out > max) throw new LimitError("inflated object exceeds limit");
      }
    } else bad("reserved deflate block");
    if (out > max) throw new LimitError("inflated object exceeds limit");
  }
  if (out !== expected) bad("declared object size mismatch");
  const end = (b.bit + 7) >>> 3;
  if (end + 4 > a.length) bad("missing zlib checksum");
  return [end + 4, out];
}
function adler(a: Uint8Array) {
  let x = 1,
    y = 0;
  for (const v of a) {
    x = (x + v) % 65521;
    y = (y + x) % 65521;
  }
  return ((y << 16) | x) >>> 0;
}
interface Raw {
  offset: number;
  kind: "full" | "ofs" | "ref";
  type?: GitObjectType;
  data: Uint8Array;
  base?: string | number;
}
export async function decodePack(
  pack: Uint8Array,
  limits: Partial<PackLimits> = {},
  bases?: ReadonlyMap<string, GitObject>,
): Promise<GitObject[]> {
  const lim = { ...DEFAULT_PACK_LIMITS, ...limits };
  for (const value of Object.values(lim))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new LimitError("Invalid pack limit");
  if (pack.length > lim.maxPackBytes)
    throw new LimitError("pack exceeds limit");
  if (
    pack.length < 32 ||
    new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK"
  )
    bad("bad pack header");
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength),
    ver = dv.getUint32(4),
    cnt = dv.getUint32(8);
  if (ver !== 2 && ver !== 3) bad("unsupported pack version");
  if (cnt + (bases?.size ?? 0) > lim.maxObjects)
    throw new LimitError("too many pack objects");
  if (!eq(await sha1(pack.subarray(0, -20)), pack.subarray(-20)))
    bad("pack checksum mismatch");
  const raws: Raw[] = [],
    offs = new Map<number, GitObject>();
  const entryOffsets = new Set<number>();
  let p = 12,
    total = Array.from(bases?.values() ?? []).reduce(
      (sum, object) => sum + object.data.length,
      0,
    );
  if (total > lim.maxTotalObjectBytes)
    throw new LimitError("base objects exceed aggregate limit");
  for (let i = 0; i < cnt; i++) {
    const at = p;
    if (p >= pack.length - 20) bad("truncated object header");
    const f = pack[p++]!,
      ty = (f >> 4) & 7;
    let sz = f & 15,
      sh = 4,
      x = f;
    while (x & 128) {
      if (p >= pack.length - 20 || sh > 53) bad("object size overflow");
      x = pack[p++]!;
      sz += (x & 127) * 2 ** sh;
      sh += 7;
      if (!Number.isSafeInteger(sz)) bad("object size overflow");
    }
    if (sz > lim.maxObjectBytes) throw new LimitError("object exceeds limit");
    let base: string | number | undefined;
    if (ty === 6) {
      if (p >= pack.length - 20) bad("truncated ofs delta");
      let c = pack[p++]!,
        d = c & 127;
      while (c & 128) {
        if (p >= pack.length - 20 || d > Number.MAX_SAFE_INTEGER / 128)
          bad("bad ofs delta");
        c = pack[p++]!;
        d = (d + 1) * 128 + (c & 127);
      }
      base = at - d;
      if (
        !Number.isSafeInteger(base) ||
        base < 12 ||
        base >= at ||
        !entryOffsets.has(base)
      )
        bad("bad ofs delta");
    } else if (ty === 7) {
      if (p + 20 > pack.length - 20) bad("truncated ref delta");
      base = hex(pack.subarray(p, p + 20));
      p += 20;
    } else if (ty < 1 || ty > 4) bad("unsupported object type");
    if (sz > lim.maxTotalObjectBytes - total)
      throw new LimitError("decoded objects exceed aggregate limit");
    const [end, n] = scan(
      pack.subarray(0, -20),
      p,
      sz,
      Math.min(sz, lim.maxObjectBytes),
    );
    if (end > pack.length - 20) bad("object exceeds pack");
    const check = new DataView(
      pack.buffer,
      pack.byteOffset + end - 4,
      4,
    ).getUint32(0);
    let data: Uint8Array;
    try {
      data = unzlibSync(pack.subarray(p, end), { out: new Uint8Array(n) });
    } catch {
      bad("invalid deflate payload");
    }
    if (data.length !== sz) bad("declared object size mismatch");
    if (adler(data) !== check) bad("zlib checksum mismatch");
    total += data.length;
    if (total > lim.maxTotalObjectBytes)
      throw new LimitError("decoded objects exceed aggregate limit");
    raws.push(
      ty <= 4
        ? { offset: at, kind: "full", type: TYPES[ty]!, data }
        : { offset: at, kind: ty === 6 ? "ofs" : "ref", base: base!, data },
    );
    entryOffsets.add(at);
    p = end;
  }
  if (p !== pack.length - 20) bad("pack has trailing or missing data");
  const resolved = new Map<string, GitObject>(bases),
    pending = raws.slice(),
    fresh: GitObject[] = [];
  const depth = new Map<number, number>(),
    depthOid = new Map<string, number>();
  while (pending.length) {
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = pending[i]!;
      let b: GitObject | undefined;
      if (r.kind === "full") {
        b = {
          oid: hex(await sha1(objectBytes(r.type!, r.data))),
          type: r.type!,
          data: r.data,
        };
      } else
        b =
          r.kind === "ref"
            ? resolved.get(r.base as string)
            : offs.get(r.base as number);
      if (!b) continue;
      const dep =
        r.kind === "full"
          ? 0
          : r.kind === "ofs"
            ? (depth.get(r.base as number) ?? 0) + 1
            : (depthOid.get(b.oid) ?? 0) + 1;
      if (dep > lim.maxDeltaDepth)
        throw new LimitError("delta depth exceeds limit");
      const data =
        r.kind === "full"
          ? b.data
          : applyDelta(b.data, r.data, lim, lim.maxTotalObjectBytes - total);
      if (r.kind !== "full") {
        total += data.length;
        if (total > lim.maxTotalObjectBytes)
          throw new LimitError("decoded objects exceed aggregate limit");
      }
      const o =
        r.kind === "full"
          ? b
          : {
              oid: hex(await sha1(objectBytes(b.type, data))),
              type: b.type,
              data,
            };
      const existing = resolved.get(o.oid);
      if (existing && (existing.type !== o.type || !eq(existing.data, o.data)))
        bad("conflicting object with same SHA-1");
      resolved.set(o.oid, o);
      offs.set(r.offset, o);
      depth.set(r.offset, dep);
      depthOid.set(o.oid, dep);
      fresh.push(o);
      pending.splice(i, 1);
      progress = true;
    }
    if (!progress) bad("unresolved delta base");
  }
  return fresh;
}
export async function readObjects(
  packs: readonly Uint8Array[],
  limits: Partial<PackLimits> = {},
) {
  const out = new Map<string, GitObject>();
  const lim = { ...DEFAULT_PACK_LIMITS, ...limits };
  if (
    packs.length > 128 ||
    packs.reduce((sum, pack) => sum + pack.length, 0) > 16 * 1024 * 1024
  )
    throw new LimitError("aggregate pack limit exceeded");
  let total = 0;
  for (const p of packs)
    for (const o of await decodePack(p, lim, out)) {
      if (!out.has(o.oid)) {
        total += o.data.length;
        if (total > lim.maxTotalObjectBytes)
          throw new LimitError("decoded objects exceed aggregate limit");
        out.set(o.oid, o);
      }
    }
  return out;
}
function applyDelta(
  base: Uint8Array,
  d: Uint8Array,
  lim: PackLimits,
  remaining: number,
) {
  let p = 0;
  const [bs, p1] = readVarint(d, p);
  p = p1;
  const [os, p2] = readVarint(d, p);
  p = p2;
  if (bs !== base.length) bad("delta base size mismatch");
  if (os > lim.maxObjectBytes || os > remaining)
    throw new LimitError("delta exceeds limit");
  const o = new Uint8Array(os);
  let q = 0;
  while (p < d.length) {
    const op = d[p++]!;
    if (!op) bad("invalid delta opcode");
    if (op & 128) {
      let off = 0,
        sz = 0;
      for (let i = 0; i < 4; i++)
        if (op & (1 << i)) {
          if (p >= d.length) bad("truncated delta copy");
          off += d[p++]! * 2 ** (8 * i);
        }
      for (let i = 0; i < 3; i++)
        if (op & (16 << i)) {
          if (p >= d.length) bad("truncated delta copy");
          sz += d[p++]! * 2 ** (8 * i);
        }
      if (!sz) sz = 65536;
      if (off > base.length || sz > base.length - off || sz > o.length - q)
        bad("delta copy out of bounds");
      o.set(base.subarray(off, off + sz), q);
      q += sz;
    } else {
      if (op > d.length - p || op > o.length - q)
        bad("delta insert out of bounds");
      o.set(d.subarray(p, p + op), q);
      p += op;
      q += op;
    }
  }
  if (q !== os) bad("delta output size mismatch");
  return o;
}
