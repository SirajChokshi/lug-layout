import type { KitIndexEntry } from "@brr/schema/world";

export class MemoryKits {
  private readonly stored = new Map<string, { kit: KitIndexEntry; archive: Uint8Array }>();

  async kits(): Promise<ReadonlyArray<KitIndexEntry>> {
    return [...this.stored.values()].map(({ kit }) => kit);
  }

  async kitArchive(id: string): Promise<Uint8Array | undefined> {
    return this.stored.get(id)?.archive;
  }

  async putKit(kit: KitIndexEntry, archive: Uint8Array): Promise<void> {
    this.stored.set(kit.id, { kit, archive });
  }

  async removeKit(id: string): Promise<void> {
    this.stored.delete(id);
  }
}
