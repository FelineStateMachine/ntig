import { ConflictError, IntegrityError, LimitError } from "./contracts.ts";
import type { ObjectStore } from "./contracts.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hashPattern = /^[a-f0-9]{64}$/;
const MAX_NODE_BYTES = 4 * 1024;
const MAX_LEAF_ENTRIES = 16;
const MAX_DEPTH = 64;

type Leaf = { v: 1; t: "l"; e: [string, string][] };
type Branch = { v: 1; t: "b"; c: (string | null)[] };
type Node = Leaf | Branch;

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value);
}
function validKey(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value);
}
function nodeBytes(node: Node): Uint8Array {
  return encoder.encode(JSON.stringify(node));
}
function parseNode(bytes: Uint8Array): Node {
  if (bytes.length > MAX_NODE_BYTES)
    throw new LimitError("Merkle index node exceeds byte limit");
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new IntegrityError("Invalid Merkle index node");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IntegrityError("Invalid Merkle index node");
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || (record.t !== "l" && record.t !== "b"))
    throw new IntegrityError("Invalid Merkle index node");
  if (record.t === "l") {
    if (
      !Array.isArray(record.e) ||
      record.e.length === 0 ||
      record.e.length > MAX_LEAF_ENTRIES
    )
      throw new LimitError("Merkle leaf exceeds entry limit");
    const entries: [string, string][] = [];
    let previous = "";
    for (const item of record.e) {
      if (
        !Array.isArray(item) ||
        item.length !== 2 ||
        !validKey(item[0]) ||
        !validKey(item[1]) ||
        item[0] <= previous
      )
        throw new IntegrityError("Invalid or unsorted Merkle leaf");
      previous = item[0];
      entries.push([item[0], item[1]]);
    }
    return { v: 1, t: "l", e: entries };
  }
  if (
    !Array.isArray(record.c) ||
    record.c.length !== 16 ||
    record.c.every((x) => x === null) ||
    record.c.some((x) => x !== null && !validHash(x))
  )
    throw new IntegrityError("Invalid Merkle branch");
  return { v: 1, t: "b", c: record.c as (string | null)[] };
}

export class MerkleIndex {
  readonly store: ObjectStore;
  readonly prefix: string;

  constructor(store: ObjectStore, prefix: string) {
    if (
      !prefix ||
      encoder.encode(prefix.endsWith("/") ? prefix : `${prefix}/`).length + 64 >
        1024 ||
      prefix.startsWith("/") ||
      prefix.includes("..") ||
      /[\x00-\x1f\x7f]/.test(prefix)
    )
      throw new IntegrityError("Invalid Merkle index prefix");
    this.store = store;
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  }

  private key(root: string): string {
    return `${this.prefix}${root}`;
  }

  private async read(root: string, depth: number, route = ""): Promise<Node> {
    if (!validHash(root)) throw new IntegrityError("Invalid Merkle index root");
    if (depth > MAX_DEPTH) throw new LimitError("Merkle index depth exceeded");
    const object = await this.store.get(this.key(root));
    if (!object) throw new IntegrityError("Missing Merkle index node");
    if (object.bytes.length > MAX_NODE_BYTES)
      throw new LimitError("Merkle index node exceeds byte limit");
    const actual = await hash(object.bytes);
    if (actual !== root)
      throw new IntegrityError("Merkle index node hash mismatch");
    const node = parseNode(object.bytes);
    const canonical = nodeBytes(node);
    if (
      canonical.length !== object.bytes.length ||
      !canonical.every((x, i) => x === object.bytes[i])
    )
      throw new IntegrityError("Non-canonical Merkle index node");
    if (node.t === "b" && depth === MAX_DEPTH)
      throw new LimitError("Merkle index depth exceeded");
    if (node.t === "l" && node.e.some(([key]) => !key.startsWith(route)))
      throw new IntegrityError("Merkle leaf route mismatch");
    return node;
  }

  private async write(node: Node): Promise<string> {
    const bytes = nodeBytes(node);
    if (bytes.length > MAX_NODE_BYTES)
      throw new LimitError("Merkle index node exceeds byte limit");
    const root = await hash(bytes);
    if (!(await this.store.put(this.key(root), bytes, null))) {
      const raced = await this.store.get(this.key(root));
      if (
        !raced ||
        raced.bytes.length !== bytes.length ||
        !raced.bytes.every((x, i) => x === bytes[i])
      )
        throw new IntegrityError("Merkle index concurrent write mismatch");
    }
    return root;
  }

  async get(root: string | null, key: string): Promise<string | null> {
    if (root === null) {
      if (!validKey(key)) throw new IntegrityError("Invalid Merkle index key");
      return null;
    }
    if (!validKey(key)) throw new IntegrityError("Invalid Merkle index key");
    let current = root;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const node = await this.read(current, depth, key.slice(0, depth));
      if (node.t === "l")
        return node.e.find((entry) => entry[0] === key)?.[1] ?? null;
      const child = node.c[parseInt(key[depth]!, 16)];
      if (child === undefined)
        throw new IntegrityError("Invalid Merkle branch child");
      if (child === null) return null;
      current = child;
    }
    throw new LimitError("Merkle index depth exceeded");
  }

  async insert(
    root: string | null,
    key: string,
    value: string,
  ): Promise<string> {
    if (!validKey(key) || !validKey(value))
      throw new IntegrityError(
        "Merkle index keys and values must be lowercase SHA-256 hashes",
      );
    if (root === null) return this.write({ v: 1, t: "l", e: [[key, value]] });
    const result = await this.insertNode(root, key, value, 0);
    return result.root;
  }

  /**
   * Build an index in one publication pass. Validation is deliberately
   * synchronous so malformed input cannot leave any content-addressed nodes
   * behind. The resulting trie is canonical and therefore has the same root
   * as inserting the equivalent entries one at a time.
   */
  async buildFromEntries(
    entries: readonly (readonly [string, string])[],
    maxEntries = 10_000,
  ): Promise<string | null> {
    if (!Array.isArray(entries))
      throw new IntegrityError("Invalid Merkle index entries");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new LimitError("Invalid Merkle index entry limit");
    if (entries.length > maxEntries)
      throw new LimitError("Merkle index entry limit exceeded");

    // Copy, validate, and sort before the first await. In particular, reject
    // duplicate keys even when their values happen to be identical.
    const sorted: [string, string][] = [];
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !validKey(entry[0]) ||
        !validKey(entry[1])
      )
        throw new IntegrityError(
          "Merkle index keys and values must be lowercase SHA-256 hashes",
        );
      sorted.push([entry[0], entry[1]]);
    }
    sorted.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1]![0] === sorted[i]![0])
        throw new ConflictError("Merkle index contains duplicate key");
    }
    if (sorted.length === 0) return null;
    return this.build(sorted, 0);
  }

  private async insertNode(
    root: string,
    key: string,
    value: string,
    depth: number,
  ): Promise<{ root: string; changed: boolean }> {
    const node = await this.read(root, depth, key.slice(0, depth));
    if (node.t === "l") {
      const index = node.e.findIndex((entry) => entry[0] >= key);
      if (index >= 0 && node.e[index]![0] === key) {
        if (node.e[index]![1] !== value)
          throw new ConflictError(
            "Merkle index key already has a different value",
          );
        return { root, changed: false };
      }
      const entries = node.e.slice();
      entries.splice(index < 0 ? entries.length : index, 0, [key, value]);
      if (entries.length <= MAX_LEAF_ENTRIES || depth >= MAX_DEPTH) {
        if (depth >= MAX_DEPTH && entries.length > MAX_LEAF_ENTRIES)
          throw new LimitError("Merkle index depth exceeded");
        return {
          root: await this.write({ v: 1, t: "l", e: entries }),
          changed: true,
        };
      }
      return { root: await this.build(entries, depth), changed: true };
    }
    const nibble = parseInt(key[depth]!, 16);
    const child = node.c[nibble];
    if (child === undefined)
      throw new IntegrityError("Invalid Merkle branch child");
    const result =
      child === null
        ? {
            root: await this.write({ v: 1, t: "l", e: [[key, value]] }),
            changed: true,
          }
        : await this.insertNode(child, key, value, depth + 1);
    if (!result.changed) return { root, changed: false };
    const children = node.c.slice();
    children[nibble] = result.root;
    return {
      root: await this.write({ v: 1, t: "b", c: children }),
      changed: true,
    };
  }

  private async build(
    entries: [string, string][],
    depth: number,
  ): Promise<string> {
    if (entries.length <= MAX_LEAF_ENTRIES)
      return this.write({ v: 1, t: "l", e: entries });
    if (depth >= MAX_DEPTH) throw new LimitError("Merkle index depth exceeded");
    const groups: [string, string][][] = Array.from({ length: 16 }, () => []);
    for (const entry of entries)
      groups[parseInt(entry[0][depth]!, 16)]!.push(entry);
    const children: (string | null)[] = Array(16).fill(null);
    for (let i = 0; i < 16; i++) {
      if (groups[i]!.length > 0)
        children[i] = await this.build(groups[i]!, depth + 1);
    }
    return this.write({ v: 1, t: "b", c: children });
  }

  async visit(
    root: string | null,
    visitor: (
      hash: string,
      key?: string,
      value?: string,
    ) => void | Promise<void>,
    maxNodes = 10000,
  ): Promise<void> {
    if (root === null) return;
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1)
      throw new LimitError("Invalid Merkle visit limit");
    const seen = new Set<string>();
    const walk = async (
      current: string,
      depth: number,
      route: string,
    ): Promise<void> => {
      if (seen.has(current)) throw new IntegrityError("Merkle index cycle");
      if (seen.size >= maxNodes)
        throw new LimitError("Merkle visit node limit exceeded");
      seen.add(current);
      const node = await this.read(current, depth, route);
      await visitor(current);
      if (node.t === "l") {
        for (const [key, value] of node.e) {
          if (!key.startsWith(route))
            throw new IntegrityError("Merkle leaf route mismatch");
          await visitor(current, key, value);
        }
        return;
      }
      for (let i = 0; i < 16; i++)
        if (node.c[i] !== null)
          await walk(node.c[i]!, depth + 1, `${route}${i.toString(16)}`);
    };
    await walk(root, 0, "");
  }
}
