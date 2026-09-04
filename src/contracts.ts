/** A compare-and-swap token is opaque. Null means the key must not exist. */
export interface StoredObject {
  bytes: Uint8Array;
  version: string;
}
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  /** Return false on a failed precondition; never silently overwrite. */
  put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean>;
}
export type Refs = Record<string, string>;
export interface RefUpdate {
  name: string;
  old: string | null;
  new: string | null;
}
export interface GitEngine {
  /** Reject malformed packs, incomplete graphs, invalid branch targets and refs. */
  verify(packs: readonly Uint8Array[], refs: Readonly<Refs>): Promise<void>;
}
export interface CommitRequest {
  /** Caller-generated retry key, unique within this repository. */
  id: string;
  updates: readonly RefUpdate[];
  pack?: Uint8Array;
}
export interface Receipt {
  id: string;
  sequence: number;
  replayed: boolean;
}
export interface WalRecord {
  format: 1;
  sequence: number;
  parent: string | null;
  id: string;
  requestHash: string;
  pack: string | null;
  updates: RefUpdate[];
}
/** Metadata needed to advertise refs without loading packs or WAL records. */
export interface RefSnapshot {
  /** Undefined: legacy heuristic. Null: authority explicitly has no HEAD. */
  headRef?: string | null;
  sequence: number;
  tip: string | null;
  version: string | null;
  refs: Refs;
}
export interface Snapshot extends RefSnapshot {
  /** Present only after explicit v2 checkpoint migration. Records are then a bounded recent view. */
  checkpoint?: {
    manifestHash: string;
    receiptRoot: string | null;
    packIds: string[];
  };
  records: WalRecord[];
  packs: Uint8Array[];
}
/** Public integration seam; authority wrappers need no concrete WAL internals. */
export interface GitRepository {
  load(): Promise<Snapshot>;
  /** Optional metadata-only view for advertisements and other ref readers. */
  loadRefs?(): Promise<RefSnapshot>;
  commit(request: CommitRequest): Promise<Receipt>;
  /** Indexed committed-record lookup; does not imply the full history is in Snapshot.records. */
  lookupRecord?(id: string): Promise<WalRecord | null>;
}
export class ConflictError extends Error {
  override name = "ConflictError";
  readonly code = "CONFLICT";
}
export class IntegrityError extends Error {
  override name = "IntegrityError";
  readonly code = "INVALID_DATA";
}
export class LimitError extends Error {
  override name = "LimitError";
  readonly code = "LIMIT_EXCEEDED";
}
export class AuthorizationError extends Error {
  override name = "AuthorizationError";
  readonly code = "NOT_AUTHORIZED";
}
export class RepositoryUnavailableError extends Error {
  override name = "RepositoryUnavailableError";
  readonly code = "UNAVAILABLE";
}

/** Stable, non-sensitive client/telemetry classification; never exposes causes. */
export function classifyError(error: unknown): {
  code: string;
  status: number;
  message: string;
} {
  if (error instanceof AuthorizationError)
    return {
      code: error.code,
      status: 403,
      message: "Ref transaction is not authorized",
    };
  if (error instanceof ConflictError)
    return {
      code: error.code,
      status: 409,
      message: "Ref or request ID conflict; reload before retrying",
    };
  if (error instanceof LimitError)
    return {
      code: error.code,
      status: 413,
      message: "Request or repository limit exceeded",
    };
  if (error instanceof IntegrityError || error instanceof TypeError)
    return {
      code: "INVALID_DATA",
      status: 400,
      message: "Invalid Git request",
    };
  return {
    code: "UNAVAILABLE",
    status: 503,
    message: "Repository unavailable; push outcome may be unknown",
  };
}
