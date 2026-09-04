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
  Snapshot,
  StoredObject,
  WalRecord,
} from "./contracts.ts";
import { MerkleIndex } from "./merkle-index.ts";
import {
  DEFAULT_WAL_LIMITS,
  apply,
  hashPattern,
  idPattern,
  json,
  object,
  parse,
  recordFrom,
  requestHash,
  sha256,
  updatesFrom,
  validateRefName,
  type WalLimits,
} from "./wal-format.ts";

const text = new TextEncoder();
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PACK_IDS = 128;

export interface CheckpointMetadata {
  manifestHash: string;
  receiptRoot: string | null;
  packIds: string[];
}

/** The metadata-only view used by advertisements and authorization checks. */
export interface RefSnapshot {
  sequence: number;
  tip: string | null;
  version: string;
  refs: Refs;
}

type CheckpointSnapshot = Snapshot & { checkpoint?: CheckpointMetadata };
type Manifest = {
  format: 2;
  sequence: number;
  tip: string | null;
  refs: Refs;
  packs: string[];
  receipts: string | null;
};

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value);
}
function keyFor(id: string): Promise<string> {
  return sha256(text.encode(id));
}

/** Content-addressed checkpoint manifests and a copy-on-write receipt index. */
export class CheckpointStore {
  readonly store: ObjectStore;
  readonly engine: GitEngine;
  readonly prefix: string;
  readonly limits: Readonly<WalLimits>;
  readonly index: MerkleIndex;

  constructor(
    store: ObjectStore,
    engine: GitEngine,
    prefix: string,
    limits: Readonly<WalLimits> = DEFAULT_WAL_LIMITS,
  ) {
    if (!/^(?:[a-zA-Z0-9_-]+\/)+$/.test(prefix))
      throw new IntegrityError("Invalid checkpoint prefix");
    this.store = store;
    this.engine = engine;
    this.prefix = prefix;
    this.limits = limits;
    this.index = new MerkleIndex(store, `${prefix}receipt-index/`);
  }

  private path(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  private async immutable(suffix: string, bytes: Uint8Array): Promise<void> {
    const key = this.path(suffix);
    if (await this.store.put(key, bytes, null)) return;
    const existing = await this.store.get(key);
    if (!existing || !same(existing.bytes, bytes))
      throw new IntegrityError("Content-addressed object conflict");
  }

  private validateManifest(value: unknown): Manifest {
    if (
      !object(value) ||
      value.format !== 2 ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !(value.tip === null || validHash(value.tip)) ||
      !(value.receipts === null || validHash(value.receipts)) ||
      !Array.isArray(value.packs) ||
      value.packs.length > MAX_PACK_IDS ||
      value.packs.some((p) => !validHash(p)) ||
      !object(value.refs)
    )
      throw new IntegrityError("Invalid checkpoint manifest");
    const refs: Refs = Object.create(null);
    for (const [name, oid] of Object.entries(value.refs)) {
      validateRefName(name);
      if (
        typeof oid !== "string" ||
        !/^[a-f0-9]{40}$/.test(oid) ||
        /^0+$/.test(oid)
      )
        throw new IntegrityError("Invalid checkpoint ref");
      refs[name] = oid;
    }
    if (Object.keys(refs).length > this.limits.maxRefs)
      throw new LimitError("Too many refs in checkpoint");
    for (const name of Object.keys(refs)) {
      const parts = name.split("/");
      for (let n = 2; n < parts.length; n++)
        if (Object.hasOwn(refs, parts.slice(0, n).join("/")))
          throw new IntegrityError("Ref namespace collision");
    }
    const packs = [...value.packs] as string[];
    if (new Set(packs).size !== packs.length)
      throw new IntegrityError("Duplicate checkpoint pack");
    if (
      value.sequence === 0 &&
      (value.tip !== null ||
        value.receipts !== null ||
        Object.keys(refs).length !== 0 ||
        packs.length !== 0)
    )
      throw new IntegrityError("Empty checkpoint has a tip or receipt index");
    if (value.sequence > 0 && (value.tip === null || value.receipts === null))
      throw new IntegrityError(
        "Non-empty checkpoint is missing a tip or receipt index",
      );
    return {
      format: 2,
      sequence: value.sequence,
      tip: value.tip,
      refs,
      packs,
      receipts: value.receipts,
    };
  }

  private async manifest(
    root: StoredObject,
  ): Promise<{ value: Manifest; hash: string }> {
    const rootValue = parse(root.bytes, 1024);
    if (
      !object(rootValue) ||
      rootValue.format !== 2 ||
      !Number.isSafeInteger(rootValue.sequence) ||
      (rootValue.sequence as number) < 0 ||
      !validHash(rootValue.manifest)
    )
      throw new IntegrityError("Invalid checkpoint root");
    const manifestHash = rootValue.manifest;
    const item = await this.store.get(this.path(`manifests/${manifestHash}`));
    if (!item)
      throw new IntegrityError("Missing or corrupt checkpoint manifest");
    if (item.bytes.length > MAX_MANIFEST_BYTES)
      throw new LimitError("Checkpoint manifest too large");
    if ((await sha256(item.bytes)) !== manifestHash)
      throw new IntegrityError("Missing or corrupt checkpoint manifest");
    const value = this.validateManifest(parse(item.bytes, MAX_MANIFEST_BYTES));
    const rootSequence = rootValue.sequence as number;
    if (value.sequence !== rootSequence)
      throw new IntegrityError("Checkpoint root sequence mismatch");
    return { value, hash: manifestHash };
  }

  /** Read only root and manifest; this deliberately does not scrub packs or receipts. */
  async loadRefs(root: StoredObject): Promise<RefSnapshot> {
    const { value } = await this.manifest(root);
    return {
      sequence: value.sequence,
      tip: value.tip,
      version: root.version,
      refs: value.refs,
    };
  }

  async load(root: StoredObject): Promise<Snapshot> {
    const { value, hash } = await this.manifest(root);
    const packs: Uint8Array[] = [];
    let total = 0;
    for (const id of value.packs) {
      const item = await this.store.get(this.path(`packs/${id}`));
      if (!item) throw new IntegrityError("Missing or corrupt checkpoint pack");
      if (item.bytes.length > this.limits.maxPackBytes)
        throw new LimitError("Pack byte limit exceeded");
      if ((await sha256(item.bytes)) !== id)
        throw new IntegrityError("Missing or corrupt checkpoint pack");
      total += item.bytes.length;
      if (total > this.limits.maxTotalPackBytes)
        throw new LimitError("Repository packed-byte limit exceeded");
      packs.push(item.bytes);
    }
    await this.engine.verify(packs, value.refs);
    let records: WalRecord[] = [];
    if (value.tip !== null) {
      const item = await this.store.get(this.path(`records/${value.tip}`));
      if (!item)
        throw new IntegrityError("Missing or corrupt checkpoint tip record");
      if (item.bytes.length > this.limits.maxRecordBytes)
        throw new LimitError("Transaction metadata limit exceeded");
      if ((await sha256(item.bytes)) !== value.tip)
        throw new IntegrityError("Missing or corrupt checkpoint tip record");
      const record = recordFrom(
        parse(item.bytes, this.limits.maxRecordBytes),
        this.limits.maxRefs,
      );
      if (
        record.sequence !== value.sequence ||
        (value.sequence === 1
          ? record.parent !== null
          : record.parent === null) ||
        (record.pack !== null && !value.packs.includes(record.pack)) ||
        record.requestHash !==
          (await requestHash(record.id, record.updates, record.pack))
      )
        throw new IntegrityError("Invalid checkpoint tip record");
      if (
        value.receipts === null ||
        (await this.index.get(value.receipts, await keyFor(record.id))) !==
          value.tip
      )
        throw new IntegrityError(
          "Checkpoint tip is missing from receipt index",
        );
      for (const update of record.updates) {
        const actual = value.refs[update.name] ?? null;
        if (actual !== update.new)
          throw new IntegrityError(
            "Checkpoint tip does not match manifest refs",
          );
      }
      records = [record];
    }
    return {
      sequence: value.sequence,
      tip: value.tip,
      version: root.version,
      refs: value.refs,
      records,
      packs,
      checkpoint: {
        manifestHash: hash,
        receiptRoot: value.receipts,
        packIds: [...value.packs],
      },
    } as Snapshot;
  }

  async lookupRecord(
    root: StoredObject,
    id: string,
  ): Promise<WalRecord | null> {
    if (typeof id !== "string" || !idPattern.test(id))
      throw new IntegrityError("Invalid request ID");
    const { value } = await this.manifest(root);
    if (value.receipts === null) return null;
    const recordHash = await this.index.get(value.receipts, await keyFor(id));
    if (recordHash === null) return null;
    const item = await this.store.get(this.path(`records/${recordHash}`));
    if (!item) throw new IntegrityError("Missing or corrupt indexed receipt");
    if (item.bytes.length > this.limits.maxRecordBytes)
      throw new LimitError("Transaction metadata limit exceeded");
    if ((await sha256(item.bytes)) !== recordHash)
      throw new IntegrityError("Missing or corrupt indexed receipt");
    const record = recordFrom(
      parse(item.bytes, this.limits.maxRecordBytes),
      this.limits.maxRefs,
    );
    if (
      record.id !== id ||
      record.sequence > value.sequence ||
      record.requestHash !==
        (await requestHash(record.id, record.updates, record.pack))
    )
      throw new IntegrityError("Receipt index points to invalid record");
    return record;
  }

  async migrate(
    snapshot: Snapshot,
  ): Promise<{ sequence: number; changed: boolean }> {
    const current = snapshot as CheckpointSnapshot;
    if (current.checkpoint)
      return { sequence: snapshot.sequence, changed: false };
    if (snapshot.records.length !== snapshot.sequence)
      throw new IntegrityError("Legacy snapshot history is incomplete");
    const recordHashes: string[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < snapshot.records.length; i++) {
      const record = snapshot.records[i]!;
      if (record.sequence !== i + 1 || ids.has(record.id))
        throw new IntegrityError("Legacy snapshot history is inconsistent");
      ids.add(record.id);
      if (
        record.requestHash !==
        (await requestHash(record.id, record.updates, record.pack))
      )
        throw new IntegrityError("Legacy snapshot contains an invalid record");
      if (i === 0 && record.parent !== null)
        throw new IntegrityError("Legacy snapshot has an invalid first parent");
      if (i > 0 && record.parent === null)
        throw new IntegrityError(
          "Legacy snapshot record chain is inconsistent",
        );
      // The parent pointer is the original content address. Do not derive
      // legacy addresses by reserializing parsed records.
      recordHashes.push("");
    }
    if (snapshot.records.length > 0) {
      recordHashes[recordHashes.length - 1] = snapshot.tip!;
      for (let i = recordHashes.length - 2; i >= 0; i--)
        recordHashes[i] = snapshot.records[i + 1]!.parent!;
    }
    if (
      (snapshot.tip ?? null) !== (recordHashes.at(-1) ?? null) ||
      recordHashes.some((hash) => !validHash(hash))
    )
      throw new IntegrityError("Legacy snapshot tip is inconsistent");
    if (snapshot.packs.length > MAX_PACK_IDS)
      throw new LimitError("Too many checkpoint packs");
    let totalPackBytes = 0;
    for (const pack of snapshot.packs) {
      if (pack.length > this.limits.maxPackBytes)
        throw new LimitError("Pack byte limit exceeded");
      totalPackBytes += pack.length;
    }
    if (totalPackBytes > this.limits.maxTotalPackBytes)
      throw new LimitError("Repository packed-byte limit exceeded");
    const receiptEntries: [string, string][] = [];
    for (let i = 0; i < snapshot.records.length; i++) {
      const record = snapshot.records[i]!;
      const recordHash = recordHashes[i]!;
      const stored = await this.store.get(this.path(`records/${recordHash}`));
      if (!stored)
        throw new IntegrityError("Missing legacy record during migration");
      if (stored.bytes.length > this.limits.maxRecordBytes)
        throw new LimitError("Transaction metadata limit exceeded");
      if (
        (await sha256(stored.bytes)) !== recordHash ||
        !same(
          json(
            recordFrom(
              parse(stored.bytes, this.limits.maxRecordBytes),
              this.limits.maxRefs,
            ),
          ),
          json(record),
        )
      )
        throw new IntegrityError(
          "Legacy record bytes do not match content address",
        );
      receiptEntries.push([await keyFor(record.id), recordHash]);
    }
    const receiptRoot = await this.index.buildFromEntries(
      receiptEntries,
      this.limits.maxRecords,
    );
    const packIds: string[] = [];
    for (const pack of snapshot.packs) {
      const id = await sha256(pack);
      if (!packIds.includes(id)) packIds.push(id);
      await this.immutable(`packs/${id}`, pack);
    }
    if (packIds.length > MAX_PACK_IDS)
      throw new LimitError("Too many checkpoint packs");
    const manifest: Manifest = {
      format: 2,
      sequence: snapshot.sequence,
      tip: snapshot.tip,
      refs: snapshot.refs,
      packs: packIds,
      receipts: receiptRoot,
    };
    const manifestBytes = json(manifest);
    if (manifestBytes.length > MAX_MANIFEST_BYTES)
      throw new LimitError("Checkpoint manifest too large");
    const manifestHash = await sha256(manifestBytes);
    await this.immutable(`manifests/${manifestHash}`, manifestBytes);
    const committed = await this.store.put(
      this.path("root.json"),
      json({ format: 2, sequence: manifest.sequence, manifest: manifestHash }),
      snapshot.version,
    );
    if (!committed) throw new ConflictError("Concurrent checkpoint migration");
    return { sequence: snapshot.sequence, changed: true };
  }

  private async committedRecord(
    root: StoredObject,
    id: string,
  ): Promise<WalRecord | null> {
    try {
      return await this.lookupRecord(root, id);
    } catch (cause) {
      if (cause instanceof LimitError) throw cause;
      throw new RepositoryUnavailableError("Cannot read committed receipt", {
        cause,
      });
    }
  }

  async commit(snapshot: Snapshot, request: CommitRequest): Promise<Receipt> {
    const id = request.id;
    if (typeof id !== "string" || !idPattern.test(id))
      throw new IntegrityError("Invalid request ID");
    const updates = updatesFrom(request.updates, this.limits.maxRefs);
    const pack = request.pack?.slice();
    if (pack && (pack.length < 32 || pack.length > this.limits.maxPackBytes))
      throw new LimitError("Pack byte limit exceeded");
    const packId = pack ? await sha256(pack) : null;
    const digest = await requestHash(id, updates, packId);
    const current = snapshot as CheckpointSnapshot;
    const prior =
      current.checkpoint && snapshot.version
        ? await this.committedRecord(
            {
              bytes: json({
                format: 2,
                sequence: snapshot.sequence,
                manifest: current.checkpoint.manifestHash,
              }),
              version: snapshot.version,
            },
            id,
          )
        : (snapshot.records.find((r) => r.id === id) ?? null);
    if (prior) {
      if (prior.requestHash !== digest)
        throw new ConflictError(
          "Request ID already used for different content",
        );
      return { id, sequence: prior.sequence, replayed: true };
    }
    if (
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence === Number.MAX_SAFE_INTEGER
    )
      throw new LimitError("Checkpoint sequence exhausted");
    const refs = apply(snapshot.refs, updates, this.limits.maxRefs);
    const packIds = [...(current.checkpoint?.packIds ?? [])];
    if (packId && !packIds.includes(packId)) packIds.push(packId);
    if (packIds.length > MAX_PACK_IDS)
      throw new LimitError("Too many checkpoint packs");
    const packs =
      pack &&
      !snapshot.packs.some((p) => p.length === pack.length && same(p, pack))
        ? [...snapshot.packs, pack]
        : snapshot.packs;
    let totalPackBytes = 0;
    for (const item of packs) {
      if (item.length > this.limits.maxPackBytes)
        throw new LimitError("Pack byte limit exceeded");
      totalPackBytes += item.length;
    }
    if (totalPackBytes > this.limits.maxTotalPackBytes)
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
    const recordHash = await sha256(recordBytes);
    if (pack && packId) await this.immutable(`packs/${packId}`, pack);
    await this.immutable(`records/${recordHash}`, recordBytes);
    let receiptRoot = current.checkpoint?.receiptRoot ?? null;
    receiptRoot = await this.index.insert(
      receiptRoot,
      await keyFor(id),
      recordHash,
    );
    const manifest: Manifest = {
      format: 2,
      sequence: record.sequence,
      tip: recordHash,
      refs,
      packs: packIds,
      receipts: receiptRoot,
    };
    const manifestBytes = json(manifest);
    if (manifestBytes.length > MAX_MANIFEST_BYTES)
      throw new LimitError("Checkpoint manifest too large");
    const manifestHash = await sha256(manifestBytes);
    await this.immutable(`manifests/${manifestHash}`, manifestBytes);
    const committed = await this.store.put(
      this.path("root.json"),
      json({ format: 2, sequence: record.sequence, manifest: manifestHash }),
      snapshot.version,
    );
    if (!committed) {
      const winnerRoot = await this.store.get(this.path("root.json"));
      if (winnerRoot) {
        const winner = await this.committedRecord(winnerRoot, id);
        if (winner) {
          if (winner.requestHash !== digest)
            throw new ConflictError(
              "Request ID already used for different content",
            );
          return { id, sequence: winner.sequence, replayed: true };
        }
      }
      throw new ConflictError(
        "Concurrent checkpoint commit; reload before retrying",
      );
    }
    return { id, sequence: record.sequence, replayed: false };
  }
}
