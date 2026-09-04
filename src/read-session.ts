import { IntegrityError, RepositoryUnavailableError } from "./contracts.ts";
import type { ObjectStore, StoredObject } from "./contracts.ts";

export interface ReadSessionOptions {
  /** Cached payload bytes only; caller buffers, in-flight reads and JS overhead are separate. */
  maxBytes?: number;
  maxEntries?: number;
}

/**
 * Short-lived immutable-object read reuse. Never share across requests or tenants.
 * Root reads and ALL writes reach the inner store; misses and errors are not cached.
 * This is not a lock, an integrity verifier, a durable ledger, or a GC reader lease.
 */
export class ObjectReadSession implements ObjectStore {
  readonly #store: ObjectStore;
  readonly #prefix: string;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, StoredObject>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #closed = false;
  #generation = Symbol();

  constructor(
    store: ObjectStore,
    options: ReadSessionOptions & { prefix: string },
  ) {
    if (
      typeof options.prefix !== "string" ||
      !/^(?:[a-zA-Z0-9_-]+\/)+$/.test(options.prefix)
    )
      throw new IntegrityError("Invalid read session prefix");
    this.#store = store;
    this.#prefix = options.prefix;
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.#maxEntries = options.maxEntries ?? 512;
    for (const limit of [this.#maxBytes, this.#maxEntries])
      if (!Number.isSafeInteger(limit) || limit < 0)
        throw new IntegrityError(
          "Read session limits must be nonnegative safe integers",
        );
  }

  get stats(): Readonly<{
    hits: number;
    misses: number;
    entries: number;
    retainedBytes: number;
  }> {
    return {
      hits: this.#hits,
      misses: this.#misses,
      entries: this.#cache.size,
      retainedBytes: this.#bytes,
    };
  }

  close(): void {
    this.#closed = true;
    this.#cache.clear();
    this.#bytes = 0;
    this.#generation = Symbol();
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new RepositoryUnavailableError("Read session is closed");
  }

  #eligible(key: string): boolean {
    return (
      this.#maxBytes > 0 &&
      this.#maxEntries > 0 &&
      key.startsWith(this.#prefix) &&
      /^(?:packs|records|manifests|receipt-index)\/[a-f0-9]{64}$/.test(
        key.slice(this.#prefix.length),
      )
    );
  }

  #forget(key: string): void {
    const old = this.#cache.get(key);
    if (old) {
      this.#bytes -= old.bytes.byteLength;
      this.#cache.delete(key);
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    this.#assertOpen();
    const eligible = this.#eligible(key);
    const cached = eligible ? this.#cache.get(key) : undefined;
    if (cached) {
      this.#hits++;
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return { bytes: cached.bytes.slice(), version: cached.version };
    }
    this.#misses++;
    const generation = this.#generation;
    const value = await this.#store.get(key);
    if (!value) return null;
    if (
      eligible &&
      !this.#closed &&
      generation === this.#generation &&
      value.bytes.byteLength <= this.#maxBytes
    ) {
      this.#forget(key);
      while (
        this.#cache.size >= this.#maxEntries ||
        this.#bytes + value.bytes.byteLength > this.#maxBytes
      ) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#forget(oldest);
      }
      this.#cache.set(key, {
        bytes: value.bytes.slice(),
        version: value.version,
      });
      this.#bytes += value.bytes.byteLength;
    }
    return { bytes: value.bytes.slice(), version: value.version };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    this.#assertOpen();
    this.#generation = Symbol();
    this.#forget(key);
    try {
      // Never elide a write: host admission, reservations and uncertain outcomes still apply.
      return await this.#store.put(key, bytes.slice(), expectedVersion);
    } finally {
      // A read begun before/during the PUT cannot repopulate a stale entry afterward.
      this.#generation = Symbol();
      this.#forget(key);
    }
  }
}
