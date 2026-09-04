import type { ObjectStore, StoredObject } from "./contracts.js";

/** A deliberately small, redacted description of one storage operation.
 *
 * Keys and backend error messages are intentionally not included: callers can
 * safely forward these records to logs or a usage counter without exposing a
 * repository path or provider details. Put bytes are split into attempted and
 * committed totals so conditional-write failures are not mistaken for durable
 * storage.
 */
export type ObjectStoreMeterError =
  "invalid-input" | "limit" | "conflict" | "integrity" | "backend" | "unknown";

export interface ObjectStoreMeterEvent {
  operation: "get" | "put";
  /** UTF-8 length of the key, not the key itself. */
  keyBytes: number;
  /** Bytes returned by a successful get. */
  bytesRead: number;
  /** Bytes supplied to put, including failed conditional writes. */
  attemptedPutBytes: number;
  /** Bytes accepted by put (zero for a failed precondition or an error). */
  successfulPutBytes: number;
  outcome: "hit" | "miss" | "committed" | "condition-failed" | "error";
  conditional: "create" | "compare-and-swap" | "none";
  /** Stable coarse classification; never contains provider error text. */
  error?: ObjectStoreMeterError;
}

export type ObjectStoreMeterObserver = (
  event: Readonly<ObjectStoreMeterEvent>,
) => void | Promise<void>;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function errorKind(error: unknown): ObjectStoreMeterError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TypeError" || name === "RangeError") return "invalid-input";
  if (name === "LimitError") return "limit";
  if (name === "ConflictError") return "conflict";
  if (name === "IntegrityError") return "integrity";
  return "backend";
}

/**
 * Adds best-effort operation accounting to any ObjectStore.
 *
 * The observer is outside the storage transaction: it is invoked only after
 * the underlying operation settles, and both synchronous and asynchronous
 * observer failures are swallowed. Consequently an observer cannot change a
 * successful write into an error (or hide the original storage error).
 */
export class MeteredObjectStore implements ObjectStore {
  readonly #store: ObjectStore;
  readonly #observe: ObjectStoreMeterObserver;

  constructor(store: ObjectStore, observe: ObjectStoreMeterObserver) {
    this.#store = store;
    this.#observe = observe;
  }

  async #notify(event: ObjectStoreMeterEvent): Promise<void> {
    try {
      await this.#observe(Object.freeze(event));
    } catch {
      // Metering is advisory and must never alter storage semantics.
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const base = {
      operation: "get" as const,
      keyBytes: utf8Length(key),
      bytesRead: 0,
      attemptedPutBytes: 0,
      successfulPutBytes: 0,
      conditional: "none" as const,
    };
    try {
      const result = await this.#store.get(key);
      await this.#notify({
        ...base,
        outcome: result === null ? "miss" : "hit",
        bytesRead: result?.bytes.byteLength ?? 0,
      });
      return result;
    } catch (error) {
      await this.#notify({
        ...base,
        outcome: "error",
        error: errorKind(error),
      });
      throw error;
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    const attemptedPutBytes = bytes.byteLength;
    const base = {
      operation: "put" as const,
      keyBytes: utf8Length(key),
      bytesRead: 0,
      attemptedPutBytes,
      successfulPutBytes: 0,
      conditional:
        expectedVersion === null
          ? ("create" as const)
          : ("compare-and-swap" as const),
    };
    try {
      const committed = await this.#store.put(key, bytes, expectedVersion);
      await this.#notify({
        ...base,
        outcome: committed ? "committed" : "condition-failed",
        successfulPutBytes: committed ? attemptedPutBytes : 0,
      });
      return committed;
    } catch (error) {
      await this.#notify({
        ...base,
        outcome: "error",
        error: errorKind(error),
      });
      throw error;
    }
  }
}
