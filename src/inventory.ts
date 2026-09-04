import { ConflictError, IntegrityError, LimitError } from "./contracts.ts";
import type {
  ObjectStore,
  StoredObject,
  WalRecord,
  Refs,
} from "./contracts.ts";
import { MerkleIndex } from "./merkle-index.ts";
import {
  DEFAULT_WAL_LIMITS,
  idPattern,
  object,
  parse,
  recordFrom,
  requestHash,
  sha256,
  apply,
  hashPattern,
  type WalLimits,
} from "./wal-format.ts";
import { CheckpointStore } from "./checkpoint-store.ts";

export interface ListedObject {
  key: string;
  size: number;
}
export interface InventoryListing {
  list(
    prefix: string,
    cursor: string | null,
  ): Promise<{
    keys: readonly ListedObject[];
    cursor: string | null;
  }>;
}
export interface InventoryLimits {
  maxGets: number;
  maxReadBytes: number;
  maxObjectBytes: number;
  maxListedKeys: number;
  maxPages: number;
  maxIndexNodes: number;
  maxReceipts: number;
  maxKeyBytes: number;
  maxCursorBytes: number;
}
export interface InventoryOptions {
  prefix?: string;
  limits?: Partial<InventoryLimits>;
  walLimits?: Partial<WalLimits>;
  /** Cooperative cancellation; pending provider I/O is awaited before returning. */
  signal?: AbortSignal;
}
export type InventoryKind =
  "root" | "packs" | "records" | "manifests" | "receipt-index" | "unknown";
export interface InventoryTotals {
  keys: number;
  bytes: number;
  byKind: Record<InventoryKind, { keys: number; bytes: number }>;
}
export interface InventoryReport {
  format: 1 | 2 | null;
  validation: "metadata-and-pack-hashes";
  authority: false;
  gcCandidate: false;
  root: { version: string; bytes: number; sha256: string } | null;
  sequence: number;
  listed: InventoryTotals & { pages: number };
  observed: { gets: number; readBytes: number };
  live: InventoryTotals;
  unreferenced: InventoryTotals;
  unknown: InventoryTotals;
}

const encoder = new TextEncoder();
const PREFIX = "repos/default/";
const kinds: readonly InventoryKind[] = [
  "root",
  "packs",
  "records",
  "manifests",
  "receipt-index",
  "unknown",
];
function emptyTotals(): InventoryTotals {
  return {
    keys: 0,
    bytes: 0,
    byKind: Object.fromEntries(
      kinds.map((kind) => [kind, { keys: 0, bytes: 0 }]),
    ) as InventoryTotals["byKind"],
  };
}
export const DEFAULT_INVENTORY_LIMITS: Readonly<InventoryLimits> =
  Object.freeze({
    maxGets: 10_000,
    maxReadBytes: 64 * 1024 * 1024,
    maxObjectBytes: 4 * 1024 * 1024,
    maxListedKeys: 10_000,
    maxPages: 100,
    maxIndexNodes: 10_000,
    maxReceipts: 10_000,
    maxKeyBytes: 1024,
    maxCursorBytes: 8192,
  });

function checkedLimits(input: Partial<InventoryLimits>): InventoryLimits {
  const result = { ...DEFAULT_INVENTORY_LIMITS, ...input };
  for (const [name, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new IntegrityError(`Invalid inventory limit: ${name}`);
  return result;
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, n) => value === b[n]);
}
function fail(message: string): never {
  throw new IntegrityError(message);
}
function keyBytes(key: string): number {
  return encoder.encode(key).byteLength;
}

/**
 * Read-only, fail-closed inventory of one repository. The listing is
 * advisory physical state; live totals cover objects referenced by the captured
 * root. This helper deliberately has no delete or write capability.
 */
export async function boundedInventory(
  source: Pick<ObjectStore, "get">,
  listing: InventoryListing,
  options: InventoryOptions = {},
): Promise<InventoryReport> {
  const limits = checkedLimits(options.limits ?? {});
  const prefix = options.prefix ?? PREFIX;
  const signal = options.signal;
  const checkAbort = () => signal?.throwIfAborted();
  checkAbort();
  const walLimits = { ...DEFAULT_WAL_LIMITS, ...options.walLimits };
  for (const key of Object.keys(DEFAULT_WAL_LIMITS) as (keyof WalLimits)[])
    if (!Number.isSafeInteger(walLimits[key]) || walLimits[key] < 1)
      fail("Invalid inventory WAL limits");
  if (typeof prefix !== "string" || !/^(?:[a-zA-Z0-9_-]+\/)+$/.test(prefix))
    fail("Invalid inventory prefix");
  const checkKey = (key: string) => {
    if (!key.startsWith(prefix))
      fail("Inventory key is outside the repository prefix");
    if (key.length > limits.maxKeyBytes || keyBytes(key) > limits.maxKeyBytes)
      throw new LimitError("Inventory key limit exceeded");
  };
  let gets = 0;
  let readBytes = 0;
  const observedSizes = new Map<string, number>();
  const readonlyStore: ObjectStore = {
    async get(key: string): Promise<StoredObject | null> {
      checkAbort();
      if (gets >= limits.maxGets)
        throw new LimitError("Inventory GET limit exceeded");
      checkKey(key);
      gets++;
      const value = await source.get(key);
      checkAbort();
      if (!value) return null;
      if (
        !(value.bytes instanceof Uint8Array) ||
        typeof value.version !== "string"
      )
        fail("Malformed inventory object");
      if (value.bytes.byteLength > limits.maxObjectBytes)
        throw new LimitError("Inventory object limit exceeded");
      if (value.bytes.byteLength > limits.maxReadBytes - readBytes)
        throw new LimitError("Inventory read budget exceeded");
      readBytes += value.bytes.byteLength;
      observedSizes.set(key, value.bytes.byteLength);
      return { bytes: value.bytes.slice(), version: value.version };
    },
    async put(): Promise<boolean> {
      throw new Error("bounded inventory is read-only");
    },
  };
  const rootKey = `${prefix}root.json`;
  // Capture before pagination, not just before marking.
  const root = await readonlyStore.get(rootKey);
  const physical = new Map<string, number>();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let pages = 0;
  let listedBytes = 0;
  while (true) {
    checkAbort();
    if (pages >= limits.maxPages)
      throw new LimitError("Inventory page limit exceeded");
    pages++;
    const page = await listing.list(prefix, cursor);
    checkAbort();
    if (!page || !Array.isArray(page.keys)) fail("Malformed inventory listing");
    if (page.cursor !== null && typeof page.cursor !== "string")
      fail("Malformed inventory cursor");
    if (page.cursor !== null) {
      if (!page.cursor) fail("Malformed inventory cursor");
      if (
        page.cursor.length > limits.maxCursorBytes ||
        keyBytes(page.cursor) > limits.maxCursorBytes
      )
        throw new LimitError("Inventory cursor limit exceeded");
      if (cursors.has(page.cursor)) fail("Repeated inventory cursor");
      cursors.add(page.cursor);
    }
    if (page.keys.length > limits.maxListedKeys - physical.size)
      throw new LimitError("Inventory key limit exceeded");
    for (const item of page.keys) {
      checkAbort();
      if (
        !item ||
        typeof item.key !== "string" ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0
      )
        fail("Malformed inventory entry");
      checkKey(item.key);
      if (physical.has(item.key)) fail("Duplicate inventory key");
      if (physical.size >= limits.maxListedKeys)
        throw new LimitError("Inventory key limit exceeded");
      physical.set(item.key, item.size);
      if (item.size > Number.MAX_SAFE_INTEGER - listedBytes)
        fail("Inventory byte total exceeds safe integer range");
      listedBytes += item.size;
    }
    if (page.cursor === null) break;
    cursor = page.cursor;
  }

  async function finish(
    format: 1 | 2 | null,
    sequence: number,
    liveKeys: Set<string>,
  ): Promise<InventoryReport> {
    const listed = emptyTotals();
    const live = emptyTotals();
    const unreferenced = emptyTotals();
    const unknown = emptyTotals();
    for (const key of liveKeys) {
      if (!physical.has(key))
        fail("Live object missing from inventory listing");
      if (physical.get(key) !== observedSizes.get(key))
        fail("Live object size changed during inventory");
    }
    const add = (
      total: InventoryTotals,
      kind: InventoryKind,
      bytes: number,
    ) => {
      total.keys++;
      total.bytes += bytes;
      total.byKind[kind].keys++;
      total.byKind[kind].bytes += bytes;
    };
    for (const [key, size] of physical) {
      checkAbort();
      const match =
        /^(packs|records|manifests|receipt-index)\/[a-f0-9]{64}$/.exec(
          key.slice(prefix.length),
        );
      const kind: InventoryKind =
        key === rootKey
          ? "root"
          : match
            ? (match[1] as InventoryKind)
            : "unknown";
      add(listed, kind, size);
      add(
        liveKeys.has(key) ? live : kind === "unknown" ? unknown : unreferenced,
        kind,
        size,
      );
    }
    const digest = root ? await sha256(root.bytes) : null;
    const finalRoot = await readonlyStore.get(rootKey);
    if (
      root
        ? !finalRoot ||
          finalRoot.version !== root.version ||
          !same(finalRoot.bytes, root.bytes)
        : finalRoot !== null
    )
      fail("Root changed during inventory");
    return {
      format,
      validation: "metadata-and-pack-hashes",
      authority: false,
      gcCandidate: false,
      root:
        root && digest
          ? { version: root.version, bytes: root.bytes.length, sha256: digest }
          : null,
      sequence,
      listed: { ...listed, pages },
      observed: { gets, readBytes },
      live,
      unreferenced,
      unknown,
    };
  }
  if (!root) {
    if (physical.size !== 0) fail("Missing root with non-empty inventory");
    return finish(null, 0, new Set());
  }
  const rootValue = parse(root.bytes, 1024);
  const readPack = async (hash: string) => {
    const value = await readonlyStore.get(`${prefix}packs/${hash}`);
    if (!value || (await sha256(value.bytes)) !== hash)
      fail("Missing or corrupt inventory pack");
    if (value.bytes.length > walLimits.maxPackBytes)
      throw new LimitError("Pack byte limit exceeded");
    return value.bytes.length;
  };
  if (object(rootValue) && rootValue.format === 1) {
    if (
      !Number.isSafeInteger(rootValue.sequence) ||
      typeof rootValue.sequence !== "number" ||
      rootValue.sequence < 1 ||
      typeof rootValue.tip !== "string" ||
      !hashPattern.test(rootValue.tip)
    )
      fail("Invalid legacy inventory root");
    if (rootValue.sequence > Math.min(limits.maxReceipts, walLimits.maxRecords))
      throw new LimitError("Legacy inventory history limit exceeded");
    const live = new Set([rootKey]);
    const records: WalRecord[] = [];
    let cursor: string | null = rootValue.tip;
    while (cursor !== null) {
      checkAbort();
      if (records.length >= rootValue.sequence)
        fail("Legacy inventory cycle or sequence mismatch");
      const record = await recordFromBytes(
        readonlyStore,
        prefix,
        cursor,
        limits,
        walLimits,
      );
      if (record.sequence !== rootValue.sequence - records.length)
        fail("Broken legacy inventory sequence");
      live.add(`${prefix}records/${cursor}`);
      records.push(record);
      cursor = record.parent;
    }
    if (records.length !== rootValue.sequence)
      fail("Truncated legacy inventory history");
    let refs: Refs = Object.create(null);
    const ids = new Set<string>();
    const packs = new Set<string>();
    let packBytes = 0;
    for (const record of records.reverse()) {
      checkAbort();
      if (ids.has(record.id)) fail("Duplicate committed request ID");
      ids.add(record.id);
      try {
        refs = apply(refs, record.updates, walLimits.maxRefs);
      } catch (error) {
        if (error instanceof ConflictError)
          fail("Inconsistent legacy ref history");
        throw error;
      }
      if (record.pack !== null && !packs.has(record.pack)) {
        packBytes += await readPack(record.pack);
        if (packBytes > walLimits.maxTotalPackBytes)
          throw new LimitError("Repository packed-byte limit exceeded");
        packs.add(record.pack);
        live.add(`${prefix}packs/${record.pack}`);
      }
    }
    return finish(1, rootValue.sequence, live);
  }
  if (
    !object(rootValue) ||
    rootValue.format !== 2 ||
    typeof rootValue.manifest !== "string"
  )
    fail("Inventory requires a supported root format");
  const checkpoint = new CheckpointStore(
    readonlyStore,
    { verify: async () => undefined },
    prefix,
    walLimits,
  );
  const refs = await checkpoint.loadRefs(root);
  if (refs.sequence > limits.maxReceipts)
    throw new LimitError("Inventory receipt limit exceeded");
  const manifestKey = `${prefix}manifests/${rootValue.manifest}`;
  const manifestObject = await readonlyStore.get(manifestKey);
  if (!manifestObject) fail("Missing inventory manifest");
  if ((await sha256(manifestObject.bytes)) !== rootValue.manifest)
    fail("Manifest hash mismatch");
  const manifest = parse(manifestObject.bytes, 2 * 1024 * 1024);
  if (
    !object(manifest) ||
    manifest.format !== 2 ||
    manifest.sequence !== refs.sequence ||
    !Array.isArray(manifest.packs) ||
    !(manifest.receipts === null || typeof manifest.receipts === "string") ||
    !(manifest.tip === null || typeof manifest.tip === "string")
  )
    fail("Malformed inventory manifest");

  const live = new Set<string>([rootKey, manifestKey]);
  const packIds = manifest.packs;
  let totalPackBytes = 0;
  for (const pack of packIds) {
    if (typeof pack !== "string" || !/^[a-f0-9]{64}$/.test(pack))
      fail("Malformed inventory pack ID");
    const key = `${prefix}packs/${pack}`;
    totalPackBytes += await readPack(pack);
    if (totalPackBytes > walLimits.maxTotalPackBytes)
      throw new LimitError("Repository packed-byte limit exceeded");
    live.add(key);
  }
  const index = new MerkleIndex(readonlyStore, `${prefix}receipt-index/`);
  const records = new Set<string>();
  const sequences = new Set<number>();
  const chain = new Map<number, { hash: string; record: WalRecord }>();
  let indexNodes = 0;
  await index.visit(
    manifest.receipts,
    async (hash, key, value) => {
      checkAbort();
      if (key === undefined) {
        indexNodes++;
        if (indexNodes > limits.maxIndexNodes)
          throw new LimitError("Inventory index-node limit exceeded");
        live.add(`${prefix}receipt-index/${hash}`);
        return;
      }
      if (value === undefined || records.size >= limits.maxReceipts)
        throw new LimitError("Inventory receipt limit exceeded");
      if (records.has(value)) fail("Duplicate indexed receipt");
      const record = await recordFromBytes(
        readonlyStore,
        prefix,
        value,
        limits,
        walLimits,
      );
      if ((await sha256(encoder.encode(record.id))) !== key)
        fail("Receipt index key mismatch");
      if (
        record.sequence < 1 ||
        record.sequence > refs.sequence ||
        sequences.has(record.sequence)
      )
        fail("Receipt sequence is duplicated or out of range");
      sequences.add(record.sequence);
      chain.set(record.sequence, { hash: value, record });
      records.add(value);
      if (value === manifest.tip) {
        if (
          record.sequence !== refs.sequence ||
          (record.sequence === 1
            ? record.parent !== null
            : record.parent === null) ||
          (record.pack !== null && !packIds.includes(record.pack)) ||
          record.updates.some(
            (update) => (refs.refs[update.name] ?? null) !== update.new,
          )
        )
          fail("Checkpoint tip does not match current manifest");
      }
    },
    limits.maxIndexNodes,
  );
  if (records.size !== refs.sequence)
    fail("Receipt count does not match checkpoint sequence");
  let replayedRefs: Refs = Object.create(null);
  for (let sequence = 1; sequence <= refs.sequence; sequence++) {
    checkAbort();
    const entry = chain.get(sequence);
    if (!entry) fail("Receipt sequence has a gap");
    const { record } = entry;
    if (
      record.parent !== (sequence === 1 ? null : chain.get(sequence - 1)?.hash)
    )
      fail("Receipt parent chain mismatch");
    if (record.pack !== null && !packIds.includes(record.pack))
      fail("Historical receipt pack missing from manifest");
    try {
      replayedRefs = apply(replayedRefs, record.updates, walLimits.maxRefs);
    } catch (error) {
      if (error instanceof ConflictError)
        fail("Inconsistent checkpoint ref history");
      throw error;
    }
  }
  if (
    Object.keys(replayedRefs).length !== Object.keys(refs.refs).length ||
    Object.entries(replayedRefs).some(([name, oid]) => refs.refs[name] !== oid)
  )
    fail("Checkpoint refs do not match receipt history");
  for (const hash of records) {
    const key = `${prefix}records/${hash}`;
    live.add(key);
  }
  if (manifest.tip !== null) {
    const tip = `${prefix}records/${manifest.tip}`;
    if (!live.has(tip)) fail("Checkpoint tip is not indexed");
  }
  return finish(2, refs.sequence, live);
}

async function recordFromBytes(
  store: ObjectStore,
  prefix: string,
  hash: string,
  limits: InventoryLimits,
  walLimits: Readonly<WalLimits>,
) {
  if (!/^[a-f0-9]{64}$/.test(hash)) fail("Malformed receipt record hash");
  const object = await store.get(`${prefix}records/${hash}`);
  if (!object || (await sha256(object.bytes)) !== hash)
    fail("Missing or corrupt receipt record");
  const record = recordFrom(
    parse(
      object.bytes,
      Math.min(limits.maxObjectBytes, walLimits.maxRecordBytes),
    ),
    walLimits.maxRefs,
  );
  if (
    !idPattern.test(record.id) ||
    record.sequence < 1 ||
    record.sequence > Number.MAX_SAFE_INTEGER
  )
    fail("Malformed receipt record");
  const expected = await requestHash(record.id, record.updates, record.pack);
  if (expected !== record.requestHash) fail("Receipt request digest mismatch");
  return record;
}
