import { IntegrityError, LimitError } from "../../src/contracts.ts";
import type { ObjectStore, StoredObject } from "../../src/contracts.ts";
import { MerkleIndex } from "../../src/merkle-index.ts";
import {
  DEFAULT_WAL_LIMITS,
  idPattern,
  object,
  parse,
  recordFrom,
  requestHash,
  sha256,
} from "../../src/wal-format.ts";
import { CheckpointStore } from "../../src/checkpoint-store.ts";

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
}
export interface InventoryReport {
  format: 2 | null;
  validation: "metadata-and-pack-hashes";
  authority: false;
  gcCandidate: false;
  root: { version: string; bytes: number } | null;
  sequence: number;
  listed: { keys: number; bytes: number; pages: number };
  observed: { gets: number; readBytes: number };
  live: { keys: number; bytes: number; byKind: Record<string, number> };
  unreferenced: { keys: number; bytes: number };
  unknown: { keys: number; bytes: number };
}

const encoder = new TextEncoder();
const PREFIX = "repos/default/";
const defaults: InventoryLimits = {
  maxGets: 10_000,
  maxReadBytes: 64 * 1024 * 1024,
  maxObjectBytes: 4 * 1024 * 1024,
  maxListedKeys: 10_000,
  maxPages: 100,
  maxIndexNodes: 10_000,
  maxReceipts: 10_000,
  maxKeyBytes: 1024,
};

function checkedLimits(input: Partial<InventoryLimits>): InventoryLimits {
  const result = { ...defaults, ...input };
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
 * Read-only, fail-closed inventory of one format-2 repository. The listing is
 * advisory physical state; only the returned live set is reachable from the
 * captured root. This helper deliberately has no delete or write capability.
 */
export async function boundedInventory(
  source: Pick<ObjectStore, "get">,
  listing: InventoryListing,
  inputLimits: Partial<InventoryLimits> = {},
  prefix = PREFIX,
): Promise<InventoryReport> {
  const limits = checkedLimits(inputLimits);
  if (typeof prefix !== "string" || !/^(?:[a-zA-Z0-9_-]+\/)+$/.test(prefix))
    fail("Invalid inventory prefix");
  const checkKey = (key: string) => {
    if (
      !key.startsWith(prefix) ||
      key.length > limits.maxKeyBytes ||
      keyBytes(key) > limits.maxKeyBytes
    )
      throw new LimitError("Inventory key limit exceeded");
  };
  let gets = 0;
  let readBytes = 0;
  const observedSizes = new Map<string, number>();
  const readonlyStore: ObjectStore = {
    async get(key: string): Promise<StoredObject | null> {
      if (gets >= limits.maxGets)
        throw new LimitError("Inventory GET limit exceeded");
      checkKey(key);
      gets++;
      const value = await source.get(key);
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
    if (pages >= limits.maxPages)
      throw new LimitError("Inventory page limit exceeded");
    pages++;
    const page = await listing.list(prefix, cursor);
    if (!page || !Array.isArray(page.keys)) fail("Malformed inventory listing");
    if (page.cursor !== null && typeof page.cursor !== "string")
      fail("Malformed inventory cursor");
    if (page.cursor !== null) {
      if (
        !page.cursor ||
        page.cursor.length > limits.maxKeyBytes ||
        keyBytes(page.cursor) > limits.maxKeyBytes
      )
        fail("Malformed inventory cursor");
      if (cursors.has(page.cursor)) fail("Repeated inventory cursor");
      cursors.add(page.cursor);
    }
    if (page.keys.length > limits.maxListedKeys - physical.size)
      throw new LimitError("Inventory key limit exceeded");
    for (const item of page.keys) {
      if (
        !item ||
        typeof item.key !== "string" ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0
      )
        fail("Malformed inventory entry");
      if (
        !item.key.startsWith(prefix) ||
        item.key.length > limits.maxKeyBytes ||
        keyBytes(item.key) > limits.maxKeyBytes
      )
        fail("Inventory entry is outside the repository prefix or key budget");
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

  if (!root) {
    if (physical.size !== 0) fail("Missing root with non-empty inventory");
    if (await readonlyStore.get(rootKey)) fail("Root changed during inventory");
    return {
      format: null,
      validation: "metadata-and-pack-hashes",
      authority: false,
      gcCandidate: false,
      root: null,
      sequence: 0,
      listed: { keys: 0, bytes: 0, pages },
      observed: { gets, readBytes },
      live: { keys: 0, bytes: 0, byKind: {} },
      unreferenced: { keys: 0, bytes: 0 },
      unknown: { keys: 0, bytes: 0 },
    };
  }
  const rootValue = parse(root.bytes, 1024);
  if (
    !object(rootValue) ||
    rootValue.format !== 2 ||
    typeof rootValue.manifest !== "string"
  )
    fail("Inventory requires a format-2 root");
  const checkpoint = new CheckpointStore(
    readonlyStore,
    { verify: async () => undefined },
    prefix,
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
  const byKind: Record<string, number> = {
    root: 1,
    manifests: 1,
    packs: 0,
    records: 0,
    "receipt-index": 0,
  };
  const packIds = manifest.packs;
  for (const pack of packIds) {
    if (typeof pack !== "string" || !/^[a-f0-9]{64}$/.test(pack))
      fail("Malformed inventory pack ID");
    const key = `${prefix}packs/${pack}`;
    const value = await readonlyStore.get(key);
    if (!value || (await sha256(value.bytes)) !== pack)
      fail("Missing or corrupt inventory pack");
    live.add(key);
    byKind.packs = (byKind.packs ?? 0) + 1;
  }
  const index = new MerkleIndex(readonlyStore, `${prefix}receipt-index/`);
  const records = new Set<string>();
  const sequences = new Set<number>();
  let indexNodes = 0;
  await index.visit(
    manifest.receipts,
    async (hash, key, value) => {
      if (key === undefined) {
        indexNodes++;
        if (indexNodes > limits.maxIndexNodes)
          throw new LimitError("Inventory index-node limit exceeded");
        live.add(`${prefix}receipt-index/${hash}`);
        byKind["receipt-index"] = (byKind["receipt-index"] ?? 0) + 1;
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
  for (let sequence = 1; sequence <= refs.sequence; sequence++)
    if (!sequences.has(sequence)) fail("Receipt sequence has a gap");
  for (const hash of records) {
    const key = `${prefix}records/${hash}`;
    live.add(key);
    byKind.records = (byKind.records ?? 0) + 1;
  }
  if (manifest.tip !== null) {
    const tip = `${prefix}records/${manifest.tip}`;
    if (!live.has(tip)) fail("Checkpoint tip is not indexed");
  }
  let liveBytes = 0;
  for (const key of live) {
    const listed = physical.get(key);
    if (listed === undefined)
      fail("Live object missing from inventory listing");
    if (observedSizes.get(key) !== listed)
      fail("Live object size changed during inventory");
    liveBytes += listed;
  }
  const finalRoot = await readonlyStore.get(rootKey);
  if (
    !finalRoot ||
    finalRoot.version !== root.version ||
    !same(finalRoot.bytes, root.bytes)
  )
    throw new IntegrityError("Root changed during inventory");
  let unreferencedKeys = 0,
    unreferencedBytes = 0,
    unknownKeys = 0,
    unknownBytes = 0;
  for (const [key, size] of physical) {
    if (live.has(key)) continue;
    const known =
      /^(?:records|packs|manifests|receipt-index)\/[a-f0-9]{64}$/.test(
        key.slice(prefix.length),
      );
    if (known) {
      unreferencedKeys++;
      unreferencedBytes += size;
    } else {
      unknownKeys++;
      unknownBytes += size;
    }
  }
  return {
    format: 2,
    validation: "metadata-and-pack-hashes",
    authority: false,
    gcCandidate: false,
    root: { version: root.version, bytes: root.bytes.byteLength },
    sequence: refs.sequence,
    listed: { keys: physical.size, bytes: listedBytes, pages },
    observed: { gets, readBytes },
    live: { keys: live.size, bytes: liveBytes, byKind },
    unreferenced: { keys: unreferencedKeys, bytes: unreferencedBytes },
    unknown: { keys: unknownKeys, bytes: unknownBytes },
  };
}

async function recordFromBytes(
  store: ObjectStore,
  prefix: string,
  hash: string,
  limits: InventoryLimits,
) {
  if (!/^[a-f0-9]{64}$/.test(hash)) fail("Malformed receipt record hash");
  const object = await store.get(`${prefix}records/${hash}`);
  if (!object || (await sha256(object.bytes)) !== hash)
    fail("Missing or corrupt receipt record");
  const record = recordFrom(
    parse(
      object.bytes,
      Math.min(limits.maxObjectBytes, DEFAULT_WAL_LIMITS.maxRecordBytes),
    ),
    DEFAULT_WAL_LIMITS.maxRefs,
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
