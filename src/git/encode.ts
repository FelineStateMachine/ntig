import { zlibSync } from "fflate";
import { IntegrityError, LimitError } from "../contracts.ts";
import type { GitObject, GitObjectType } from "./pack.ts";
const TYPES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

/** Simple undeltified output; no server-side native Git subprocess. */
export async function encodePack(
  objects: readonly Pick<GitObject, "type" | "data">[],
): Promise<Uint8Array> {
  if (objects.length > 4096) throw new LimitError("Too many output objects");
  let inputBytes = 0;
  for (const object of objects) {
    if (!TYPES[object.type])
      throw new IntegrityError("Invalid Git object type");
    inputBytes += object.data.length;
    if (object.data.length > 4 * 1024 * 1024 || inputBytes > 16 * 1024 * 1024)
      throw new LimitError("Output object bytes exceed limit");
  }
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode("PACK"));
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, objects.length);
  const chunks = [head];
  for (const object of objects) {
    let size = object.data.length;
    let byte = (TYPES[object.type] << 4) | (size % 16);
    size = Math.floor(size / 16);
    const header: number[] = [byte | (size > 0 ? 128 : 0)];
    while (size > 0) {
      byte = size % 128;
      size = Math.floor(size / 128);
      header.push(byte | (size > 0 ? 128 : 0));
    }
    chunks.push(Uint8Array.from(header), zlibSync(object.data));
  }
  const body = concat(chunks);
  const checksum = new Uint8Array(
    await crypto.subtle.digest("SHA-1", body.buffer),
  );
  return concat([body, checksum]);
}
export function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    chunks.reduce((sum, item) => sum + item.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
