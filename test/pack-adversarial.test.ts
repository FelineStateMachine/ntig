import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { decodePack, readObjects } from "../src/git/pack.ts";
import { encodePack, concat } from "../src/git/encode.ts";
import { IntegrityError, LimitError } from "../src/contracts.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const hash = (data: Uint8Array) =>
  new Uint8Array(createHash("sha1").update(data).digest());
const objectId = (data: Uint8Array) =>
  hash(concat([bytes(`blob ${data.length}\0`), data]));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
function header(type: number, size: number): Uint8Array {
  const out = [(type << 4) | (size & 15)];
  size = Math.floor(size / 16);
  while (size) {
    out[out.length - 1]! |= 128;
    out.push(size & 127);
    size = Math.floor(size / 128);
  }
  return Uint8Array.from(out);
}
function pack(entries: readonly Uint8Array[]): Uint8Array {
  const head = new Uint8Array(12);
  head.set(bytes("PACK"));
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, entries.length);
  const body = concat([head, ...entries]);
  return concat([body, hash(body)]);
}
function rehash(data: Uint8Array): Uint8Array {
  const body = data.slice(0, -20);
  return concat([body, hash(body)]);
}
const full = (data: Uint8Array) =>
  concat([header(3, data.length), deflateSync(data)]);
const refDelta = (base: Uint8Array, delta: Uint8Array) =>
  concat([header(7, delta.length), objectId(base), deflateSync(delta)]);
const base = bytes("hello\n");
const derived = bytes("hello world\n");
const delta = concat([Uint8Array.of(6, 12, 0x90, 5, 7), bytes(" world\n")]);

function withGit<T>(
  run: (git: (args: string[], input?: Uint8Array | string) => Buffer) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "nostrwal-pack-"));
  const git = (args: string[], input?: Uint8Array | string) =>
    execFileSync("git", ["-C", dir, ...args], {
      ...(input === undefined ? {} : { input }),
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  try {
    git(["init", "--bare", "--quiet"]);
    return run(git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("stock Git OFS and REF packs produce exactly the original object IDs", async () => {
  const fixtures = withGit((git) => {
    const ids = Array.from({ length: 24 }, (_, i) =>
      git(
        ["hash-object", "-w", "--stdin"],
        bytes(`${"shared content\n".repeat(600)}${i}`),
      )
        .toString()
        .trim(),
    );
    return [true, false].map((ofs) => ({
      ids,
      data: new Uint8Array(
        git(
          [
            "pack-objects",
            "--stdout",
            "--window=32",
            ...(ofs ? ["--delta-base-offset"] : []),
          ],
          `${ids.join("\n")}\n`,
        ),
      ),
    }));
  });
  for (const fixture of fixtures) {
    assert.deepEqual(
      (await decodePack(fixture.data)).map((object) => object.oid).sort(),
      fixture.ids.sort(),
    );
  }
});

test("handcrafted OFS_DELTA and forward REF_DELTA also pass native Git index-pack", async () => {
  const baseEntry = full(base);
  assert.ok(baseEntry.length < 128);
  const ofs = pack([
    baseEntry,
    concat([
      header(6, delta.length),
      Uint8Array.of(baseEntry.length),
      deflateSync(delta),
    ]),
  ]);
  const forward = pack([refDelta(base, delta), baseEntry]);
  for (const candidate of [ofs, forward]) {
    withGit((git) =>
      assert.match(
        git(["index-pack", "--stdin", "--strict"], candidate).toString(),
        /pack\s+[a-f0-9]{40}/,
      ),
    );
    const objects = await decodePack(candidate);
    assert.deepEqual(
      objects.map((object) => object.oid).sort(),
      [hex(objectId(base)), hex(objectId(derived))].sort(),
    );
    assert.deepEqual(
      objects.find((object) => object.oid === hex(objectId(derived)))!.data,
      derived,
    );
  }
});

test("a real thin REF_DELTA needs an earlier pack and returns only newly decoded objects", async () => {
  const first = pack([full(base)]);
  const thin = pack([refDelta(base, delta)]);
  await assert.rejects(decodePack(thin), /unresolved delta base/);
  const bases = await readObjects([first]);
  const fresh = await decodePack(thin, {}, bases);
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0]!.data, derived);
  const all = await readObjects([first, thin]);
  assert.equal(all.size, 2);
  assert.deepEqual(all.get(hex(objectId(derived)))!.data, derived);
  withGit((git) => {
    git(["index-pack", "--stdin", "--strict"], first);
    assert.match(
      git(["index-pack", "--stdin", "--fix-thin", "--strict"], thin).toString(),
      /pack\s+[a-f0-9]{40}/,
    );
  });
});

test("forged Adler-32 with a valid outer SHA-1 is rejected", async () => {
  const candidate = pack([full(base)]);
  candidate[candidate.length - 21]! ^= 1;
  await assert.rejects(decodePack(rehash(candidate)), /zlib checksum mismatch/);
});

test("small declared output cannot hide a decompression bomb", async () => {
  const compressed = deflateSync(new Uint8Array(1024 * 1024));
  const candidate = pack([concat([header(3, 1), compressed])]);
  await assert.rejects(
    decodePack(candidate),
    (error) =>
      error instanceof LimitError && /inflated object/.test(error.message),
  );
});

test("declared sizes are exact for full objects AND delta instructions", async () => {
  await assert.rejects(
    decodePack(pack([concat([header(3, base.length + 1), deflateSync(base)])])),
    /declared object size mismatch/,
  );
  await assert.rejects(
    decodePack(
      pack([
        full(base),
        concat([
          header(7, delta.length + 1),
          objectId(base),
          deflateSync(delta),
        ]),
      ]),
    ),
    /declared object size mismatch/,
  );
});

test("truncated streams, trailing bytes, corrupt headers and pack checksums fail", async () => {
  const entry = full(base);
  await assert.rejects(
    decodePack(pack([entry.subarray(0, -1)])),
    IntegrityError,
  );
  await assert.rejects(
    decodePack(pack([concat([entry, Uint8Array.of(0)])])),
    /trailing or missing/,
  );
  const broken = pack([entry]);
  broken[0] = 0;
  await assert.rejects(decodePack(broken), /bad pack header/);
  const corrupted = pack([entry]);
  corrupted[corrupted.length - 1]! ^= 1;
  await assert.rejects(decodePack(corrupted), /pack checksum mismatch/);
});

test("stored block LEN/NLEN mismatch is caught before checksum validation", async () => {
  const zlib = Uint8Array.of(
    0x78,
    0x01,
    0x01,
    1,
    0,
    0xff,
    0xff,
    65,
    0,
    0,
    0,
    0,
  );
  await assert.rejects(
    decodePack(pack([concat([header(3, 1), zlib])])),
    /bad stored block/,
  );
});

test("delta copy truncation, bad opcodes, out-of-range copies and unresolved offsets reject", async () => {
  for (const instructions of [
    Uint8Array.of(6, 1, 0x81),
    Uint8Array.of(6, 1, 0),
    Uint8Array.of(6, 7, 0x90, 7),
  ]) {
    await assert.rejects(
      decodePack(pack([full(base), refDelta(base, instructions)])),
      IntegrityError,
    );
  }
  const invalidOffset = concat([
    header(6, delta.length),
    Uint8Array.of(1),
    deflateSync(delta),
  ]);
  await assert.rejects(
    decodePack(pack([full(base), invalidOffset])),
    /bad ofs delta/,
  );
});

test("limits cover count, per-object bytes, aggregate bytes and resolved delta depth", async () => {
  const candidate = pack([full(base)]);
  await assert.rejects(
    decodePack(candidate, { maxObjectBytes: 1 }),
    LimitError,
  );
  await assert.rejects(
    decodePack(candidate, { maxTotalObjectBytes: 1 }),
    LimitError,
  );
  await assert.rejects(decodePack(candidate, { maxObjects: 0 }), LimitError);
  await assert.rejects(decodePack(candidate, { maxPackBytes: 1 }), LimitError);
  const entries = [full(base)];
  let previous = base;
  for (let i = 0; i < 4; i++) {
    const next = concat([previous, Uint8Array.of(65 + i)]);
    entries.push(
      refDelta(
        previous,
        Uint8Array.of(
          previous.length,
          next.length,
          0x90,
          previous.length,
          1,
          65 + i,
        ),
      ),
    );
    previous = next;
  }
  await assert.rejects(
    decodePack(pack(entries), { maxDeltaDepth: 2 }),
    /delta depth exceeds limit/,
  );
  assert.equal((await decodePack(pack(entries))).length, 5);
});

test("encoding empty and multi-byte sizes is accepted by native Git", async () => {
  for (const size of [0, 15, 16, 127, 128, 4096]) {
    const candidate = await encodePack([
      { type: "blob", data: new Uint8Array(size) },
    ]);
    withGit((git) => git(["index-pack", "--stdin", "--strict"], candidate));
    assert.equal((await decodePack(candidate))[0]!.data.length, size);
  }
});
