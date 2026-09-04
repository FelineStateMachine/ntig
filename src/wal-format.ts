import { ConflictError, IntegrityError, LimitError } from "./contracts.ts";
import type { Refs, RefUpdate, WalRecord } from "./contracts.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const hashPattern = /^[a-f0-9]{64}$/;
export const oidPattern = /^[a-f0-9]{40}$/;
export const idPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;

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

export function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parse(bytes: Uint8Array, max: number): unknown {
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

export function updatesFrom(value: unknown, maxRefs: number): RefUpdate[] {
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

export function apply(
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

export function recordFrom(value: unknown, maxRefs: number): WalRecord {
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

export async function requestHash(
  id: string,
  updates: readonly RefUpdate[],
  pack: string | null,
): Promise<string> {
  return sha256(json({ id, updates, pack }));
}
