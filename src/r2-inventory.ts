import { IntegrityError, LimitError } from "./contracts.ts";
import type { InventoryListing, ListedObject } from "./inventory.ts";

export interface R2ListBucket {
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: readonly { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface R2InventoryOptions {
  prefix?: string;
  pageSize?: number;
  maxKeyBytes?: number;
  maxCursorBytes?: number;
}

const MAX_KEY_BYTES = 1024;
const encoder = new TextEncoder();

function validPath(value: string, label: string): void {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is empty or contains a control character`);
  }
  if (
    value.startsWith("/") ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError(
      `${label} must not contain absolute or traversal path segments`,
    );
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new RangeError(`${label} must be positive`);
  return result;
}

/** Read-only, bounded adapter over R2's list API. It exposes no object write,
 * delete, or metadata mutation capability. Returned keys are relative to the
 * configured tenant namespace, while R2 is always queried with the namespace. */
export class R2InventoryListing implements InventoryListing {
  readonly #bucket: R2ListBucket;
  readonly #namespace: string;
  readonly #pageSize: number;
  readonly #maxKeyBytes: number;
  readonly #maxCursorBytes: number;

  constructor(bucket: R2ListBucket, options: R2InventoryOptions = {}) {
    this.#bucket = bucket;
    const prefix = options.prefix ?? "";
    if (prefix.length > 0) validPath(prefix, "R2 prefix");
    this.#namespace =
      prefix.length === 0 || prefix.endsWith("/") ? prefix : `${prefix}/`;
    this.#maxKeyBytes = positiveLimit(
      options.maxKeyBytes,
      MAX_KEY_BYTES,
      "maxKeyBytes",
    );
    this.#maxCursorBytes = positiveLimit(
      options.maxCursorBytes,
      8192,
      "maxCursorBytes",
    );
    if (this.#maxKeyBytes > MAX_KEY_BYTES)
      throw new RangeError("maxKeyBytes must not exceed 1024");
    if (
      this.#namespace.length > this.#maxKeyBytes ||
      encoder.encode(this.#namespace).byteLength > this.#maxKeyBytes
    ) {
      throw new RangeError("R2 prefix exceeds maxKeyBytes");
    }
    this.#pageSize = positiveLimit(options.pageSize, 1000, "pageSize");
    if (this.#pageSize > 1000)
      throw new RangeError("pageSize must not exceed 1000");
  }

  async list(
    prefix: string,
    cursor: string | null,
  ): Promise<{ keys: readonly ListedObject[]; cursor: string | null }> {
    if (prefix.length > 0) validPath(prefix, "listing prefix");
    const fullPrefix = this.#namespace + prefix;
    if (
      fullPrefix.length > this.#maxKeyBytes ||
      encoder.encode(fullPrefix).byteLength > this.#maxKeyBytes
    ) {
      throw new LimitError("R2 listing prefix exceeds maxKeyBytes");
    }
    if (cursor !== null) {
      if (
        cursor.length === 0 ||
        cursor.length > this.#maxCursorBytes ||
        encoder.encode(cursor).byteLength > this.#maxCursorBytes ||
        /[\u0000-\u001f\u007f]/u.test(cursor)
      ) {
        throw new IntegrityError("Malformed R2 listing cursor");
      }
    }
    const page = await this.#bucket.list({
      prefix: fullPrefix,
      ...(cursor === null ? {} : { cursor }),
      limit: this.#pageSize,
    });
    if (
      !page ||
      !Array.isArray(page.objects) ||
      typeof page.truncated !== "boolean"
    ) {
      throw new IntegrityError("Malformed R2 listing response");
    }
    if (page.objects.length > this.#pageSize)
      throw new LimitError("R2 listing page exceeds pageSize");
    if (page.truncated && (!page.cursor || typeof page.cursor !== "string")) {
      throw new IntegrityError("Truncated R2 listing has no cursor");
    }
    if (!page.truncated && page.cursor !== undefined) {
      throw new IntegrityError("Non-truncated R2 listing has a cursor");
    }
    if (
      page.cursor !== undefined &&
      (page.cursor === cursor ||
        page.cursor.length === 0 ||
        page.cursor.length > this.#maxCursorBytes ||
        encoder.encode(page.cursor).byteLength > this.#maxCursorBytes ||
        /[\u0000-\u001f\u007f]/u.test(page.cursor))
    ) {
      throw new IntegrityError("Malformed R2 listing cursor");
    }
    const keys: ListedObject[] = [];
    const seen = new Set<string>();
    for (const object of page.objects) {
      if (
        !object ||
        typeof object.key !== "string" ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0
      ) {
        throw new IntegrityError("Malformed R2 listing entry");
      }
      if (/[\u0000-\u001f\u007f]/u.test(object.key))
        throw new IntegrityError("Malformed R2 listing key");
      if (!object.key.startsWith(fullPrefix))
        throw new IntegrityError(
          "R2 listing returned a key outside its prefix",
        );
      if (
        object.key.length > this.#maxKeyBytes ||
        encoder.encode(object.key).byteLength > this.#maxKeyBytes
      )
        throw new LimitError("R2 listing key exceeds maxKeyBytes");
      if (seen.has(object.key))
        throw new IntegrityError("Duplicate R2 listing key");
      seen.add(object.key);
      const relative = object.key.slice(this.#namespace.length);
      if (relative.length === 0)
        throw new IntegrityError("R2 listing returned the namespace itself");
      keys.push({ key: relative, size: object.size });
    }
    return { keys, cursor: page.truncated ? page.cursor! : null };
  }
}
