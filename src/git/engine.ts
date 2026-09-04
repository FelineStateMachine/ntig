import type { GitEngine, Refs } from "../contracts.ts";
import { IntegrityError, LimitError } from "../contracts.ts";
import { validateRefName } from "../wal.ts";
import {
  readObjects,
  type GitObject,
  type GitObjectType,
  type PackLimits,
  DEFAULT_PACK_LIMITS,
} from "./pack.ts";

const OID = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export interface ObjectLink {
  oid: string;
  type: GitObjectType;
}
export interface TreeEntry {
  name: Uint8Array;
  mode: string;
  oid: string;
}

/** Only headers are text: commit/tag messages may use a non-UTF8 encoding. */
function headers(data: Uint8Array): string[] {
  let end = -1;
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0) throw new IntegrityError("NUL in object header");
    if (data[i] === 10 && data[i + 1] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new IntegrityError("Object lacks header/message separator");
  const lines = decoder.decode(data.subarray(0, end)).split("\n");
  if (
    lines.some((line, i) =>
      line.startsWith(" ") ? i === 0 : !/^[a-zA-Z][a-zA-Z0-9-]* /.test(line),
    )
  ) {
    throw new IntegrityError("Malformed object header");
  }
  return lines;
}

function parseOid(line: string, prefix: string): string {
  const value = line.slice(prefix.length);
  if (!line.startsWith(prefix) || !OID.test(value) || /^0+$/.test(value))
    throw new IntegrityError(`Malformed ${prefix.trim()} object ID`);
  return value;
}

function identity(line: string): void {
  if (!/^[a-z]+ [^<>\n]* <[^<>\n]*> -?\d+ [+-]\d{4}$/.test(line))
    throw new IntegrityError("Malformed Git identity");
}

/** Raw-byte names; sorting uses Git's virtual '/' for directories. */
export function parseTree(data: Uint8Array, maxEntries = 65_536): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let position = 0;
  while (position < data.length) {
    if (entries.length >= maxEntries)
      throw new LimitError("Too many tree entries");
    const space = data.indexOf(32, position);
    if (space < 0 || space - position > 6)
      throw new IntegrityError("Malformed tree mode");
    const mode = decoder.decode(data.subarray(position, space));
    if (!["40000", "100644", "100755", "120000", "160000"].includes(mode))
      throw new IntegrityError("Unsupported or invalid tree mode");
    const nul = data.indexOf(0, space + 1);
    if (nul <= space + 1 || nul + 21 > data.length)
      throw new IntegrityError("Malformed tree entry");
    const name = data.subarray(space + 1, nul);
    const display = decoder.decode(name);
    if (
      name.includes(47) ||
      display === "." ||
      display === ".." ||
      /^\.git(?:[ .]|:|$)/i.test(display)
    )
      throw new IntegrityError("Unsafe tree path");
    const nameKey = hex(name);
    if (names.has(nameKey)) throw new IntegrityError("Duplicate tree entry");
    names.add(nameKey);
    const entry = { name, mode, oid: hex(data.subarray(nul + 1, nul + 21)) };
    if (/^0+$/.test(entry.oid)) throw new IntegrityError("Null tree object ID");
    const previous = entries.at(-1);
    if (previous && compareTreeEntries(previous, entry) >= 0)
      throw new IntegrityError("Tree entries are not sorted");
    entries.push(entry);
    position = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const length = Math.min(a.name.length, b.name.length);
  for (let i = 0; i < length; i++)
    if (a.name[i] !== b.name[i]) return a.name[i]! - b.name[i]!;
  return (
    (a.name[length] ?? (a.mode === "40000" ? 47 : 0)) -
    (b.name[length] ?? (b.mode === "40000" ? 47 : 0))
  );
}

/** Validate structure and return local dependencies. Gitlinks are external. */
export function objectLinks(
  object: GitObject,
  maxEdges = 65_536,
): ObjectLink[] {
  if (object.type === "blob") return [];
  if (object.type === "tree")
    return parseTree(object.data, maxEdges)
      .filter((entry) => entry.mode !== "160000")
      .map((entry) => ({
        oid: entry.oid,
        type: entry.mode === "40000" ? "tree" : "blob",
      }));
  const lines = headers(object.data);
  if (object.type === "commit") {
    const links: ObjectLink[] = [
      { oid: parseOid(lines[0] ?? "", "tree "), type: "tree" },
    ];
    let author = 0;
    let committer = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("tree "))
        throw new IntegrityError("Duplicate commit tree");
      if (line.startsWith("parent ")) {
        if (author || committer)
          throw new IntegrityError("Parent header after identity");
        links.push({ oid: parseOid(line, "parent "), type: "commit" });
      }
      if (line.startsWith("author ")) {
        identity(line);
        author++;
      }
      if (line.startsWith("committer ")) {
        identity(line);
        committer++;
      }
      if (links.length > maxEdges)
        throw new LimitError("Too many object dependencies");
    }
    if (author !== 1 || committer !== 1)
      throw new IntegrityError("Commit needs one author and committer");
    return links;
  }
  const target = parseOid(lines[0] ?? "", "object ");
  const type = lines[1]?.slice(5);
  if (
    !lines[1]?.startsWith("type ") ||
    !(type === "blob" || type === "tree" || type === "commit" || type === "tag")
  )
    throw new IntegrityError("Invalid annotated tag type");
  if (!lines[2]?.startsWith("tag ") || lines[2].length <= 4)
    throw new IntegrityError("Missing annotated tag name");
  for (const line of lines.slice(3)) {
    if (/^(object|type|tag) /.test(line))
      throw new IntegrityError("Duplicate annotated tag header");
    if (line.startsWith("tagger ")) identity(line);
  }
  return [{ oid: target, type }];
}

export interface NativeGitEngineOptions {
  limits?: Partial<PackLimits>;
  maxGraphEdges?: number;
}
export class NativeGitEngine implements GitEngine {
  readonly limits: Readonly<PackLimits>;
  readonly maxGraphEdges: number;
  constructor(options: NativeGitEngineOptions = {}) {
    this.limits = Object.freeze({ ...DEFAULT_PACK_LIMITS, ...options.limits });
    this.maxGraphEdges = options.maxGraphEdges ?? 65_536;
    for (const value of [...Object.values(this.limits), this.maxGraphEdges]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new LimitError("Invalid engine limit");
    }
  }
  async verify(
    packs: readonly Uint8Array[],
    refs: Readonly<Refs>,
  ): Promise<void> {
    if (packs.length > 128) throw new LimitError("Too many packs");
    const objects = await readObjects(packs, this.limits);
    let edges = 0;
    // Verify dangling objects too: no latent broken graphs for later ref updates.
    for (const object of objects.values()) {
      const links = objectLinks(object, this.maxGraphEdges - edges);
      edges += links.length;
      if (edges > this.maxGraphEdges)
        throw new LimitError("Object graph edge limit exceeded");
      for (const link of links) {
        const target = objects.get(link.oid);
        if (!target || target.type !== link.type)
          throw new IntegrityError(
            `Missing or wrong-type ${link.type}: ${link.oid}`,
          );
      }
    }
    for (const [name, tip] of Object.entries(refs)) {
      validateRefName(name);
      if (!OID.test(tip)) throw new IntegrityError("Invalid ref object ID");
      const target = objects.get(tip);
      if (!target) throw new IntegrityError(`Missing ref target: ${name}`);
      if (name.startsWith("refs/heads/") && target.type !== "commit")
        throw new IntegrityError("Branch target must be a commit");
      const parts = name.split("/");
      for (let i = 2; i < parts.length; i++)
        if (Object.hasOwn(refs, parts.slice(0, i).join("/")))
          throw new IntegrityError("Ref namespace collision");
    }
  }
}
export function validRef(ref: string): boolean {
  try {
    validateRefName(ref);
    return true;
  } catch {
    return false;
  }
}
