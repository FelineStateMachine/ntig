import { LimitError } from "./contracts.ts";
import type { ObjectStore, StoredObject } from "./contracts.ts";

/** The part of the R2 API used by the WAL. Keeping this narrow makes the
 * storage core usable with both real R2 and the local Miniflare implementation. */
export interface R2StoreBucket {
  get(key: string): Promise<{
    size: number;
    etag: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(
    key: string,
    value: ArrayBufferView,
    options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } },
  ): Promise<{ etag: string } | null>;
}

export interface R2StoreOptions {
  /** Maximum object size accepted by this adapter, in bytes. */
  maxObjectBytes?: number;
  /** Optional namespace prepended to every key (without requiring callers to
   * know the bucket layout). A trailing slash is added when needed. */
  prefix?: string;
}

// Keep the buffered adapter comfortably below the Workers memory ceiling.
// Streaming/multipart support will be a separate path for larger packs.
const DEFAULT_MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_KEY_BYTES = 1024;
const encoder = new TextEncoder();

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function validateKey(key: string): void {
  if (
    key.length === 0 ||
    encoder.encode(key).byteLength > MAX_KEY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(key)
  ) {
    throw new TypeError(
      "R2 object key is empty, too long, or contains a control character",
    );
  }
  if (
    key.startsWith("/") ||
    key.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError(
      "R2 object key must not contain absolute or traversal path segments",
    );
  }
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("maxObjectBytes must be a positive safe integer");
  }
  return limit;
}

/** ObjectStore backed by a single R2 bucket.
 *
 * R2's etag is exposed as the ObjectStore version. `put` uses R2's conditional
 * write atomically: null expectedVersion means create-if-absent, while a
 * non-null value is an etag compare-and-swap. A failed precondition is never
 * converted into an overwrite.
 */
export class R2ObjectStore implements ObjectStore {
  readonly #bucket: R2StoreBucket;
  readonly #prefix: string;
  readonly #maxObjectBytes: number;

  constructor(bucket: R2StoreBucket, options: R2StoreOptions = {}) {
    this.#bucket = bucket;
    this.#maxObjectBytes = validateLimit(
      options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
    );
    const prefix = options.prefix ?? "";
    if (/[\u0000-\u001f\u007f]/u.test(prefix)) {
      throw new TypeError("R2 prefix contains a control character");
    }
    this.#prefix =
      prefix.length === 0 || prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (encoder.encode(this.#prefix).byteLength > MAX_KEY_BYTES) {
      throw new RangeError("R2 prefix exceeds the 1024-byte key limit");
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    validateKey(key);
    const fullKey = this.#prefix + key;
    if (encoder.encode(fullKey).byteLength > MAX_KEY_BYTES) {
      throw new TypeError("R2 object key exceeds the 1024-byte UTF-8 limit");
    }
    const object = await this.#bucket.get(fullKey);
    if (object === null) return null;
    if (object.size > this.#maxObjectBytes) {
      throw new LimitError(
        `R2 object exceeds maxObjectBytes (${this.#maxObjectBytes})`,
      );
    }
    // A normal get returns R2ObjectBody. The explicit check protects against
    // accidentally passing a mock/object returned by a conditional get.
    if (
      !("arrayBuffer" in object) ||
      typeof object.arrayBuffer !== "function"
    ) {
      throw new TypeError("R2 get returned an object without a body");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > this.#maxObjectBytes) {
      throw new LimitError(
        `R2 object exceeds maxObjectBytes (${this.#maxObjectBytes})`,
      );
    }
    return { bytes, version: object.etag };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    validateKey(key);
    const fullKey = this.#prefix + key;
    if (encoder.encode(fullKey).byteLength > MAX_KEY_BYTES) {
      throw new TypeError("R2 object key exceeds the 1024-byte UTF-8 limit");
    }
    if (expectedVersion !== null && expectedVersion.length === 0) {
      throw new TypeError(
        "expectedVersion must be null or a non-empty R2 etag",
      );
    }
    if (bytes.byteLength > this.#maxObjectBytes) {
      throw new LimitError(
        `R2 object exceeds maxObjectBytes (${this.#maxObjectBytes})`,
      );
    }
    // Copy before crossing the async boundary: callers are free to reuse or
    // mutate their Uint8Array as soon as put() is called.
    const owned = copyBytes(bytes);
    const onlyIf =
      expectedVersion === null
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: expectedVersion };
    const result = await this.#bucket.put(fullKey, owned, { onlyIf });
    return result !== null;
  }
}
