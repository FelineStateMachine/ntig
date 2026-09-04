import { bech32 } from "@scure/base";

/** The validated identity and repository identifier used by GRASP paths. */
export interface RepositoryAddress {
  npub: string;
  pubkey: string;
  identifier: string;
}

const UTF8 = new TextEncoder();

function identifierBytes(identifier: string): Uint8Array {
  if (identifier.length === 0)
    throw new TypeError("identifier must not be empty");
  // TextEncoder replaces lone surrogates, so reject them before encoding.
  for (let i = 0; i < identifier.length; i++) {
    const c = identifier.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (
        i + 1 >= identifier.length ||
        identifier.charCodeAt(i + 1) < 0xdc00 ||
        identifier.charCodeAt(i + 1) > 0xdfff
      )
        throw new TypeError("identifier contains an unpaired surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError("identifier contains an unpaired surrogate");
    }
  }
  for (const c of identifier) {
    const n = c.codePointAt(0)!;
    if (n <= 0x1f || (n >= 0x7f && n <= 0x9f))
      throw new TypeError("identifier contains a control character");
  }
  const bytes = UTF8.encode(identifier);
  // This is an implementation-local quota, not a GRASP protocol limit.
  if (bytes.length > 256)
    throw new RangeError("identifier exceeds the 256-byte local quota");
  return bytes;
}

function decodeNpub(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length !== 63 ||
    value !== value.toLowerCase()
  )
    throw new TypeError("npub must be a lowercase 63-character identifier");
  try {
    const decoded = bech32.decodeToBytes(value);
    if (decoded.prefix !== "npub" || decoded.bytes.length !== 32)
      throw new TypeError("invalid npub");
    return decoded.bytes;
  } catch {
    throw new TypeError("invalid npub");
  }
}

export function repositoryAddress(
  npub: string,
  identifier: string,
): RepositoryAddress {
  const pubkey = decodeNpub(npub);
  identifierBytes(identifier);
  const canonicalNpub = bech32.encodeFromBytes("npub", pubkey);
  return {
    npub: canonicalNpub,
    pubkey: Array.from(pubkey, (b) => b.toString(16).padStart(2, "0")).join(""),
    identifier,
  };
}

function encodeIdentifier(identifier: string): string {
  const bytes = identifierBytes(identifier);
  let result = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      "-._~".includes(ch)
    )
      result += ch;
    else result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

export function repositoryPath(
  address: RepositoryAddress,
  alternativePRs = false,
): string {
  const checked = repositoryAddress(address.npub, address.identifier);
  return `${alternativePRs ? "/prs" : ""}/${checked.npub}/${encodeIdentifier(checked.identifier)}.git`;
}

type RepositoryEndpoint =
  "root" | "info/refs" | "git-upload-pack" | "git-receive-pack";
export interface ParsedRepositoryPath {
  address: RepositoryAddress;
  alternativePRs: boolean;
  prefix: string;
  endpoint: RepositoryEndpoint;
}

function decodeCanonicalSegment(segment: string): string | null {
  // decodeURIComponent decodes exactly one layer and rejects malformed UTF-8/percent escapes.
  if (/%(?![0-9a-fA-F]{2})/.test(segment)) return null;
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  try {
    return encodeIdentifier(value) === segment ? value : null;
  } catch {
    return null;
  }
}

export function parseRepositoryPath(
  pathname: string,
): ParsedRepositoryPath | null {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#")
  )
    return null;
  const parts = pathname.split("/");
  if (parts[0] !== "") return null;
  const alternativePRs = parts[1] === "prs";
  const base = alternativePRs ? 2 : 1;
  if (parts.length < base + 2 || parts[base + 1] === "") return null;
  const npubPart = parts[base];
  const filePart = parts[base + 1];
  if (npubPart === undefined || filePart === undefined) return null;
  let endpoint: RepositoryEndpoint = "root";
  const trailing = parts.slice(base + 2);
  if (trailing.length === 2 && trailing[0] === "info" && trailing[1] === "refs")
    endpoint = "info/refs";
  else if (trailing.length === 1 && trailing[0] === "git-upload-pack")
    endpoint = "git-upload-pack";
  else if (trailing.length === 1 && trailing[0] === "git-receive-pack")
    endpoint = "git-receive-pack";
  else if (trailing.length !== 0) {
    return null;
  }
  let identifierPart = filePart;
  if (identifierPart.endsWith(".git"))
    identifierPart = identifierPart.slice(0, -4);
  else return null;
  const identifier = decodeCanonicalSegment(identifierPart);
  if (identifier === null) return null;
  let address: RepositoryAddress;
  try {
    address = repositoryAddress(npubPart, identifier);
  } catch {
    return null;
  }
  return {
    address,
    alternativePRs,
    prefix: repositoryPath(address, alternativePRs),
    endpoint,
  };
}

export async function repositoryStoragePrefix(
  address: RepositoryAddress,
  alternativePRs = false,
): Promise<string> {
  const checked = repositoryAddress(address.npub, address.identifier);
  const pubkey = new Uint8Array(
    checked.pubkey.match(/../g)!.map((x) => parseInt(x, 16)),
  );
  const id = UTF8.encode(checked.identifier);
  // Persisted v1 identity domains: never rename these with the project brand.
  const domain = UTF8.encode(
    alternativePRs
      ? "nostrwal/grasp/pr-repository\0"
      : "nostrwal/grasp/repository\0",
  );
  const data = new Uint8Array(
    domain.length + 1 + pubkey.length + 4 + id.length,
  );
  data.set(domain);
  let p = domain.length;
  data[p++] = 0;
  data.set(pubkey, p);
  p += pubkey.length;
  new DataView(data.buffer).setUint32(p, id.length);
  p += 4;
  data.set(id, p);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", data),
  );
  return `repos/${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}/`;
}
