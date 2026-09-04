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
  RefSnapshot,
  Snapshot,
  StoredObject,
  WalRecord,
} from "./contracts.ts";
import { CheckpointStore } from "./checkpoint-store.ts";
import { ObjectReadSession, type ReadSessionOptions } from "./read-session.ts";

import {
  DEFAULT_WAL_LIMITS,
  sha256,
  validateRefName,
  json,
  object,
  parse,
  updatesFrom,
  apply,
  recordFrom,
  requestHash,
  hashPattern,
  idPattern,
  type WalLimits,
} from "./wal-format.ts";
export {
  DEFAULT_WAL_LIMITS,
  sha256,
  validateRefName,
  type WalLimits,
} from "./wal-format.ts";

/** Immutable data; one CAS root is the ONLY authoritative commit point. */
export class WalRepository {
  readonly prefix: string;
  readonly limits: Readonly<WalLimits>;
  private readonly store: ObjectStore;
  private readonly engine: GitEngine;
  private readonly checkpoints: CheckpointStore;

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
    this.checkpoints = new CheckpointStore(
      store,
      engine,
      this.prefix,
      this.limits,
    );
  }

  async load(): Promise<Snapshot> {
    return this.loadRoot(await this.store.get(`${this.prefix}root.json`));
  }

  /** Reuse immutable reads within one awaited operation; roots and authority stay fresh. */
  async withReadSession<T>(
    operation: (repository: WalRepository) => Promise<T>,
    options: ReadSessionOptions = {},
  ): Promise<T> {
    const store = new ObjectReadSession(this.store, {
      ...options,
      prefix: this.prefix,
    });
    const repository = new WalRepository(store, this.engine, {
      prefix: this.prefix,
      limits: this.limits,
    });
    try {
      return await operation(repository);
    } finally {
      store.close();
    }
  }

  private async loadRoot(root: StoredObject | null): Promise<Snapshot> {
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
    if (object(value) && value.format === 2) return this.checkpoints.load(root);
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

  /** Metadata-only for v2; legacy repositories retain full replay/verification. */
  async loadRefs(): Promise<RefSnapshot> {
    const root = await this.store.get(`${this.prefix}root.json`);
    if (root) {
      const value = parse(root.bytes, 1024);
      if (object(value) && value.format === 2)
        return this.checkpoints.loadRefs(root);
    }
    const { sequence, tip, version, refs } = await this.loadRoot(root);
    return { sequence, tip, version, refs };
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
    if (snapshot.checkpoint)
      return this.checkpoints.commit(snapshot, {
        id,
        updates,
        ...(pack === undefined ? {} : { pack }),
      });
    const prior = this.replay(snapshot, id, digest);
    if (prior) return prior;
    if (snapshot.sequence >= this.limits.maxRecords)
      throw new LimitError(
        "Legacy WAL history limit reached; explicit checkpoint migration required",
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
      const current = await this.load();
      const prior = current.checkpoint ? await this.lookupRecord(id) : null;
      const winner = this.replay(
        prior ? { ...current, records: [prior] } : current,
        id,
        digest,
      );
      if (winner) return winner;
      throw new ConflictError(
        "Concurrent transaction committed; reload refs before retrying",
      );
    }
    return { id, sequence: record.sequence, replayed: false };
  }

  /** Explicit one-way format upgrade. Old readers must be retired before migration. */
  async checkpoint(): Promise<{ sequence: number; changed: boolean }> {
    return this.checkpoints.migrate(await this.load());
  }

  async lookupRecord(id: string): Promise<WalRecord | null> {
    if (typeof id !== "string" || !idPattern.test(id))
      throw new IntegrityError("Invalid request ID");
    const root = await this.store.get(`${this.prefix}root.json`);
    if (!root) return null;
    const value = parse(root.bytes, 1024);
    if (object(value) && value.format === 2)
      return this.checkpoints.lookupRecord(root, id);
    const snapshot = await this.loadRoot(root);
    return snapshot.records.find((record) => record.id === id) ?? null;
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
