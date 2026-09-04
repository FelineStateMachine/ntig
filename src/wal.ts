import {
  ConflictError,
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
} from "./contracts.ts";
import type {
  CommitRequest,
  GitEngine,
  ObjectStore,
  Receipt,
  Refs,
  RefUpdate,
  Snapshot,
  WalRecord,
} from "./contracts.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hashPattern = /^[a-f0-9]{64}$/;
const oidPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;

export interface WalLimits {
  maxPackBytes: number;
  maxTotalPackBytes: number;
  maxRecords: number;
  maxRefs: number;
  maxRecordBytes: number;
}
export const DEFAULT_WAL_LIMITS: Readonly<WalLimits> = Object.freeze({
  maxPackBytes: 4 * 1024 * 1024,
  maxTotalPackBytes: 16 * 1024 * 1024,
  maxRecords: 128,
  maxRefs: 1024,
  maxRecordBytes: 256 * 1024,
});

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parse(bytes: Uint8Array, max: number): unknown {
  if (bytes.length > max) throw new LimitError("Metadata exceeds byte limit");
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new IntegrityError("Invalid UTF-8/JSON metadata");
  }
}

export function validateRefName(name: string): void {
  if (
    !name.startsWith("refs/") ||
    encoder.encode(name).length > 1024 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith(".") ||
    name
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new IntegrityError(`Invalid ref name: ${name}`);
  }
}

function updatesFrom(value: unknown, maxRefs: number): RefUpdate[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxRefs) {
    throw new LimitError("A transaction needs 1..maxRefs updates");
  }
  const names = new Set<string>();
  const updates: RefUpdate[] = [];
  for (const item of value) {
    if (
      !object(item) ||
      typeof item.name !== "string" ||
      !(
        item.old === null ||
        (typeof item.old === "string" &&
          oidPattern.test(item.old) &&
          !/^0+$/.test(item.old))
      ) ||
      !(
        item.new === null ||
        (typeof item.new === "string" &&
          oidPattern.test(item.new) &&
          !/^0+$/.test(item.new))
      )
    ) {
      throw new IntegrityError("Invalid ref update (SHA-1 or null required)");
    }
    validateRefName(item.name);
    if (names.has(item.name)) throw new IntegrityError("Duplicate ref update");
    names.add(item.name);
    updates.push({ name: item.name, old: item.old, new: item.new });
  }
  return updates.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function apply(
  refs: Readonly<Refs>,
  updates: readonly RefUpdate[],
  maxRefs: number,
): Refs {
  const result: Refs = Object.assign(Object.create(null), refs);
  for (const update of updates) {
    if ((result[update.name] ?? null) !== update.old)
      throw new ConflictError(`Stale ref: ${update.name}`);
    if (update.new === null) delete result[update.name];
    else result[update.name] = update.new;
  }
  const names = Object.keys(result).sort();
  if (names.length > maxRefs) throw new LimitError("Too many refs");
  for (const name of names) {
    // Check every path prefix, not just adjacent lexical entries (foo-bar sorts between foo and foo/bar).
    const parts = name.split("/");
    for (let n = 2; n < parts.length; n++) {
      if (Object.hasOwn(result, parts.slice(0, n).join("/")))
        throw new IntegrityError("Ref namespace collision");
    }
  }
  return result;
}

function recordFrom(value: unknown, maxRefs: number): WalRecord {
  if (
    !object(value) ||
    value.format !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.sequence !== "number" ||
    value.sequence < 1 ||
    !(
      value.parent === null ||
      (typeof value.parent === "string" && hashPattern.test(value.parent))
    ) ||
    typeof value.id !== "string" ||
    !idPattern.test(value.id) ||
    typeof value.requestHash !== "string" ||
    !hashPattern.test(value.requestHash) ||
    !(
      value.pack === null ||
      (typeof value.pack === "string" && hashPattern.test(value.pack))
    )
  ) {
    throw new IntegrityError("Invalid WAL record");
  }
  return {
    format: 1,
    sequence: value.sequence,
    parent: value.parent,
    id: value.id,
    requestHash: value.requestHash,
    pack: value.pack,
    updates: updatesFrom(value.updates, maxRefs),
  };
}

async function requestHash(
  id: string,
  updates: readonly RefUpdate[],
  pack: string | null,
): Promise<string> {
  return sha256(json({ id, updates, pack }));
}

/** Immutable packs + records; one CAS root is the ONLY authoritative commit point.
 * Deliberately bounded experimental implementation: no pruning/checkpointing yet.
 */
export class WalRepository {
  readonly prefix: string;
  readonly limits: Readonly<WalLimits>;
  private readonly store: ObjectStore;
  private readonly engine: GitEngine;

  constructor(
    store: ObjectStore,
    engine: GitEngine,
    options: { prefix?: string; limits?: Partial<WalLimits> } = {},
  ) {
    this.store = store;
    this.engine = engine;
    this.prefix = options.prefix ?? "repos/default/";
    if (!/^(?:[a-zA-Z0-9_-]+\/)+$/.test(this.prefix))
      throw new Error("Prefix must be safe path segments ending in /");
    this.limits = Object.freeze({ ...DEFAULT_WAL_LIMITS, ...options.limits });
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Limits must be positive safe integers");
    }
  }

  async load(): Promise<Snapshot> {
    const root = await this.store.get(`${this.prefix}root.json`);
    if (!root)
      return {
        sequence: 0,
        tip: null,
        version: null,
        refs: Object.create(null),
        records: [],
        packs: [],
      };
    const value = parse(root.bytes, 1024);
    if (
      !object(value) ||
      value.format !== 1 ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 ||
      typeof value.tip !== "string" ||
      !hashPattern.test(value.tip)
    )
      throw new IntegrityError("Invalid WAL root");
    if (value.sequence > this.limits.maxRecords)
      throw new LimitError("WAL history limit reached");
    const records: WalRecord[] = [];
    let cursor: string | null = value.tip;
    while (cursor !== null) {
      if (records.length >= value.sequence)
        throw new IntegrityError("WAL cycle or incorrect sequence");
      const item = await this.store.get(`${this.prefix}records/${cursor}`);
      if (!item || (await sha256(item.bytes)) !== cursor)
        throw new IntegrityError("Missing or corrupt WAL record");
      const record = recordFrom(
        parse(item.bytes, this.limits.maxRecordBytes),
        this.limits.maxRefs,
      );
      if (record.sequence !== value.sequence - records.length)
        throw new IntegrityError("Broken WAL sequence");
      if (
        record.requestHash !==
        (await requestHash(record.id, record.updates, record.pack))
      )
        throw new IntegrityError("Invalid request digest");
      records.push(record);
      cursor = record.parent;
    }
    if (records.length !== value.sequence)
      throw new IntegrityError("Truncated WAL history");
    records.reverse();
    let refs: Refs = Object.create(null);
    const packs: Uint8Array[] = [];
    let total = 0;
    const ids = new Set<string>();
    const packIds = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id))
        throw new IntegrityError("Duplicate committed request ID");
      ids.add(record.id);
      try {
        refs = apply(refs, record.updates, this.limits.maxRefs);
      } catch (error) {
        if (error instanceof ConflictError)
          throw new IntegrityError("WAL has inconsistent ref history");
        throw error;
      }
      if (record.pack !== null && !packIds.has(record.pack)) {
        const pack = await this.store.get(`${this.prefix}packs/${record.pack}`);
        if (!pack) throw new IntegrityError("Missing pack");
        this.checkPackSize(pack.bytes);
        total += pack.bytes.length;
        if (total > this.limits.maxTotalPackBytes)
          throw new LimitError("Repository packed-byte limit exceeded");
        if ((await sha256(pack.bytes)) !== record.pack)
          throw new IntegrityError("Corrupt pack");
        packs.push(pack.bytes);
        packIds.add(record.pack);
      }
    }
    await this.engine.verify(packs, refs);
    return {
      sequence: value.sequence,
      tip: value.tip,
      version: root.version,
      refs,
      records,
      packs,
    };
  }

  async commit(request: CommitRequest): Promise<Receipt> {
    // Copy mutable input before the first await, so digest, validation and storage agree.
    const id = request.id;
    if (typeof id !== "string" || !idPattern.test(id))
      throw new IntegrityError("Invalid request ID");
    const updates = updatesFrom(request.updates, this.limits.maxRefs);
    if (request.pack) this.checkPackSize(request.pack);
    const pack = request.pack?.slice();
    const packId = pack ? await sha256(pack) : null;
    const digest = await requestHash(id, updates, packId);
    const snapshot = await this.load().catch((cause: unknown) => {
      if (cause instanceof LimitError) throw cause;
      throw new RepositoryUnavailableError(
        "Cannot load repository for commit",
        { cause },
      );
    });
    const prior = this.replay(snapshot, id, digest);
    if (prior) return prior;
    if (snapshot.sequence >= this.limits.maxRecords)
      throw new LimitError(
        "WAL history limit reached; checkpointing is not implemented",
      );
    const refs = apply(snapshot.refs, updates, this.limits.maxRefs);
    const duplicatePack =
      packId !== null &&
      snapshot.records.some((record) => record.pack === packId);
    const packs =
      pack && !duplicatePack ? [...snapshot.packs, pack] : snapshot.packs;
    if (
      packs.reduce((sum, item) => sum + item.length, 0) >
      this.limits.maxTotalPackBytes
    )
      throw new LimitError("Repository packed-byte limit exceeded");
    await this.engine.verify(packs, refs);
    const record: WalRecord = {
      format: 1,
      sequence: snapshot.sequence + 1,
      parent: snapshot.tip,
      id,
      requestHash: digest,
      pack: packId,
      updates,
    };
    const recordBytes = json(record);
    if (recordBytes.length > this.limits.maxRecordBytes)
      throw new LimitError("Transaction metadata limit exceeded");
    const recordId = await sha256(recordBytes);
    if (pack && packId) await this.immutable(`packs/${packId}`, pack);
    await this.immutable(`records/${recordId}`, recordBytes);
    const committed = await this.store.put(
      `${this.prefix}root.json`,
      json({ format: 1, sequence: record.sequence, tip: recordId }),
      snapshot.version,
    );
    if (!committed) {
      const winner = this.replay(await this.load(), id, digest);
      if (winner) return winner;
      throw new ConflictError(
        "Concurrent transaction committed; reload refs before retrying",
      );
    }
    return { id, sequence: record.sequence, replayed: false };
  }

  private replay(
    snapshot: Snapshot,
    id: string,
    digest: string,
  ): Receipt | null {
    const prior = snapshot.records.find((record) => record.id === id);
    if (!prior) return null;
    if (prior.requestHash !== digest)
      throw new ConflictError("Request ID already used for different content");
    return { id, sequence: prior.sequence, replayed: true };
  }

  private checkPackSize(pack: Uint8Array): void {
    if (pack.length < 32) throw new IntegrityError("Pack is too short");
    if (pack.length > this.limits.maxPackBytes)
      throw new LimitError("Pack byte limit exceeded");
  }

  private async immutable(suffix: string, bytes: Uint8Array): Promise<void> {
    const key = `${this.prefix}${suffix}`;
    if (await this.store.put(key, bytes, null)) return;
    const existing = await this.store.get(key);
    if (
      !existing ||
      existing.bytes.length !== bytes.length ||
      existing.bytes.some((value, index) => value !== bytes[index])
    ) {
      throw new IntegrityError("Content-addressed object conflict");
    }
  }
}
