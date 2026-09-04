import type { ObjectStore, StoredObject } from "./contracts.ts";

/** Test/local backend; each method is atomic within one JavaScript isolate. */
export class MemoryStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private generation = 0;

  async get(key: string): Promise<StoredObject | null> {
    const item = this.objects.get(key);
    return item ? { bytes: item.bytes.slice(), version: item.version } : null;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<boolean> {
    if ((this.objects.get(key)?.version ?? null) !== expectedVersion)
      return false;
    this.objects.set(key, {
      bytes: bytes.slice(),
      version: String(++this.generation),
    });
    return true;
  }
}
